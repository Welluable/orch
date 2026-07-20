import { spawn } from 'child_process';
import ora from 'ora';

export function formatToolStatus(event) {
    const name = event.name ?? event.tool_name ?? event.tool ?? 'tool';
    const args = event.arguments ?? event.input ?? {};

    switch (name) {
        case 'grep':
        case 'Grep':
            return `Searching: ${args.pattern ?? 'codebase'}…`;
        case 'read':
        case 'Read':
            return `Reading ${args.path ?? 'file'}…`;
        case 'write':
        case 'Write':
        case 'Edit':
            return `Writing ${args.path ?? 'file'}…`;
        case 'shell':
        case 'Shell':
        case 'Bash':
            return `Running: ${(args.command ?? '').slice(0, 60)}…`;
        default:
            return `Running ${name}…`;
    }
}

export class Agent {
    constructor(name, instructions, prompt) {
        this.name = name;
        this.instructions = instructions;
        this.prompt = prompt;
        this.process = null;
        this.spinner = null;
    }

    setStatus(text) {
        if (!this.spinner) return;
        this.spinner.text = `[${this.name}] ${text}`;
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
        const ok = !event.is_error;
        const durationMs = event.duration_ms;
        this.ok = ok;
        const msg = ok
            ? `[${this.name}] done in ${durationMs}ms`
            : `[${this.name}] failed in ${durationMs}ms`;
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

        const { command, args, options } = this.getSpawnConfig(promptToSend);
        this.process = spawn(command, args, options);

        this.spinner = ora({
            text: `[${this.name}] starting…`,
            isEnabled: process.stdout.isTTY,
        }).start();

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
                this.process = null;
                if (this.spinner?.isSpinning) {
                    this.spinner.fail(`[${this.name}] failed`);
                }
                finish(err);
            });

            this.process.on('close', (code) => {
                this.process = null;
                if (!settled) {
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
        proc.kill();
        await new Promise((resolve) => proc.once('close', resolve));
        this.process = null;
    }

    async restart() {
        this.stop();
        this.run();
    }
}
