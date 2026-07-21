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

export async function runPipeline(prompt, options) {
    const verbose = Boolean(options.verbose);
    const AgentClass = options.AgentClass ?? (options.agent === 'claude' ? AgentClaude : AgentCursor);
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

    if (!options.AgentClass) {
        ensureBinaryOnPath(binary, options.agent);
    }
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

        const testWriter = new AgentClass(
            'test-writer',
            `
                    You are a Test Writer Agent.

                    * Do not procceed is this is not a git repository. Ask the user to initialize a git repository.
                    * Always spawn a new git worktree for the task.
                    * Create a status.md file in the <taskname> directory; record the worktree path in it.
                    * Read the task.md created in the previous step.
                    * Before making any production-code changes, decide how to verify the work:
                      - If automated tests are practical, write the relevant test cases/files first,
                        extending the existing test runner and conventions.
                      - If automated tests are not practical, write a "## Verification" section in
                        status.md describing what a human or later reviewer should check in the diff.
                        Do not invent a fake test harness.
                    * Do not implement the feature/fix itself in this stage — tests and criteria only
                      (plus worktree / status scaffolding).
                    * Your final message must include the worktree path (and test file paths / run
                      command, if applicable) so it can be handed to the next stage.
                `,
            prompt,
        );

        const testOut = await testWriter.run({ verbose });
        if (!testOut.ok) {
            throw new Error('test-writer failed; stopping before code-writer');
        }

        const codeWriter = new AgentClass(
            'code-writer',
            `
                    You are a Code Writer Agent.

                    * Read the task.md and the current status.md.
                    * Reuse the existing worktree created by the test-writer — do not create a
                      second one.
                    * Implement the steps in task.md.
                    * Keep status.md updated as steps complete.
                    * If tests were added or already exist, run them and record the results (pass or
                      fail) in status.md. Do not fix failures beyond this stage — finish regardless
                      of failure.
                    * If only verification criteria exist, implement so those criteria are met, and
                      note that in status.md.
                    * Do not delete or weaken tests just to force a green run.
                    * Once implementation is done, the task is complete.

                    [Test Writer Output]
                    ${testOut.result}
                    [/Test Writer Output]
                `,
            prompt,
        );

        await codeWriter.run({ verbose });
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

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === __filename) {
    program.parse();
}
