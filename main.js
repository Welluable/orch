#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ORCHESTRATOR_PATH = path.join(__dirname, '.orch');

if (!fs.existsSync(ORCHESTRATOR_PATH)) {
    fs.mkdirSync(ORCHESTRATOR_PATH);
}

class Agent {
    constructor(name, instructions, prompt) {
        this.name = name;
        this.instructions = instructions;
        this.prompt = prompt;
        this.process = null;
    }

    async run() {
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
                    const event = JSON.parse(line);
    
                    switch (event.type) {
                        case 'system': {
                            console.log(`Agent Started`);
                            break;
                        }
                        case 'thinking': {
                            switch (event.subtype) {
                                case 'delta': {
                                    process.stdout.write(event.text);
                                    break;
                                }
                                case 'completed': {
                                    console.log(`\n\nAgent Thinking Completed \n\n`);
                                    break;
                                }
                            }
                        }
                        case 'tool_call': {
                            break;
                        }
                        case 'assistant': {
                            break;
                        }
                        case 'result': {
                            this.ok = !event.is_error;
                            console.log(`\n\n${event.result}`);
                            console.log(`[${this.name}] finished in ${event.duration_ms}ms`);
                            finish(null, { ok: this.ok, result: event.result, durationMs: event.duration_ms });
                            break;
                        }
                    }
                })
            })

            this.process.on('error', (err) => {
                this.process = null;
                finish(err);
            });

            this.process.on('close', (code) => {
                this.process = null;
                if (!settled) finish(new Error(`[${this.name}] exited ${code} before result`));
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
    .action(async options => {
        let prompt = '';

        if (options.file) {
            prompt = fs.readFileSync(options.file, 'utf8');
        } else if (options.text) {
            prompt = options.text;
        }

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
            const result = await researchAgent.run();

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

            const plannerResult = await plannerAgent.run();

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

            const ImplementerResult = await ImplementerAgent.run();

        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program.parse();
