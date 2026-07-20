#!/usr/bin/env node
import { Command, Option } from 'commander';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
import { AgentCursor } from './lib/agent-cursor.js';
import { AgentClaude } from './lib/agent-claude.js';
import { parseTriageJson } from './lib/parse-triage-json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { version } = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
);

const ORCHESTRATOR_PATH = path.join(__dirname, '.orch');

if (!fs.existsSync(ORCHESTRATOR_PATH)) {
    fs.mkdirSync(ORCHESTRATOR_PATH);
}

function isBinaryOnPath(binary) {
    try {
        execFileSync('which', [binary], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function binaryMissingHint(agentName) {
    return agentName === 'claude'
        ? 'claude not found; install Claude Code or use --agent cursor'
        : 'agent not found; install Cursor Agent CLI or use --agent claude';
}

function ensureBinaryOnPath(binary, agentName) {
    if (!isBinaryOnPath(binary)) {
        console.error(binaryMissingHint(agentName));
        process.exit(1);
    }
}

async function runPipeline(prompt, options) {
    const verbose = Boolean(options.verbose);
    const AgentClass = options.agent === 'claude' ? AgentClaude : AgentCursor;
    const binary = options.agent === 'claude' ? 'claude' : 'agent';

    console.log(`cwd:   ${process.cwd()}`);
    console.log(`agent: ${options.agent}`);

    if (options.dryRun) {
        const ready = isBinaryOnPath(binary);
        console.log(ready ? 'pass' : 'fail');
        if (!ready) {
            console.error(binaryMissingHint(options.agent));
            process.exit(1);
        }
        return;
    }

    ensureBinaryOnPath(binary, options.agent);
    console.log();

    const triageAgent = new AgentClass(
        'triage',
        `
                You are a Triage Agent.

                Decide if the user's request is a safe minimal fix (typo, small flag tweak,
                implement an already-written local spec, one-file change, etc.).

                Your final message MUST be valid JSON only — no markdown, no prose outside JSON:

                {
                  "simple": true,
                  "why": "short reason",
                  "fix_plan": "optional short plan (1-5 bullets or a paragraph)"
                }

                Set "simple": true only when a quick fix in the current working tree is enough.
                Set "simple": false when research, planning, or a worktree is needed.
            `,
        prompt,
    );

    try {
        const triageResult = await triageAgent.run({ verbose });
        const parsed = parseTriageJson(triageResult.result);

        if (parsed?.simple === true) {
            const fixPlan = parsed.fix_plan
                ? `
                    [Triage Fix Plan]
                    ${parsed.fix_plan}
                    [/Triage Fix Plan]
                    `
                : '';

            const quickFixAgent = new AgentClass(
                'quick-fix',
                `
                        You are a Quick Fix Agent.

                        * Treat the user prompt as the full task description.
                        * Make the smallest set of edits necessary to complete the request.
                        * Apply changes in the current working tree.
                        * Do not write research.md or task.md.
                        * Do not create a git worktree.
                        ${fixPlan}
                    `,
                prompt,
            );

            await quickFixAgent.run({ verbose });
            return;
        }

        const researchAgent = new AgentClass(
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
        );

        const result = await researchAgent.run({ verbose });

        const plannerAgent = new AgentClass(
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
                `,
            prompt,
        );

        await plannerAgent.run({ verbose });

        const implementerAgent = new AgentClass(
            'implementer',
            `
                    You are a Implementer Agent.

                    * Do not procceed is this is not a git repository. Ask the user to initialize a git repository.
                    * Always spawn a new git worktree for the task.
                    * Create a status.md file in the <taskname> directory.
                    * Keep the status.md file updated with the status of the step.
                    * Read the task.md created in the previous step.
                    * Implement the steps to accomplish the user's request.
                    * Once all the steps are completed, the task is complete.
                `,
            prompt,
        );

        await implementerAgent.run({ verbose });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

const program = new Command();

program
    .name('orch')
    .version(version)
    .description('The Orchestrator')
    .argument('<task...>', 'Task description to use as the prompt (mention a file path and the agent will read it)')
    .option('-v, --verbose', 'Stream agent thinking/output deltas to stderr as the pipeline runs')
    .option('--dry-run', 'Check that the selected agent CLI is on PATH and exit; do not run the pipeline')
    .addOption(
        new Option('--agent <agent>', 'Agent backend to run the pipeline with: "cursor" (Cursor Agent CLI) or "claude" (Claude Code CLI)')
            .choices(['cursor', 'claude'])
            .default('cursor'),
    )
    .addHelpText(
        'after',
        `
Examples:
  $ orch "fix the typo in the README" --agent claude
  $ orch "fix the bug described in task.md" --agent cursor -v
  $ orch "noop" --dry-run --agent cursor
`,
    )
    .action(async (task, options) => {
        const prompt = task.join(' ').trim();
        if (!prompt) {
            console.error('Error: task cannot be empty');
            process.exit(1);
        }
        await runPipeline(prompt, options);
    });

program.parse();
