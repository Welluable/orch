import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { isPidAlive } from './jobs.js';

const SCAFFOLD_PREREGISTER_TEXT = 'pre-register every shared registry, barrel, and route-table entry wired to stubs so they never need to touch those files.';

/** Absolute paths for a fan-out's on-disk state under `<cwd>/.orch/<parentSlug>/`. */
function fanoutPaths(cwd, parentSlug) {
    const dir = path.join(path.resolve(cwd), '.orch', parentSlug);
    return {
        dir,
        fanoutJsonPath: path.join(dir, 'fanout.json'),
        lockPath: path.join(dir, '.fanout.lock'),
    };
}

function atomicWriteJson(dir, filePath, data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
}

function sleepSync(ms) {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
}

/**
 * Acquires `.fanout.lock` via exclusive create, busy-waiting on contention.
 * A lock whose owner pid is no longer alive is treated as stale and removed.
 */
function acquireLock(lockPath, { timeoutMs = 5000, retryMs = 5 } = {}) {
    const start = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
            fs.closeSync(fd);
            return;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;

            let ownerPid = null;
            try {
                ownerPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
            } catch {
                // Lock file mid-write or briefly unreadable; treat as contention.
            }

            if (ownerPid != null && !isPidAlive(ownerPid)) {
                try {
                    fs.unlinkSync(lockPath);
                } catch {
                    // Another process may have removed it first; retry.
                }
                continue;
            }

            if (Date.now() - start > timeoutMs) {
                throw new Error(`patchWorker/patchIntegration: timed out waiting for lock ${lockPath}`);
            }
            sleepSync(retryMs);
        }
    }
}

/** Reads and parses `fanout.json`; `null` if missing; throws on invalid JSON. */
export function readFanout(cwd, parentSlug) {
    const { fanoutJsonPath } = fanoutPaths(cwd, parentSlug);
    let content;
    try {
        content = fs.readFileSync(fanoutJsonPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return JSON.parse(content);
}

/** Atomically (write-temp + rename) writes the full fan-out document. */
export function writeFanout(cwd, parentSlug, data) {
    const { dir, fanoutJsonPath } = fanoutPaths(cwd, parentSlug);
    atomicWriteJson(dir, fanoutJsonPath, data);
}

/**
 * Locks, re-reads the latest document, shallow-merges `patchFnOrObject` (an
 * object, or a `(currentWorker) => partialPatch` function) onto the matching
 * entry in `workers[]`, atomically writes the whole document back, unlocks,
 * and returns the updated full document.
 */
export function patchWorker(cwd, parentSlug, workerId, patchFnOrObject) {
    const { dir, fanoutJsonPath, lockPath } = fanoutPaths(cwd, parentSlug);
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lockPath);
    try {
        const current = readFanout(cwd, parentSlug);
        const workers = current.workers.map((worker) => {
            if (worker.id !== workerId) return worker;
            const patch = typeof patchFnOrObject === 'function' ? patchFnOrObject(worker) : patchFnOrObject;
            return { ...worker, ...patch };
        });
        const updated = { ...current, workers };
        atomicWriteJson(dir, fanoutJsonPath, updated);
        return updated;
    } finally {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Already gone; nothing to clean up.
        }
    }
}

/**
 * Same lock/read/merge/write/unlock shape as `patchWorker`, applied to the
 * top-level `integration` object.
 */
export function patchIntegration(cwd, parentSlug, patchFnOrObject) {
    const { dir, fanoutJsonPath, lockPath } = fanoutPaths(cwd, parentSlug);
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lockPath);
    try {
        const current = readFanout(cwd, parentSlug);
        const patch = typeof patchFnOrObject === 'function' ? patchFnOrObject(current.integration) : patchFnOrObject;
        const updated = { ...current, integration: { ...current.integration, ...patch } };
        atomicWriteJson(dir, fanoutJsonPath, updated);
        return updated;
    } finally {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Already gone; nothing to clean up.
        }
    }
}

function pathsOverlap(a, b) {
    if (a === b) return true;
    const aDir = a.endsWith('/') ? a : `${a}/`;
    const bDir = b.endsWith('/') ? b : `${b}/`;
    return b.startsWith(aDir) || a.startsWith(bDir);
}

function ownsOverlap(ownsA, ownsB) {
    for (const a of ownsA) {
        for (const b of ownsB) {
            if (pathsOverlap(a, b)) return true;
        }
    }
    return false;
}

function hasDependencyCycle(workers) {
    const byId = new Map(workers.map((w) => [w.id, w]));
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map(workers.map((w) => [w.id, WHITE]));

    function visit(id) {
        color.set(id, GRAY);
        const worker = byId.get(id);
        for (const dep of worker.dependsOn || []) {
            const depColor = color.get(dep);
            if (depColor === GRAY) return true;
            if (depColor === WHITE && visit(dep)) return true;
        }
        color.set(id, BLACK);
        return false;
    }

    for (const worker of workers) {
        if (color.get(worker.id) === WHITE && visit(worker.id)) return true;
    }
    return false;
}

