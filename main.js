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
import { askAgentArgs } from './agents/ask.js';
import { triageAgentArgs } from './agents/triage.js';
import { quickFixAgentArgs } from './agents/quick-fix.js';
import { researchAgentArgs } from './agents/research.js';
import { plannerAgentArgs } from './agents/planner.js';
import { testWriterAgentArgs } from './agents/test-writer.js';
import { testCriticAgentArgs } from './agents/test-critic.js';
import { codeWriterAgentArgs } from './agents/code-writer.js';
import { testRunnerAgentArgs } from './agents/test-runner.js';

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
        const ask = askAgentArgs({ prompt, cwd: invocationCwd });
        const askAgent = new AgentClass(ask.name, ask.instructions, ask.prompt, ask.options);

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

    if (options.quick) {
        const quickFix = quickFixAgentArgs({ prompt, cwd: invocationCwd });
        const quickFixAgent = new AgentClass(
            quickFix.name,
            quickFix.instructions,
            quickFix.prompt,
            quickFix.options,
        );

        try {
            const quickFixResult = await quickFixAgent.run({ verbose });
            if (!quickFixResult.ok) {
                console.error(`Error: quick-fix agent failed`);
                process.exit(1);
                return;
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
        return;
    }

    const triage = triageAgentArgs({ prompt, cwd: invocationCwd });
    const triageAgent = new AgentClass(
        triage.name,
        triage.instructions,
        triage.prompt,
        triage.options,
    );

    try {
        const triageResult = await triageAgent.run({ verbose });
        const parsed = parseTriageJson(triageResult.result);

        if (parsed?.simple === true) {
            const quickFix = quickFixAgentArgs({
                prompt,
                cwd: invocationCwd,
                fix_plan: parsed.fix_plan,
            });
            const quickFixAgent = new AgentClass(
                quickFix.name,
                quickFix.instructions,
                quickFix.prompt,
                quickFix.options,
            );

            await quickFixAgent.run({ verbose });
            return;
        }

        const runContext = createRunContextFn({ cwd: invocationCwd });
        console.log(`task ${runContext.slug} is started`);

        const research = researchAgentArgs({
            prompt,
            cwd: invocationCwd,
            researchPath: runContext.researchPath,
        });
        const researchAgent = new AgentClass(
            research.name,
            research.instructions,
            research.prompt,
            research.options,
        );

        const result = await researchAgent.run({ verbose });

        const planner = plannerAgentArgs({
            prompt,
            cwd: invocationCwd,
            researchPath: runContext.researchPath,
            taskPath: runContext.taskPath,
            researchOutput: result.result,
        });
        const plannerAgent = new AgentClass(
            planner.name,
            planner.instructions,
            planner.prompt,
            planner.options,
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

            const testWriterArgs = testWriterAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                criticFeedback,
            });
            const testWriter = new AgentClass(
                roundLabel('test-writer', round, maxRounds),
                testWriterArgs.instructions,
                testWriterArgs.prompt,
                testWriterArgs.options,
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

            const testCriticArgs = testCriticAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                testWriterOutput: testOut.result,
            });
            const testCritic = new AgentClass(
                roundLabel('test-critic', round, maxRounds),
                testCriticArgs.instructions,
                testCriticArgs.prompt,
                testCriticArgs.options,
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

            const codeWriterArgs = codeWriterAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                round,
                acceptedVerification,
                runnerFeedback,
            });
            const codeWriter = new AgentClass(
                roundLabel('code-writer', round, maxRounds),
                codeWriterArgs.instructions,
                codeWriterArgs.prompt,
                codeWriterArgs.options,
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

            const testRunnerArgs = testRunnerAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                statusPath: runContext.statusPath,
                codeWriterOutput: codeOut.result,
            });
            const testRunner = new AgentClass(
                roundLabel('test-runner', round, maxRounds),
                testRunnerArgs.instructions,
                testRunnerArgs.prompt,
                testRunnerArgs.options,
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
    .description('The Orchestrator: triage → research → plan → implement pipeline against a task')
    .argument('<task...>', 'Task description to use as the prompt (mention a file path and the agent will read it)')
    .option('-v, --verbose', 'Stream agent thinking/output deltas to stderr as the pipeline runs')
    .option('--dry-run', 'Check that the selected agent CLI is on PATH and exit; do not run the pipeline')
    .option('--ask', 'Ask a read-only question about the codebase; print the reply and exit (skips triage and all write pipelines)')
    .option('--quick', 'Skip triage, run quick-fix directly in the current working tree; create no artifacts, worktrees, or commits')
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop (ignored with --ask and --quick)', (value) => {
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
  $ orch --quick "fix the typo in the README" --agent claude
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
