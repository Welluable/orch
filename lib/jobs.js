import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    appendFailureLog,
    failureLogPointer,
    formatFailureSection,
} from './failure-log.js';
import { getNotifyEnabled, notifyJob as defaultNotifyJob } from './notify.js';

const ACTIVE_LIVE_STATES = ['running', 'pausing', 'paused'];
const TERMINAL_STATES = ['done', 'failed', 'stopped', 'crashed'];

/** Injectable notify hook for tests; default is `notifyJob` from lib/notify.js. */
let notifyJobHook = defaultNotifyJob;

/** Override the notify helper used on terminal state transitions (tests). */
export function setNotifyJob(fn) {
    notifyJobHook = typeof fn === 'function' ? fn : defaultNotifyJob;
}

/** Restore the default notify hook. */
export function resetNotifyHooks() {
    notifyJobHook = defaultNotifyJob;
}

function maybeNotifyTerminalTransition(previousState, updated) {
    if (!getNotifyEnabled()) return;
    if (!TERMINAL_STATES.includes(updated.state)) return;
    if (TERMINAL_STATES.includes(previousState)) return;
    try {
        notifyJobHook({
            slug: updated.slug,
            state: updated.state,
            task: updated.task,
            enabled: true,
        });
    } catch {
        // Notification failures must never affect job writes.
    }
}

/**
 * Compact outcome written onto `run.json` with every terminal state transition.
 * Shared so all call sites (pipelines, shutdown, reconcile) keep one shape.
 */
export function buildLastOutcome({
    state,
    phase = null,
    stage = null,
    round = null,
    exitCode = null,
    finishedAt,
    task = null,
    summary = '',
    error = null,
}) {
    return {
        state,
        phase: phase ?? null,
        stage: stage ?? null,
        round: round ?? null,
        exitCode: exitCode ?? null,
        finishedAt,
        task: task ?? null,
        summary: summary ?? '',
        error: error ?? null,
    };
}