/** Returns a violation list for a decomposition (empty array = valid). */
export function validateDecomposition(decomposition, { maxWorkers } = {}) {
    const violations = [];
    const workers = decomposition?.workers ?? [];

    if (workers.length < 2) {
        violations.push('fewer than two workers; not decomposable');
    }
    if (typeof maxWorkers === 'number' && workers.length > maxWorkers) {
        violations.push(`too many workers: ${workers.length} exceeds maxWorkers ${maxWorkers}`);
    }

    const ids = new Set(workers.map((w) => w.id));
    let hasUnknownDep = false;
    for (const worker of workers) {
        if (!worker.owns || worker.owns.length === 0) {
            violations.push(`worker ${worker.id} has no owns`);
        }
        if (!worker.area) {
            violations.push(`worker ${worker.id} has no area`);
        }
        for (const dep of worker.dependsOn || []) {
            if (!ids.has(dep)) {
                violations.push(`worker ${worker.id} depends on unknown id ${dep}`);
                hasUnknownDep = true;
            }
        }
    }

    const cyclic = !hasUnknownDep && hasDependencyCycle(workers);
    if (cyclic) {
        violations.push('dependsOn graph has a cycle');
    }

    if (!hasUnknownDep && !cyclic) {
        const layers = planLayers(workers);
        for (const layer of layers) {
            const layerWorkers = layer.map((id) => workers.find((w) => w.id === id));
            for (let i = 0; i < layerWorkers.length; i += 1) {
                for (let j = i + 1; j < layerWorkers.length; j += 1) {
                    if (ownsOverlap(layerWorkers[i].owns || [], layerWorkers[j].owns || [])) {
                        violations.push(
                            `workers ${layerWorkers[i].id} and ${layerWorkers[j].id} have overlapping owns in the same layer`,
                        );
                    }
                }
            }
        }
    }

    const scaffolds = workers.filter((w) => w.scaffold);
    if (scaffolds.length > 1) {
        violations.push('more than one worker marked scaffold');
    }
    for (const scaffold of scaffolds) {
        if (scaffold.dependsOn && scaffold.dependsOn.length > 0) {
            violations.push(`scaffold worker ${scaffold.id} has dependencies`);
        }
    }

    return violations;
}

/**
 * Topological layering over `dependsOn`: layer 0 is every worker with no
 * dependencies, each subsequent layer is workers whose deps are all already
 * placed. Preserves the input array's relative order within each layer.
 */
export function planLayers(workers) {
    const remaining = new Set(workers.map((w) => w.id));
    const done = new Set();
    const layers = [];

    while (remaining.size > 0) {
        const layer = [];
        for (const worker of workers) {
            if (!remaining.has(worker.id)) continue;
            const deps = worker.dependsOn || [];
            if (deps.every((dep) => done.has(dep))) {
                layer.push(worker.id);
            }
        }
        if (layer.length === 0) break;
        for (const id of layer) {
            remaining.delete(id);
            done.add(id);
        }
        layers.push(layer);
    }

    return layers;
}

/** Coordinator concurrency rule: layer size, capped when `maxConcurrency` is a number. */
export function chooseConcurrency({ layerSize, maxConcurrency }) {
    if (typeof maxConcurrency !== 'number') return layerSize;
    return Math.min(layerSize, maxConcurrency);
}

/** Thin per-worker prompt: subtask, area, sibling titles; no `owns`, no `boundaries.md`. */
export function buildWorkerEnvelope({ subtask, area, scaffold, siblingTitles }) {
    const siblings = (siblingTitles || []).join(', ');
    const lines = [
        subtask,
        '',
        `This is one worker in a parallel orch run. Sibling workers are handling: ${siblings}. Keep your changes within ${area} and do not refactor or reorganize anything outside it.`,
    ];
    lines.push(
        scaffold
            ? `Parallel workers will follow; ${SCAFFOLD_PREREGISTER_TEXT}`
            : 'Shared types, interfaces, and stubs already exist on your base commit — use them as they are rather than redefining them.',
    );
    return lines.join('\n');
}

/** Thin integration prompt: ordered branches, overlapping paths or "none"; no `owns`. */
export function buildIntegrationEnvelope({ task, branches, overlappingFiles }) {
    const branchList = (branches || []).join(', ');
    const overlapList = overlappingFiles && overlappingFiles.length > 0 ? overlappingFiles.join(', ') : 'none';
    return [
        `Combine the completed worker branches for "${task}" into one coherent branch and make the full test suite pass.`,
        '',
        `Branches to merge, in order: ${branchList}. Files more than one worker changed: ${overlapList}. Resolve merge fallout only — do not redesign or reimplement what the workers built. Shared types, interfaces, and stubs already exist on the base commit.`,
    ].join('\n');
}

function defaultExecFile(command, args, options = {}) {
    return nodeExecFileSync(command, args, { encoding: 'utf8', ...options });
}

/** Runs `git diff --name-only <base>..<branch>` and returns the parsed file-path array. */
export function recordChangedFiles({ repoRoot, base, branch, execFile = defaultExecFile }) {
    const output = execFile('git', ['-C', repoRoot, 'diff', '--name-only', `${base}..${branch}`]);
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * For every file appearing in ≥2 workers' `changedFiles`, appends that path
 * onto each of those workers' `overlaps` arrays (mutated in place) and
 * returns the deduped union of overlapping paths.
 */
export function detectOverlaps(workers) {
    const countByFile = new Map();
    for (const worker of workers) {
        for (const file of new Set(worker.changedFiles || [])) {
            countByFile.set(file, (countByFile.get(file) || 0) + 1);
        }
    }

    const union = [];
    for (const [file, count] of countByFile.entries()) {
        if (count >= 2) union.push(file);
    }

    for (const worker of workers) {
        const changed = new Set(worker.changedFiles || []);
        for (const file of union) {
            if (changed.has(file) && !worker.overlaps.includes(file)) {
                worker.overlaps.push(file);
            }
        }
    }

    return union;
}

/** Appends the pre-register wording to a scaffold worker's subtask if not already present. */
export function ensureScaffoldSubtask(text) {
    if (text && /pre-regist/i.test(text)) return text;
    return `${text} Pre-register shared registries, barrels, or route tables so parallel workers can fill in bodies without touching those files.`;
}
