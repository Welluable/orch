#!/usr/bin/env node
import { Command, Option } from 'commander';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
import { AgentCursor } from './lib/agent-cursor.js';
import { AgentClaude } from './lib/agent-claude.js';
import { AgentAgn } from './lib/agent-agn.js';
import { parseTriageJson } from './lib/parse-triage-json.js';
import { createRunContext } from './lib/run-context.js';
import { createWorktree } from './lib/worktree.js';
import { commitWorktree } from './lib/commit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { version } = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'),
);

const AGENT_BACKENDS = {
    cursor: {
        AgentClass: AgentCursor,
        binary: 'agent',
        missingHint: 'agent not found; install Cursor Agent CLI or use --agent claude',
    },
    claude: {
        AgentClass: AgentClaude,
        binary: 'claude',
        missingHint: 'claude not found; install Claude Code or use --agent cursor',
    },
    agn: {
        AgentClass: AgentAgn,
        binary: 'agn',
        missingHint: 'agn not found; run npm install -g @welluable/agn-cli or use --agent cursor',
    },
};

function isBinaryOnPath(binary) {
    try {
        execFileSync('which', [binary], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function binaryMissingHint(agentName) {
    const backend = AGENT_BACKENDS[agentName];
    if (!backend) throw new Error(`Unknown agent backend: ${agentName}`);
    return backend.missingHint;
}

function ensureBinaryOnPath(binary, agentName) {
    if (!isBinaryOnPath(binary)) {
        console.error(binaryMissingHint(agentName));
        process.exit(1);
    }
}

export async function runPipeline(prompt, options) {
    const verbose = Boolean(options.verbose);
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const binary = backend.binary;
    const createRunContextFn = options.createRunContext ?? createRunContext;
    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const invocationCwd = process.cwd();

    console.log(`cwd:   ${invocationCwd}`);
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
        { cwd: invocationCwd },
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
                { cwd: invocationCwd },
            );

            await quickFixAgent.run({ verbose });
            return;
        }

        const runContext = createRunContextFn({ cwd: invocationCwd });

        const researchAgent = new AgentClass(
            'research',
            `
                    You are a Research Agent.

                    * Research the codebase rooted at ${invocationCwd} for the relevant
                      information to accomplish the user's request.
                    * Don't plan just research.
                    * Do not write any code. After the research is complete, write your
                      findings only to the exact path: ${runContext.researchPath}
                    * Last message should be the exact path: ${runContext.researchPath}
                `,
            prompt,
            { cwd: invocationCwd },
        );

        const result = await researchAgent.run({ verbose });

        const plannerAgent = new AgentClass(
            'planner',
            `
                    You are a Planner Agent.

                    * Read the research doc at the exact path: ${runContext.researchPath}
                    * Plan the steps to accomplish the user's request.
                    * Write a checklist of the steps to accomplish the user's request only to
                      the exact path: ${runContext.taskPath}
                    * Last message should be the exact path: ${runContext.taskPath}

                    [Research Agent Output]
                    ${result.result}
                    [/Research Agent Output]
                `,
            prompt,
            { cwd: invocationCwd },
        );

        await plannerAgent.run({ verbose });

        const worktree = createWorktreeFn({ cwd: invocationCwd, slug: runContext.slug });

        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
        fs.writeFileSync(
            runContext.statusPath,
            `# Status\n\n- Slug: \`${runContext.slug}\`\n- Branch: \`${worktree.branch}\`\n- Worktree: \`${worktree.worktreePath}\`\n`,
        );

        const testWriter = new AgentClass(
            'test-writer',
            `
                    You are a Test Writer Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktree.worktreePath}, branch: ${worktree.branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the task checklist at the exact path: ${runContext.taskPath}
                    * Before making any production-code changes, decide how to verify the work:
                      - If automated tests are practical, write the relevant test cases/files first,
                        extending the existing test runner and conventions.
                      - If automated tests are not practical, update the exact status file at
                        ${runContext.statusPath} with a "## Verification" section describing what
                        a human or later reviewer should check in the diff. Do not invent a fake
                        test harness.
                    * Do not implement the feature/fix itself in this stage — tests and criteria only.
                    * Update the exact status file at: ${runContext.statusPath}
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Your final message must include test file paths / run command, if
                      applicable, so it can be handed to the next stage.
                `,
            prompt,
            { cwd: worktree.worktreePath },
        );

        const testOut = await testWriter.run({ verbose });
        if (!testOut.ok) {
            throw new Error('test-writer failed; stopping before code-writer');
        }

        const codeWriter = new AgentClass(
            'code-writer',
            `
                    You are a Code Writer Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktree.worktreePath}, branch: ${worktree.branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the task checklist at the exact path: ${runContext.taskPath} and the
                      current status at the exact path: ${runContext.statusPath}
                    * Implement the steps in the task checklist.
                    * Keep the exact status file at ${runContext.statusPath} updated as steps
                      complete.
                    * If tests were added or already exist, run them and record the results (pass or
                      fail) in the status file. Do not fix failures beyond this stage — finish
                      regardless of failure.
                    * If only verification criteria exist, implement so those criteria are met, and
                      note that in the status file.
                    * Do not delete or weaken tests just to force a green run.
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Once implementation is done, the task is complete.

                    [Test Writer Output]
                    ${testOut.result}
                    [/Test Writer Output]
                `,
            prompt,
            { cwd: worktree.worktreePath },
        );

        const codeOut = await codeWriter.run({ verbose });
        if (!codeOut.ok) {
            throw new Error('code-writer failed; stopping before commit');
        }

        const message = `orch: ${runContext.slug} ${prompt.split('\n')[0]}`;
        const commitResult = commitWorktreeFn({
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            message,
        });

        if (commitResult.committed) {
            fs.appendFileSync(
                runContext.statusPath,
                `\n## Commit\n\n- SHA: \`${commitResult.sha}\`\n- Branch: \`${commitResult.branch}\`\n`,
            );
            console.log(`commit: ${commitResult.sha.slice(0, 7)} on ${commitResult.branch}`);
            console.log(`merge:  git merge ${commitResult.branch}`);
        } else {
            fs.appendFileSync(
                runContext.statusPath,
                `\n## Commit\n\n- No changes to commit on \`${commitResult.branch}\`.\n`,
            );
            console.log(`commit: no changes on ${commitResult.branch}`);
        }
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
        new Option('--agent <agent>', 'Agent backend to run the pipeline with: "cursor" (Cursor Agent CLI), "claude" (Claude Code CLI), or "agn" (agn CLI)')
            .choices(['cursor', 'claude', 'agn'])
            .default('cursor'),
    )
    .addHelpText(
        'after',
        `
Examples:
  $ orch "fix the typo in the README" --agent claude
  $ orch "fix the bug described in task.md" --agent cursor -v
  $ orch "implement the local spec" --agent agn -v
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
