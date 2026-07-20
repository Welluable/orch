import { spawn } from 'child_process';
import ora from 'ora';
import { formatActiveTools } from './tool-status.js';

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

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const child of liveChildren) killChildGroup(child, 'SIGTERM');

    // SIGINT -> 130, SIGTERM -> 143 (128 + signal number), matching shell convention.
    const exitCode = signal === 'SIGINT' ? 130 : 143;

    // Exit as soon as every child is gone…
    const poll = setInterval(() => {
        if (liveChildren.size === 0) {
            clearInterval(poll);
            process.exit(exitCode);
        }
    }, 50);

    // …or force-kill any stragglers after a short grace period.
    setTimeout(() => {
        clearInterval(poll);
        for (const child of liveChildren) killChildGroup(child, 'SIGKILL');
        process.exit(exitCode);
    }, 2000).unref();
}

let handlersRegistered = false;

function registerShutdownHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    // Last-resort reap on any exit path we didn't handle explicitly.
    process.on('exit', () => {
        for (const child of liveChildren) killChildGroup(child, 'SIGKILL');
    });
}

/** Format milliseconds as `{s}s` or `{m}m {s}s` (whole seconds, no leading 0m). */
export function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export class Agent {
    constructor(name, instructions, prompt) {
        this.name = name;
        this.instructions = instructions;
        this.prompt = prompt;
        this.process = null;
        this.spinner = null;
        this.startedAt = 0;
        this.statusText = '';
        this.elapsedTimer = null;
        /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
        this.activeTools = new Map();
    }

    setStatus(text) {
        this.statusText = text;
        this.refreshSpinnerText();
    }

    /** @param {{ name: string, args: Record<string, unknown>, phase: 'started'|'completed', callId: string }} toolEvent */
    onToolEvent({ name, args, phase, callId }) {
        if (phase === 'started') {
            this.activeTools.set(callId, { name, args });
        } else if (phase === 'completed') {
            this.activeTools.delete(callId);
        }
        this.refreshToolStatus();
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
        this.spinner = ora({
            text: `[${this.name}] starting…`,
            isEnabled: process.stdout.isTTY,
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