/** Absolute paths for a job's on-disk artifacts under `<cwd>/.orch/<slug>/`. */
export function jobPaths(cwd, slug) {
    const dir = path.join(path.resolve(cwd), '.orch', slug);
    return {
        dir,
        runJsonPath: path.join(dir, 'run.json'),
        lockPath: path.join(dir, '.run.lock'),
        logPath: path.join(dir, 'orch.log'),
        failureLogPath: path.join(dir, 'failure.log'),
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

/** Atomically (write-temp + rename) writes a job record to `run.json`. */
export function writeJob(cwd, slug, record) {
    const { dir, runJsonPath } = jobPaths(cwd, slug);
    atomicWriteJson(dir, runJsonPath, record);
}

/** Reads and parses `run.json`; `null` if missing; throws on invalid JSON. */
export function readJob(cwd, slug) {
    const { runJsonPath } = jobPaths(cwd, slug);
    let content;
    try {
        content = fs.readFileSync(runJsonPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return JSON.parse(content);
}

/** `process.kill(pid, 0)` wrapped in try/catch; never throws. */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function sleepSync(ms) {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires `.run.lock` via exclusive create, busy-waiting on contention.
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
                throw new Error(`patchJob: timed out waiting for lock ${lockPath}`);
            }
            sleepSync(retryMs);
        }
    }
}

/**
 * Locks, re-reads, shallow-merges `patchFnOrObject` (an object, or a
 * `(current) => partialPatch` function) over the latest record, atomically
 * writes, unlocks, and returns the updated record.
 */
export function patchJob(cwd, slug, patchFnOrObject) {
    const { dir, runJsonPath, lockPath } = jobPaths(cwd, slug);
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lockPath);
    try {
        const current = readJob(cwd, slug) ?? {};
        const previousState = current.state;
        const patch = typeof patchFnOrObject === 'function' ? patchFnOrObject(current) : patchFnOrObject;
        const updated = { ...current, ...patch };
        if (updated.slug == null) updated.slug = slug;
        atomicWriteJson(dir, runJsonPath, updated);
        maybeNotifyTerminalTransition(previousState, updated);
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
 * If `record` is in an active live state (running/pausing/paused) and its
 * pid is dead, atomically rewrites it to `crashed` and returns the updated
 * record. Otherwise returns `record` unchanged.
 */
export function reconcileJob(cwd, slug, record) {
    if (!ACTIVE_LIVE_STATES.includes(record.state)) return record;
    if (isPidAlive(record.pid)) return record;
    return patchJob(cwd, slug, (current) => {
        const finishedAt = new Date().toISOString();
        const { failureLogPath } = jobPaths(cwd, slug);
        // Header-only: out-of-process crash has no in-memory stage buffer.
        appendFailureLog(
            failureLogPath,
            formatFailureSection({
                slug,
                state: 'crashed',
                phase: current.phase,
                stage: current.stage,
                round: current.round,
                exitCode: null,
                finishedAt,
                task: current.task,
                error: 'process died',
                stageVerbose: '',
                priorStages: [],
            }),
        );
        return {
            state: 'crashed',
            finishedAt,
            exitCode: null,
            failureLogPath,
            lastOutcome: buildLastOutcome({
                state: 'crashed',
                phase: current.phase,
                stage: current.stage,
                round: current.round,
                exitCode: null,
                finishedAt,
                task: current.task,
                summary: '',
                error: failureLogPointer(slug),
            }),
        };
    });
}

/**
 * Reopen an existing terminal job for `orch continue`. Patches in place —
 * never allocates a new slug/directory. Bumps `continuation`, appends
 * `continuations[]`, clears live `lastOutcome`, resets to running/research.
 */
export function reopenJob(cwd, slug, { task, agent, maxRounds, pid, prior, startedAt } = {}) {
    const existing = readJob(cwd, slug);
    if (!existing) throw new Error(`reopenJob: unknown job ${slug}`);

    const started = startedAt ?? new Date().toISOString();
    const continuation = (existing.continuation ?? 1) + 1;
    const continuations = Array.isArray(existing.continuations)
        ? [...existing.continuations]
        : [];
    continuations.push({ n: continuation, task, startedAt: started, prior: prior ?? null });

    return patchJob(cwd, slug, {
        task,
        agent,
        maxRounds,
        pid,
        startedAt: started,
        state: 'running',
        phase: 'research',
        stage: null,
        round: null,
        finishedAt: null,
        exitCode: null,
        pauseRequested: false,
        lastOutcome: null,
        continuation,
        continuations,
    });
}

/** Every `run.json` under `<cwd>/.orch/*`, reconciled, most-recent-first by `startedAt`. */
export function listJobs(cwd) {
    const orchDir = path.join(path.resolve(cwd), '.orch');
    if (!fs.existsSync(orchDir)) return [];

    const slugs = fs.readdirSync(orchDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    const jobs = [];
    for (const slug of slugs) {
        const record = readJob(cwd, slug);
        if (!record) continue;
        jobs.push(reconcileJob(cwd, slug, record));
    }

    jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return jobs;
}

/**
 * Cooperative pause point: no-op if `pauseRequested` is falsy. Otherwise
 * patches to `paused`, polls `run.json` (no lock/fd held) until
 * `pauseRequested` clears, then patches back to `running`.
 */
export async function checkpointPause(cwd, slug, { pollIntervalMs = 500 } = {}) {
    const record = readJob(cwd, slug);
    if (!record?.pauseRequested) return;

    patchJob(cwd, slug, { state: 'paused' });

    for (;;) {
        await sleep(pollIntervalMs);
        const current = readJob(cwd, slug);
        if (!current?.pauseRequested) break;
    }

    patchJob(cwd, slug, { state: 'running' });
}

/** The pure operation behind `orch pause <slug>`. */
export function requestPause(cwd, slug) {
    const record = readJob(cwd, slug);
    if (!record) throw new Error(`requestPause: unknown job ${slug}`);
    if (TERMINAL_STATES.includes(record.state)) {
        throw new Error(`requestPause: job ${slug} is in terminal state ${record.state}`);
    }
    if (record.state === 'pausing' || record.state === 'paused') return record;

    const patch = { pauseRequested: true };
    if (record.state === 'running') patch.state = 'pausing';
    return patchJob(cwd, slug, patch);
}

/** The pure operation behind `orch resume <slug>`. */
export function requestResume(cwd, slug) {
    const record = readJob(cwd, slug);
    if (!record) throw new Error(`requestResume: unknown job ${slug}`);
    if (TERMINAL_STATES.includes(record.state)) {
        throw new Error(`requestResume: job ${slug} is in terminal state ${record.state}`);
    }
    return patchJob(cwd, slug, { pauseRequested: false, state: 'running' });
}

/**
 * The pure operation behind `orch stop <slug>`: signals a live pid (leaving
 * the eventual `stopped` write to the child's own `shutdown()`), or
 * reconciles a dead one to `crashed`. `kill` is injectable for tests.
 */
export function stopJob(cwd, slug, { kill = (pid, signal) => process.kill(pid, signal) } = {}) {
    const record = readJob(cwd, slug);
    if (!record) throw new Error(`stopJob: unknown job ${slug}`);

    if (TERMINAL_STATES.includes(record.state)) {
        return { action: 'already-terminal', record };
    }

    if (isPidAlive(record.pid)) {
        kill(record.pid, 'SIGTERM');
        return { action: 'signaled', record };
    }

    const reconciled = reconcileJob(cwd, slug, record);
    if (reconciled.state === 'crashed' && record.state !== 'crashed') {
        return { action: 'crashed', record: reconciled };
    }
    return { action: 'already-terminal', record: reconciled };
}

const LIVE_PAUSE_STATES = ['running', 'pausing', 'paused'];

/**
 * Parent → children pause: `requestPause` on the parent, then the same pause
 * write on every child with `parent === parentSlug` in a live pause state.
 * Returns how many children were cascade-targeted (CLI prints this count).
 */
export function cascadePause(cwd, parentSlug) {
    requestPause(cwd, parentSlug);
    let childrenSignaled = 0;
    for (const job of listJobs(cwd)) {
        if (job.parent !== parentSlug) continue;
        if (!LIVE_PAUSE_STATES.includes(job.state)) continue;
        requestPause(cwd, job.slug);
        childrenSignaled += 1;
    }
    return { childrenSignaled };
}

/**
 * Parent → children resume: `requestResume` on the parent, then cascade
 * resume only to non-terminal children that are `paused`/`pausing`.
 */
export function cascadeResume(cwd, parentSlug) {
    requestResume(cwd, parentSlug);
    let childrenSignaled = 0;
    for (const job of listJobs(cwd)) {
        if (job.parent !== parentSlug) continue;
        if (job.state !== 'paused' && job.state !== 'pausing') continue;
        requestResume(cwd, job.slug);
        childrenSignaled += 1;
    }
    return { childrenSignaled };
}

/**
 * The pure operation behind `orch jobs clean`: removes every entry under
 * `<cwd>/.orch/`. Returns the names that were deleted (empty if `.orch`
 * is missing or already empty).
 */
export function cleanJobs(cwd) {
    const orchDir = path.join(path.resolve(cwd), '.orch');
    if (!fs.existsSync(orchDir)) return [];

    const names = fs.readdirSync(orchDir);
    for (const name of names) {
        fs.rmSync(path.join(orchDir, name), { recursive: true, force: true });
    }
    return names;
}
