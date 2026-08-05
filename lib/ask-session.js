import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPidAlive } from './jobs.js';

/**
 * Ask-session transcript store under `.orch/<slug>/ask.json`.
 *
 * Persists read-only `--ask` Q&A turns (plus slug metadata) beside `run.json`
 * so a later unit can continue the same session without write pipelines.
 * `run.json` stays lifecycle-only — never embed turns there.
 *
 * Failed asks: callers must not invent a successful assistant turn. Prefer
 * leaving `ask.json` absent/unchanged on failure (only invoke
 * `recordAskExchange` after a successful answer).
 */

/** Absolute paths for an ask session under `<cwd>/.orch/<slug>/`. */
export function askSessionPaths(cwd, slug) {
    const dir = path.join(path.resolve(cwd), '.orch', slug);
    return {
        dir,
        askJsonPath: path.join(dir, 'ask.json'),
        lockPath: path.join(dir, '.ask.lock'),
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
 * Acquires `.ask.lock` via exclusive create, busy-waiting on contention.
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
                throw new Error(`appendAskTurns: timed out waiting for lock ${lockPath}`);
            }
            sleepSync(retryMs);
        }
    }
}

function withAskLock(cwd, slug, fn) {
    const { dir, askJsonPath, lockPath } = askSessionPaths(cwd, slug);
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lockPath);
    try {
        return fn({ dir, askJsonPath });
    } finally {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Already gone; nothing to clean up.
        }
    }
}

/** Reads and parses `ask.json`; `null` if missing; throws on invalid JSON. */
export function readAskSession(cwd, slug) {
    const { askJsonPath } = askSessionPaths(cwd, slug);
    let content;
    try {
        content = fs.readFileSync(askJsonPath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    return JSON.parse(content);
}

/** Atomically (write-temp + rename) writes the full ask-session document. */
export function writeAskSession(cwd, slug, data) {
    const { dir, askJsonPath } = askSessionPaths(cwd, slug);
    atomicWriteJson(dir, askJsonPath, data);
}

/**
 * Locks, creates a minimal session on first write, appends `turns` in order,
 * bumps `updatedAt`, and returns the updated document.
 *
 * @param {{ agent?: string, turns: Array<{ role: string, content: string, at?: string }> }} opts
 */
export function appendAskTurns(cwd, slug, { agent, turns }) {
    return withAskLock(cwd, slug, ({ dir, askJsonPath }) => {
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        let current = readAskSession(cwd, slug);
        if (!current) {
            current = {
                slug,
                createdAt: now,
                updatedAt: now,
                turns: [],
            };
            if (agent != null) current.agent = agent;
        } else {
            if (agent != null) current.agent = agent;
            // ISO timestamps are ms-precision; two appends in the same ms must
            // still bump updatedAt so callers can detect a change.
            const prevMs = Date.parse(current.updatedAt);
            const nextMs =
                Number.isFinite(prevMs) && nowMs <= prevMs ? prevMs + 1 : nowMs;
            current.updatedAt = new Date(nextMs).toISOString();
        }
        const incoming = Array.isArray(turns) ? turns : [];
        current.turns = [...(current.turns ?? []), ...incoming];
        atomicWriteJson(dir, askJsonPath, current);
        return current;
    });
}

/**
 * Convenience for a successful `--ask`: one user turn (`prompt`) then one
 * assistant turn (`answer`). Callers must only invoke this on success —
 * never invent assistant content from a failed ask.
 *
 * @param {{ prompt: string, answer: string, agent?: string }} opts
 */
export function recordAskExchange(cwd, slug, { prompt, answer, agent }) {
    const at = new Date().toISOString();
    return appendAskTurns(cwd, slug, {
        agent,
        turns: [
            { role: 'user', content: prompt, at },
            { role: 'assistant', content: answer, at },
        ],
    });
}

/**
 * Fold prior ask-session turns into a single prompt string for a follow-up
 * `--ask --from` run. The agent still receives one prompt; orch persists only
 * the bare `followUp` via `recordAskExchange` on success.
 *
 * @param {Array<{ role?: string, content?: string }>} turns
 * @param {string} followUp
 */
export function buildAskFollowUpPrompt(turns, followUp) {
    const lines = ['Prior conversation:', ''];
    for (const turn of turns ?? []) {
        lines.push(`${turn.role ?? 'unknown'}: ${turn.content ?? ''}`);
        lines.push('');
    }
    lines.push('Follow-up question:');
    lines.push(followUp);
    return lines.join('\n');
}
