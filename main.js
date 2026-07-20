#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import ora from 'ora';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ORCHESTRATOR_PATH = path.join(__dirname, '.orch');

if (!fs.existsSync(ORCHESTRATOR_PATH)) {
    fs.mkdirSync(ORCHESTRATOR_PATH);
}

function formatToolStatus(event) {
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
            return `Writing ${args.path ?? 'file'}…`;
        case 'shell':
        case 'Shell':
            return `Running: ${(args.command ?? '').slice(0, 60)}…`;
        default:
            return `Running ${name}…`;
    }
}

class Agent {
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

    async run({ verbose = false } = {}) {
        let promptToSend = `
            [SYSTEM INSTRUCTIONS]
            ${this.instructions}
            [/SYSTEM INSTRUCTIONS]

            [USER PROMPT]
            ${this.prompt}
            [/USER PROMPT]
        `


        this.process = spawn('agent', ['-p', '--force', '--output-format', 'stream-json', promptToSend], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });

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
            }

            this.process.stdout.on('data', (chunk) => {
                buf += chunk;
                const lines = buf.split('\n');
                buf = lines.pop();

                lines.forEach(line => {
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

                    switch (event.type) {
                        case 'system': {
                            this.setStatus('connected');
                            break;
                        }
                        case 'thinking': {
                            switch (event.subtype) {
                                case 'delta': {
                                    if (verbose) {
                                        process.stderr.write(event.text ?? '');
                                    } else {
                                        this.setStatus('thinking…');
                                    }
                                    break;
                                }
                                case 'completed': {
                                    break;
                                }
                            }
                            break;
                        }
                        case 'tool_call': {
                            this.setStatus(formatToolStatus(event));
                            break;
                        }
                        case 'assistant': {
                            this.setStatus('composing response…');
                            break;
                        }
                        case 'result': {
                            const ok = !event.is_error;
                            const durationMs = event.duration_ms;
                            this.ok = ok;
                            const msg = ok
                                ? `[${this.name}] done in ${durationMs}ms`
                                : `[${this.name}] failed in ${durationMs}ms`;
                            if (ok) this.spinner.succeed(msg);
                            else this.spinner.fail(msg);
                            finish(null, { ok, result: event.result, durationMs });
                            break;
                        }
                    }
                })
            })

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

const program = new Command();

program
    .version('0.0.1')
    .description('The Orchestrator');

program
    .command('run')
    .description('Run the Orchestrator')
    .option('-f, --file <file>', 'The task file to run')
    .option('-t, --text <text>', 'The text to run')
    .option('-v, --verbose', 'Stream thinking deltas to stderr')
    .action(async options => {
        let prompt = '';

        if (options.file) {
            prompt = fs.readFileSync(options.file, 'utf8');
        } else if (options.text) {
            prompt = options.text;
        }

        const verbose = Boolean(options.verbose);

        const researchAgent = new Agent(
            'research',
            `
                You are a Research Agent.

                * If a research doc exist skip and return that path.
                * Research the codebase for the relevent information to accomplish the user's request.
                * Don't plan just research.
                * Do not write any code, after the research is complete, write a ${path.join(ORCHESTRATOR_PATH, 'research')}/<taskname>/research.md file with the research.
                * Last message should be the path of the research.md file.
            `,
            prompt,
        )

        try {
            const result = await researchAgent.run({ verbose });

            const plannerAgent = new Agent(
                'planner',
                `
                    You are a Planner Agent.
    
                    * If a plan doc exist skip and return that path.
                    * Read the research.md created in the previous step.
                    * Plan the steps to accomplish the user's request.
                    * Create a task.md file in the <taskname> directory.
                    * task.md should have checklist of the steps to accomplish the user's request.
                    

                    [Research Agent Output]
                    ${result.result}
                    [/Research Agent Output]
                `
            );

            const plannerResult = await plannerAgent.run({ verbose });

            const ImplementerAgent = new Agent(
                'Implementer',
                `
                    You are a Implementer Agent.

                    * Do not procceed is this is not a git repository. Ask the user to initialize a git repository.
                    * Always spawn a new git worktree for the task.
                    * Create a status.md file in the <taskname> directory.
                    * Keep the status.md file updated with the status of the step.
                    * Read the task.md created in the previous step.
                    * Implement the steps to accomplish the user's request.
                    * Once all the steps are completed, the task is complete.
                `
            );

            const ImplementerResult = await ImplementerAgent.run({ verbose });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program.parse();
