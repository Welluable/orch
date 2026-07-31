import { spawn as defaultSpawn } from 'node:child_process';

const TERMINAL_STATES = new Set(['done', 'failed', 'stopped', 'crashed']);

/** Process-level gate; default off so unit tests that patch jobs stay silent. */
let notifyEnabled = false;

/** Sets whether terminal job transitions should fire desktop notifications. */
export function setNotifyEnabled(enabled) {
    notifyEnabled = Boolean(enabled);
}

/** Current process-level notify gate. */
export function getNotifyEnabled() {
    return notifyEnabled;
}

function shortTask(task) {
    if (task == null) return '';
    const text = String(task).trim();
    if (!text) return '';
    if (text.length <= 80) return text;
    return `${text.slice(0, 80)}…`;
}

function buildBody(state, task) {
    const short = shortTask(task);
    return short ? `${state} — ${short}` : state;
}

/**
 * Fire-and-forget desktop notification for a terminal job state.
 * Inject `spawn` / `platform` in tests. Never throws.
 */
export function notifyJob({
    slug,
    state,
    task,
    enabled,
    spawn: spawnFn = defaultSpawn,
    platform = process.platform,
} = {}) {
    try {
        if (enabled === false) return;
        if (!TERMINAL_STATES.has(state)) return;

        const title = `orch · ${slug}`;
        const body = buildBody(state, task);

        if (platform === 'darwin') {
            const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
            const child = spawnFn('osascript', ['-e', script], {
                stdio: 'ignore',
                detached: true,
            });
            child.unref?.();
            return;
        }

        if (platform === 'linux') {
            const child = spawnFn('notify-send', ['--', title, body], {
                stdio: 'ignore',
                detached: true,
            });
            child.unref?.();
            return;
        }
    } catch {
        // Best-effort: never fatal.
    }
}
