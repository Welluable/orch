import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPidAlive } from './jobs.js';

const SLUG_SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FANOUT_FIELDS = ['dependsOn', 'owns', 'scaffold', 'area'];

/** Absolute paths for a seq run's on-disk state under `<cwd>/.orch/<parentSlug>/`. */
function seqPaths(cwd, parentSlug) {
    const dir = path.join(path.resolve(cwd), '.orch', parentSlug);
    return {
        dir,
        seqJsonPath: path.join(dir, 'seq.json'),
        lockPath: path.join(dir, '.seq.lock'),
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
 * Acquires `.seq.lock` via exclusive create, busy-waiting on contention.
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
                throw new Error(`patchUnit/patchTip: timed out waiting for lock ${lockPath}`);
            }
            sleepSync(retryMs);
        }
    }
}

function withSeqLock(cwd, parentSlug, fn) {
    const { dir, seqJsonPath, lockPath } = seqPaths(cwd, parentSlug);
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lockPath);
    try {
        return fn({ dir, seqJsonPath });
    } finally {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Already gone; nothing to clean up.
        }
    }
}

/** Reads and parses `seq.json`; `null` if missing; throws on invalid JSON. */
export function readSeq(cwd, parentSlug) {
    const { seqJsonPath } = seqPaths(cwd, parentSlug);
    let content;
    try {
        content = fs.readFileSync(seqJsonPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return JSON.parse(content);
}

/** Atomically (write-temp + rename) writes the full seq document. */
export function writeSeq(cwd, parentSlug, data) {
    const { dir, seqJsonPath } = seqPaths(cwd, parentSlug);
    atomicWriteJson(dir, seqJsonPath, data);
}

/**
 * Locks, re-reads the latest document, shallow-merges `patchFnOrObject` (an
 * object, or a `(currentUnit) => partialPatch` function) onto the matching
 * entry in `units[]`, atomically writes the whole document back, unlocks,
 * and returns the updated full document.
 */
export function patchUnit(cwd, parentSlug, unitId, patchFnOrObject) {
    return withSeqLock(cwd, parentSlug, ({ dir, seqJsonPath }) => {
        const current = readSeq(cwd, parentSlug);
        const units = current.units.map((unit) => {
            if (unit.id !== unitId) return unit;
            const patch = typeof patchFnOrObject === 'function' ? patchFnOrObject(unit) : patchFnOrObject;
            return { ...unit, ...patch };
        });
        const updated = { ...current, units };
        atomicWriteJson(dir, seqJsonPath, updated);
        return updated;
    });
}

/** Locks and sets top-level `tip`. */
export function patchTip(cwd, parentSlug, tipSha) {
    return withSeqLock(cwd, parentSlug, ({ dir, seqJsonPath }) => {
        const current = readSeq(cwd, parentSlug);
        const updated = { ...current, tip: tipSha };
        atomicWriteJson(dir, seqJsonPath, updated);
        return updated;
    });
}

/** Locks and pushes onto `adjustments[]` (creating the array if absent). */
export function appendAdjustment(cwd, parentSlug, entry) {
    return withSeqLock(cwd, parentSlug, ({ dir, seqJsonPath }) => {
        const current = readSeq(cwd, parentSlug);
        const adjustments = [...(current.adjustments ?? []), entry];
        const updated = { ...current, adjustments };
        atomicWriteJson(dir, seqJsonPath, updated);
        return updated;
    });
}

/** Returns a violation list for a seq decomposition (empty array = valid). */
export function validateSeqDecomposition(decomposition, { maxUnits } = {}) {
    const violations = [];
    const units = decomposition?.units ?? [];

    if (units.length < 2) {
        violations.push('fewer than two units; not decomposable');
    }
    if (typeof maxUnits === 'number' && units.length > maxUnits) {
        violations.push(`too many units: ${units.length} exceeds maxUnits ${maxUnits}`);
    }

    const seen = new Set();
    for (const unit of units) {
        const id = unit?.id;
        if (typeof id !== 'string' || !id.trim()) {
            violations.push('unit has empty id');
        } else if (!SLUG_SAFE_ID.test(id)) {
            violations.push(`unit id ${id} is not slug-safe`);
        } else if (seen.has(id)) {
            violations.push(`duplicate unit id ${id}`);
        } else {
            seen.add(id);
        }

        if (typeof unit?.title !== 'string' || !unit.title.trim()) {
            violations.push(`unit ${id ?? '?'} has empty title`);
        }
        if (typeof unit?.subtask !== 'string' || !unit.subtask.trim()) {
            violations.push(`unit ${id ?? '?'} has empty subtask`);
        }

        for (const field of FANOUT_FIELDS) {
            if (Object.hasOwn(unit, field)) {
                violations.push(`unit ${id ?? '?'} has fan-out field ${field}`);
            }
        }
    }

    return violations;
}

/** Thin per-unit prompt: id/title, original task fence, subtask; no backlog dump. */
export function buildUnitEnvelope({ id, title, subtask, originalTask }) {
    return [
        `You are unit ${id} (${title}) of a sequential orch run for:`,
        originalTask,
        '',
        'Your unit subtask:',
        subtask,
        '',
        'Work only on this unit. Do not implement later backlog items. Prior units',
        'may already be merged into the branch you are based on — inspect the tree',
        'and build on it.',
    ].join('\n');
}

function nextPendingIds(units, limit = 2) {
    return units.filter((u) => u.state === 'pending').slice(0, limit).map((u) => u.id);
}

/** Returns a violation list for an adjust result (empty array = valid). */
export function validateAdjustResult(result, { units, maxUnits } = {}) {
    const violations = [];
    const rewrites = Array.isArray(result?.rewrites) ? result.rewrites : null;
    const drops = Array.isArray(result?.drops) ? result.drops : null;

    if (!rewrites || !drops) {
        violations.push('adjust result must include rewrites[] and drops[]');
        return violations;
    }

    const byId = new Map((units || []).map((u) => [u.id, u]));
    const nextPending = nextPendingIds(units || [], 2);

    if (rewrites.length > 2) {
        violations.push('cannot rewrite more than the next two pending units');
    }

    // Rewrites must be a contiguous prefix of the next pending units (no skip-ahead).
    for (let i = 0; i < rewrites.length; i += 1) {
        const id = rewrites[i]?.id;
        if (typeof id !== 'string' || !byId.has(id)) {
            violations.push(`cannot invent new id ${id}`);
            continue;
        }
        const unit = byId.get(id);
        if (unit.state !== 'pending') {
            violations.push(`cannot rewrite ${unit.state} unit ${id}`);
            continue;
        }
        if (nextPending[i] !== id) {
            violations.push(`cannot rewrite non-next pending unit ${id}`);
        }
    }

    for (const id of drops) {
        if (typeof id !== 'string' || !byId.has(id)) {
            violations.push(`cannot invent new id ${id}`);
            continue;
        }
        const unit = byId.get(id);
        if (unit.state !== 'pending') {
            violations.push(`cannot drop ${unit.state} unit ${id}`);
        }
    }

    if (typeof maxUnits === 'number' && (units || []).length > maxUnits) {
        violations.push(`total units ${(units || []).length} exceeds maxUnits ${maxUnits}`);
    }

    return violations;
}

/** Applies rewrites/drops to a cloned seq document; does not mutate input. */
export function applyAdjustResult(seqDoc, result) {
    const units = seqDoc.units.map((unit) => {
        const rewrite = (result.rewrites || []).find((r) => r.id === unit.id);
        let next = unit;
        if (rewrite) {
            next = { ...next };
            if (rewrite.title != null) next.title = rewrite.title;
            if (rewrite.subtask != null) next.subtask = rewrite.subtask;
        }
        if ((result.drops || []).includes(unit.id)) {
            next = { ...next, state: 'skipped' };
        }
        return next;
    });
    return { ...seqDoc, units };
}
