import { spawn } from 'child_process';
import path from 'path';
import ora from 'ora';
import { formatActiveTools, formatElapsed, formatToolHistory } from './tool-status.js';

export { formatElapsed };

/**
 * Every child process spawned by an agent, tracked so we can reap them all
 * when the orchestrator is interrupted (Ctrl+C) or otherwise exits.
 */
const liveChildren = new Set();

/**
 * Terminate a child and everything it spawned. Children are launched
 * `detached`, so each is its own process-group leader and `-pid` targets the
 * whole group (agent CLI + any grandchildren). Falls back to killing just the
 * child if the group is already gone.
 */
function killChildGroup(child, signal) {
    try {
        process.kill(-child.pid, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // already dead
        }
    }
}

let shuttingDown = false;

/** Conventional shell status: 128 + signal number. */
export function exitCodeForSignal(signal) {
    if (signal === 'SIGINT') return 130;
    if (signal === 'SIGHUP') return 129;
    return 143; // SIGTERM (and any other mapped interrupt)
}

/**
 * Reap every tracked child group, then exit. `exit` is injectable so tests can
 * assert without tearing down the runner.
 */
export function shutdown(signal, { exit = (code) => process.exit(code) } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const child of liveChildren) killChildGroup(child, 'SIGTERM');

    const exitCode = exitCodeForSignal(signal);

    let poll;
    // …or force-kill any stragglers after a short grace period.
    const forceKill = setTimeout(() => {
        clearInterval(poll);
        for (const child of liveChildren) killChildGroup(child, 'SIGKILL');
        exit(exitCode);
    }, 2000);
    forceKill.unref();

    // Exit as soon as every child is gone…
    poll = setInterval(() => {
        if (liveChildren.size === 0) {
            clearInterval(poll);
            clearTimeout(forceKill);
            exit(exitCode);
        }
    }, 50);
}

/** Track a child the way Agent.run does — for interrupt/reap tests. */
export function trackLiveChild(child) {
    liveChildren.add(child);
    child.once('close', () => liveChildren.delete(child));
    child.once('error', () => liveChildren.delete(child));
}

/** Reset shutdown latch + child set between tests. */
export function resetShutdownState() {
    shuttingDown = false;
    liveChildren.clear();
}

/**
 * Tracks whether the `model:` banner line has been printed yet. A shared,
 * mutable object (rather than a plain flag) so tests can reset it between cases.
 */
export const modelPrintState = { printed: false };

/**
 * If `event` is the first `system`/`init` stream event carrying a `model`,
 * print an aligned `model: <event.model>` line (pausing/resuming `spinner` so
 * ora doesn't garble it) and latch `modelPrintState.printed`. No-op otherwise,
 * including on every event after the first one printed.
 */
export function maybePrintModelLine(event, spinner) {
    if (
        modelPrintState.printed ||
        event.type !== 'system' ||
        event.subtype !== 'init' ||
        typeof event.model !== 'string' ||
        !event.model
    ) {
        return;
    }
    modelPrintState.printed = true;
    const wasSpinning = spinner?.isSpinning;
    if (wasSpinning) spinner.stop();
    console.log(`model: ${event.model}`);
    if (wasSpinning) spinner.start();
}

let handlersRegistered = false;

function registerShutdownHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGHUP', () => shutdown('SIGHUP'));
    // Last-resort reap on any exit path we didn't handle explicitly.
    process.on('exit', () => {
        for (const child of liveChildren) killChildGroup(child, 'SIGKILL');
    });
}

export class Agent {
    constructor(name, instructions, prompt, { cwd } = {}) {
        this.name = name;
        this.instructions = instructions;
        this.prompt = prompt;
        this.cwd = cwd ? path.resolve(cwd) : process.cwd();
        this.process = null;
        this.spinner = null;
        this.startedAt = 0;
        this.statusText = '';
        this.elapsedTimer = null;
        /** @type {Map<string, { name: string, args: Record<string, unknown>, startedAt: number }>} */
        this.activeTools = new Map();
        /** @type {Array<{ kind: 'tool', name: string, args: Record<string, unknown>, durationMs: number } | { kind: 'thinking', durationMs: number }>} */
        this.historyEntries = [];
        this.thinkingStartedAt = null;
    }

    setStatus(text) {
        this.statusText = text;
        this.refreshSpinnerText();
    }

    /** @param {{ name: string, args: Record<string, unknown>, phase: 'started'|'completed', callId: string }} toolEvent */
    onToolEvent({ name, args, phase, callId }) {
        if (phase === 'started') {
            this.activeTools.set(callId, { name, args, startedAt: Date.now() });
        } else if (phase === 'completed') {
            const active = this.activeTools.get(callId);
            if (active) {
                const durationMs = Date.now() - active.startedAt;
                this.historyEntries.push({ kind: 'tool', name: active.name, args: active.args, durationMs });
            }
            this.activeTools.delete(callId);
        }
        this.refreshToolStatus();
    }

    /** Start a thinking span, unless one is already open (idempotent). */
    startThinking() {
        if (this.thinkingStartedAt != null) return;
        this.thinkingStartedAt = Date.now();
    }

