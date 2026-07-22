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
import { parseVerdict } from './lib/parse-verdict.js';
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

function formatVerdictFeedback(verdict, rawResult) {
    const lines = [];
    if (verdict.summary) lines.push(verdict.summary);
    if (Array.isArray(verdict.failures)) {
        for (const failure of verdict.failures) {
            lines.push(String(failure));
        }
    }
    if (lines.length === 0 && typeof rawResult === 'string') {
        return rawResult;
    }
    return lines.join('\n');
}

function appendLoopStatus(statusPath, title, { round, maxRounds, passed, summary }) {
    fs.appendFileSync(
        statusPath,
        `\n## ${title}\n\n- Rounds: ${round}/${maxRounds}\n- Result: ${passed ? 'passed' : 'failed'}\n- Summary: ${summary || ''}\n`,
    );
}

function roundLabel(role, round, maxRounds) {
    return `${role} ${round}/${maxRounds}`;
}

export async function runPipeline(prompt, options) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
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

    if (options.ask) {
        const askAgent = new AgentClass(
            'ask',
            `
                You are an Ask Agent.

                * Answer the user's question about the codebase.
                * This is read-only: do not edit files, write orch artifacts under .orch/,
                  or create worktrees.
                * Put the full answer in your final message.
            `,
            prompt,
            { cwd: invocationCwd, readOnly: true },
        );

        try {
            const askResult = await askAgent.run({ verbose });
            if (!askResult.ok) {
                console.error(`Error: ask agent failed`);
                process.exit(1);
                return;
            }
            console.log(askResult.result);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
        return;
    }

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

        // --- test loop: test-writer ⇄ test-critic ---
        let testAccepted = null;
        let criticFeedback = null;
        let testRound = 0;
        let testSummary = '';

        for (let round = 1; round <= maxRounds; round++) {
            testRound = round;

            const criticBlock = criticFeedback
                ? `
                    [Test Critic Feedback]
                    ${criticFeedback}
                    [/Test Critic Feedback]
                `
                : '';

            const testWriter = new AgentClass(
                roundLabel('test-writer', round, maxRounds),
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
                    * Later rounds must address critic feedback; do not write production code.
                    ${criticBlock}
                `,
                prompt,
                { cwd: worktree.worktreePath },
            );

            const testOut = await testWriter.run({ verbose });
            if (!testOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Test loop', {
                    round: testRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-writer failed',
                });
                throw new Error('test-writer failed; stopping before code-writer');
            }

            const testCritic = new AgentClass(
                roundLabel('test-critic', round, maxRounds),
                `
                    You are a Test Critic Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktree.worktreePath}, branch: ${worktree.branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the task checklist at the exact path: ${runContext.taskPath} and the
                      status at the exact path: ${runContext.statusPath}
                    * Judge whether the current tests / "## Verification" section are adequate
                      for the task checklist intent (coverage of requirements, not merely that
                      files exist).
                    * Do not edit production code or rewrite tests. Feedback only.
                    * Your final message MUST include a JSON verdict:
                      {"passed": true|false, "summary": "short reason", "failures": ["optional"]}
                    * Set passed: true only when verification is adequate to freeze for implementation.

                    [Test Writer Output]
                    ${testOut.result}
                    [/Test Writer Output]
                `,
                prompt,
                { cwd: worktree.worktreePath },
            );

            const criticOut = await testCritic.run({ verbose });
            if (!criticOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Test loop', {
                    round: testRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-critic failed',
                });
                throw new Error('test-critic failed; stopping before code-writer');
            }

            const verdict = parseVerdict(criticOut.result);
            testSummary = verdict.summary;
            if (verdict.passed) {
                testAccepted = { writerOut: testOut, criticOut, verdict, round };
                break;
            }
            criticFeedback = formatVerdictFeedback(verdict, criticOut.result);
        }

        appendLoopStatus(runContext.statusPath, 'Test loop', {
            round: testAccepted?.round ?? testRound,
            maxRounds,
            passed: Boolean(testAccepted),
            summary: testAccepted?.verdict.summary ?? testSummary,
        });

        if (!testAccepted) {
            throw new Error(`test loop exhausted after ${maxRounds} rounds`);
        }

        // --- code loop: code-writer ⇄ test-runner ---
        let codeAccepted = null;
        let runnerFeedback = null;
        let codeRound = 0;
        let codeSummary = '';

        const acceptedVerification = [
            testAccepted.verdict.summary,
            testAccepted.writerOut.result,
        ]
            .filter(Boolean)
            .join('\n');

        for (let round = 1; round <= maxRounds; round++) {
            codeRound = round;

            const feedbackBlock =
                round === 1
                    ? `
                    [Accepted Verification]
                    ${acceptedVerification}
                    [/Accepted Verification]
                `
                    : `
                    [Test Runner Feedback]
                    ${runnerFeedback}
                    [/Test Runner Feedback]
                `;

            const codeWriter = new AgentClass(
                roundLabel('code-writer', round, maxRounds),
                `
                    You are a Code Writer Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktree.worktreePath}, branch: ${worktree.branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the task checklist at the exact path: ${runContext.taskPath} and the
                      current status at the exact path: ${runContext.statusPath}
                    * Implement the steps in the task checklist against the frozen verification
                      from the test loop.
                    * Keep the exact status file at ${runContext.statusPath} updated as steps
                      complete.
                    * Do not run the test suite as a gate — that is the test-runner's job. Do not
                      delete or weaken tests just to force a green run.
                    * If only verification criteria exist, implement so those criteria are met, and
                      note that in the status file.
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Once implementation is done, the task is complete.
                    ${feedbackBlock}
                `,
                prompt,
                { cwd: worktree.worktreePath },
            );

            const codeOut = await codeWriter.run({ verbose });
            if (!codeOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Code loop', {
                    round: codeRound,
                    maxRounds,
                    passed: false,
                    summary: 'code-writer failed',
                });
                throw new Error('code-writer failed; stopping before commit');
            }

            const testRunner = new AgentClass(
                roundLabel('test-runner', round, maxRounds),
                `
                    You are a Test Runner Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktree.worktreePath}, branch: ${worktree.branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the status at the exact path: ${runContext.statusPath} and prior stage
                      output for the test command(s) to run.
                    * If a runnable command is recorded, run it and report the outcome.
                    * If only a "## Verification" section exists, evaluate the current diff against
                      those criteria by inspection.
                    * Do not edit production code or tests. Report only.
                    * Your final message MUST include a JSON verdict:
                      {"passed": true|false, "summary": "short reason", "failures": ["optional"]}
                    * Set passed: true only when the verification gate is green.

                    [Code Writer Output]
                    ${codeOut.result}
                    [/Code Writer Output]
                `,
                prompt,
                { cwd: worktree.worktreePath },
            );

            const runnerOut = await testRunner.run({ verbose });
            if (!runnerOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Code loop', {
                    round: codeRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-runner failed',
                });
                throw new Error('test-runner failed; stopping before commit');
            }

            const verdict = parseVerdict(runnerOut.result);
            codeSummary = verdict.summary;
            if (verdict.passed) {
                codeAccepted = { writerOut: codeOut, runnerOut, verdict, round };
                break;
            }
            runnerFeedback = formatVerdictFeedback(verdict, runnerOut.result);
        }

        appendLoopStatus(runContext.statusPath, 'Code loop', {
            round: codeAccepted?.round ?? codeRound,
            maxRounds,
            passed: Boolean(codeAccepted),
            summary: codeAccepted?.verdict.summary ?? codeSummary,
        });

        if (!codeAccepted) {
            throw new Error(`code loop exhausted after ${maxRounds} rounds`);
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
    .option('--ask', 'Ask a read-only question about the codebase; print the reply and exit (skips triage and all write pipelines)')
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop (ignored with --ask)', (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error('--max-rounds must be a positive integer');
        }
        return n;
    }, 5)
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
  $ orch --ask "where is the CLI entrypoint?" --agent claude
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