    /** End the open thinking span, if any, and record a history entry for it. */
    endThinking() {
        if (this.thinkingStartedAt == null) return;
        const durationMs = Date.now() - this.thinkingStartedAt;
        this.historyEntries.push({ kind: 'thinking', durationMs });
        this.thinkingStartedAt = null;
    }

    /** Print the buffered history trail, one indented line per entry (TTY only). */
    printHistory() {
        if (!process.stdout.isTTY) return;
        for (const entry of this.historyEntries) {
            const line =
                entry.kind === 'thinking'
                    ? `Thought for ${formatElapsed(entry.durationMs)}`
                    : formatToolHistory(entry, { durationMs: entry.durationMs });
            console.log(`  ${line}`);
        }
    }

    refreshToolStatus() {
        if (this.activeTools.size === 0) {
            this.setStatus('working…');
            return;
        }
        this.setStatus(formatActiveTools(this.activeTools));
    }

    refreshSpinnerText() {
        if (!this.spinner) return;
        const elapsed = formatElapsed(Date.now() - this.startedAt);
        this.spinner.text = `[${this.name}] ${this.statusText} · ${elapsed}`;
    }

    startElapsedTimer() {
        this.stopElapsedTimer();
        if (!process.stdout.isTTY) return;
        this.elapsedTimer = setInterval(() => this.refreshSpinnerText(), 1000);
    }

    stopElapsedTimer() {
        if (this.elapsedTimer != null) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
    }

    /** @returns {{ command: string, args: string[], options: object }} */
    getSpawnConfig(_promptToSend) {
        throw new Error('getSpawnConfig must be implemented by subclass');
    }

    /**
     * @param {object} event
     * @param {{ verbose: boolean, finish: (err: Error|null, value?: object) => void }} ctx
     */
    handleStreamEvent(_event, _ctx) {
        throw new Error('handleStreamEvent must be implemented by subclass');
    }

    settleResult(event, finish) {
        this.stopElapsedTimer();
        this.activeTools.clear();
        const ok = !event.is_error;
        const durationMs = event.duration_ms;
        this.ok = ok;
        const elapsed = formatElapsed(Date.now() - this.startedAt);
        const msg = ok
            ? `[${this.name}] done in ${elapsed}`
            : `[${this.name}] failed in ${elapsed}`;
        if (ok) this.spinner.succeed(msg);
        else this.spinner.fail(msg);
        this.printHistory();
        this.historyEntries = [];
        this.thinkingStartedAt = null;
        finish(null, { ok, result: event.result, durationMs });
    }

    async run({ verbose = false } = {}) {
        const promptToSend = `
            [SYSTEM INSTRUCTIONS]
            ${this.instructions}
            [/SYSTEM INSTRUCTIONS]

            [USER PROMPT]
            ${this.prompt}
            [/USER PROMPT]
        `;

        registerShutdownHandlers();

        const { command, args, options } = this.getSpawnConfig(promptToSend);
        // `detached` makes the child its own process-group leader so we can kill
        // it and any grandchildren it spawns as a group on shutdown.
        this.process = spawn(command, args, { ...options, detached: true });
        const child = this.process;
        liveChildren.add(child);

        this.startedAt = Date.now();
        this.statusText = 'starting…';
        // discardStdin: false keeps stdin cooked so Ctrl+C delivers a real SIGINT
        // (ora's default raw-mode discarder swallows it in some IDEs / PTYs).
        this.spinner = ora({
            text: `[${this.name}] starting…`,
            isEnabled: process.stdout.isTTY,
            discardStdin: false,
        }).start();
        this.refreshSpinnerText();
        this.startElapsedTimer();

        let buf = '';
        let settled = false;

        return new Promise((resolve, reject) => {
            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve(value);
            };

            this.process.stdout.on('data', (chunk) => {
                buf += chunk;
                const lines = buf.split('\n');
                buf = lines.pop();

                lines.forEach((line) => {
                    if (!line.trim()) return;

                    let event;
                    try {
                        event = JSON.parse(line);
                    } catch {
                        return;
                    }

                    if (process.env.ORCH_DEBUG) {
                        process.stderr.write(JSON.stringify(event) + '\n');
                    }

                    maybePrintModelLine(event, this.spinner);

                    this.handleStreamEvent(event, { verbose, finish });
                });
            });

            this.process.on('error', (err) => {
                liveChildren.delete(child);
                this.process = null;
                this.stopElapsedTimer();
                if (this.spinner?.isSpinning) {
                    this.spinner.fail(`[${this.name}] failed`);
                }
                finish(err);
            });

            this.process.on('close', (code) => {
                liveChildren.delete(child);
                this.process = null;
                if (!settled) {
                    this.stopElapsedTimer();
                    if (this.spinner?.isSpinning) {
                        this.spinner.fail(`[${this.name}] exited ${code}`);
                    }
                    finish(new Error(`[${this.name}] exited ${code} before result`));
                }
            });
        });
    }

    async stop() {
        if (!this.process) return;
        const proc = this.process;
        killChildGroup(proc, 'SIGTERM');
        await new Promise((resolve) => proc.once('close', resolve));
        liveChildren.delete(proc);
        this.process = null;
    }

    async restart() {
        this.stop();
        this.run();
    }
}
