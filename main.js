#!/usr/bin/env node
import { Command, Option } from 'commander';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { fileURLToPath } from 'url';
import { AgentCursor } from './lib/agent-cursor.js';
import { AgentClaude } from './lib/agent-claude.js';
import { AgentAgn } from './lib/agent-agn.js';
import { parseTriageJson } from './lib/parse-triage-json.js';
import { parseVerdict } from './lib/parse-verdict.js';
import { splitStageSummary, printStageSummary } from './lib/stage-summary.js';
import { createRunContext } from './lib/run-context.js';
import { createWorktree } from './lib/worktree.js';
import { commitWorktree, collectWorktreeChanges, printFilesChanged } from './lib/commit.js';
import { FileTracker } from './lib/file-tracker.js';
import { generateSlug } from './lib/slug.js';
import {
    jobPaths,
    writeJob,
    readJob,
    patchJob,
    listJobs,
    reconcileJob,
    checkpointPause,
    requestPause,
    requestResume,
    stopJob,
    cleanJobs,
} from './lib/jobs.js';
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

const TERMINAL_JOB_STATES = ['done', 'failed', 'stopped', 'crashed'];

function formatRelativeTime(iso) {
    if (!iso) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

function formatJobsTable(jobs) {
    const header = ['SLUG', 'STATE', 'PHASE', 'AGENT', 'STARTED', 'PID'];
    const rows = jobs.map((job) => [
        job.slug,
        job.state,
        job.phase ?? '-',
        job.agent ?? '-',
        formatRelativeTime(job.startedAt),
        TERMINAL_JOB_STATES.includes(job.state) ? '-' : (job.pid ?? '-'),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
    const formatRow = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
    return [formatRow(header), ...rows.map(formatRow)].join('\n');
}

function lastNonEmptyLine(content) {
    const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1];
}

function formatStatus(cwd, record) {
    const lines = [
        `slug:     ${record.slug}`,
        `state:    ${record.state}`,
        `phase:    ${record.phase ?? '-'}`,
        `stage:    ${record.stage ?? '-'}`,
        `agent:    ${record.agent ?? '-'}`,
        `started:  ${record.startedAt} (${formatRelativeTime(record.startedAt)})`,
        `finished: ${record.finishedAt ?? '-'}`,
        `branch:   ${record.branch ?? '-'}`,
        `worktree: ${record.worktree ?? '-'}`,
        `exitCode: ${record.exitCode ?? '-'}`,
        `log:      ${record.logPath ?? '-'}`,
    ];

    const statusPath = path.join(jobPaths(cwd, record.slug).dir, 'status.md');
    if (fs.existsSync(statusPath)) {
        const last = lastNonEmptyLine(fs.readFileSync(statusPath, 'utf8'));
        if (last) lines.push(`status:   ${last}`);
    }

    return lines.join('\n');
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
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const invocationCwd = process.cwd();

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? invocationCwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        patchJobFn(jobCwd, jobSlug, fields);
    };
    const jobCheckpoint = async () => {
        if (!jobSlug) return;
        await checkpointPauseFn(jobCwd, jobSlug, { pollIntervalMs: pausePollIntervalMs });
    };

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
            const { content, summary } = splitStageSummary(askResult.result);
            printStageSummary('ask', summary);
            console.log(content);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
        return;
    }

    if (options.quick) {
        const quickFix = quickFixAgentArgs({ prompt, cwd: invocationCwd });
        const quickFixTracker = new FileTracker({ cwd: invocationCwd });
        const quickFixAgent = new AgentClass(
            quickFix.name,
            quickFix.instructions,
            quickFix.prompt,
            { ...quickFix.options, fileTracker: quickFixTracker },
        );

        try {
            const quickFixResult = await quickFixAgent.run({ verbose });
            if (!quickFixResult.ok) {
                console.error(`Error: quick-fix agent failed`);
                process.exit(1);
                return;
            }
            const { summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', quickFixSummary, quickFixTracker.getFiles());
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
        jobPatch({ phase: 'triage', stage: 'triage', round: null });
        await jobCheckpoint();
        const triageResult = await triageAgent.run({ verbose });
        await jobCheckpoint();
        const { content: triageContent, summary: triageSummary } = splitStageSummary(triageResult.result);
        printStageSummary('triage', triageSummary);
        const parsed = parseTriageJson(triageContent);

        if (parsed?.simple === true) {
            jobPatch({ phase: 'quick-fix', stage: 'quick-fix', round: null });
            const quickFix = quickFixAgentArgs({
                prompt,
                cwd: invocationCwd,
                fix_plan: parsed.fix_plan,
            });
            const quickFixTracker = new FileTracker({ cwd: invocationCwd });
            const quickFixAgent = new AgentClass(
                quickFix.name,
                quickFix.instructions,
                quickFix.prompt,
                { ...quickFix.options, fileTracker: quickFixTracker },
            );

            const quickFixResult = await quickFixAgent.run({ verbose });
            await jobCheckpoint();
            const { summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', quickFixSummary, quickFixTracker.getFiles());
            jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
            return;
        }

        const runContext = createRunContextFn(
            jobSlug ? { cwd: invocationCwd, slug: jobSlug } : { cwd: invocationCwd },
        );
        console.log(`task ${runContext.slug} is started`);

        jobPatch({ phase: 'research', stage: 'research', round: null });
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
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(result.result);
        printStageSummary('research', researchSummary);

        jobPatch({ phase: 'plan', stage: 'planner', round: null });
        const planner = plannerAgentArgs({
            prompt,
            cwd: invocationCwd,
            researchPath: runContext.researchPath,
            taskPath: runContext.taskPath,
            researchOutput: researchContent,
        });
        const plannerAgent = new AgentClass(
            planner.name,
            planner.instructions,
            planner.prompt,
            planner.options,
        );

        const plannerResult = await plannerAgent.run({ verbose });
        await jobCheckpoint();
        const { summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', plannerSummary);

        jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
        const worktree = createWorktreeFn({ cwd: invocationCwd, slug: runContext.slug });
        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

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

            jobPatch({ phase: 'test-loop', stage: 'test-writer', round });
            const testWriterArgs = testWriterAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                criticFeedback,
            });
            const testWriterTracker = new FileTracker({ cwd: worktree.worktreePath });
            const testWriter = new AgentClass(
                roundLabel('test-writer', round, maxRounds),
                testWriterArgs.instructions,
                testWriterArgs.prompt,
                { ...testWriterArgs.options, fileTracker: testWriterTracker },
            );

            const testOut = await testWriter.run({ verbose });
            await jobCheckpoint();
            const { content: testWriterContent, summary: testWriterSummary } = splitStageSummary(testOut.result);
            printStageSummary(
                roundLabel('test-writer', round, maxRounds),
                testWriterSummary,
                testWriterTracker.getFiles(),
            );
            if (!testOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Test loop', {
                    round: testRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-writer failed',
                });
                throw new Error('test-writer failed; stopping before code-writer');
            }

            jobPatch({ phase: 'test-loop', stage: 'test-critic', round });
            const testCriticArgs = testCriticAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                testWriterOutput: testWriterContent,
            });
            const testCritic = new AgentClass(
                roundLabel('test-critic', round, maxRounds),
                testCriticArgs.instructions,
                testCriticArgs.prompt,
                testCriticArgs.options,
            );

            const criticOut = await testCritic.run({ verbose });
            await jobCheckpoint();
            const { content: testCriticContent, summary: testCriticSummary } = splitStageSummary(criticOut.result);
            printStageSummary(roundLabel('test-critic', round, maxRounds), testCriticSummary);
            if (!criticOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Test loop', {
                    round: testRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-critic failed',
                });
                throw new Error('test-critic failed; stopping before code-writer');
            }

            const verdict = parseVerdict(testCriticContent);
            testSummary = verdict.summary;
            if (verdict.passed) {
                testAccepted = { writerContent: testWriterContent, criticOut, verdict, round };
                break;
            }
            criticFeedback = formatVerdictFeedback(verdict, testCriticContent);
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
            testAccepted.writerContent,
        ]
            .filter(Boolean)
            .join('\n');

        for (let round = 1; round <= maxRounds; round++) {
            codeRound = round;

            jobPatch({ phase: 'code-loop', stage: 'code-writer', round });
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
            const codeWriterTracker = new FileTracker({ cwd: worktree.worktreePath });
            const codeWriter = new AgentClass(
                roundLabel('code-writer', round, maxRounds),
                codeWriterArgs.instructions,
                codeWriterArgs.prompt,
                { ...codeWriterArgs.options, fileTracker: codeWriterTracker },
            );

            const codeOut = await codeWriter.run({ verbose });
            await jobCheckpoint();
            const { content: codeWriterContent, summary: codeWriterSummary } = splitStageSummary(codeOut.result);
            printStageSummary(
                roundLabel('code-writer', round, maxRounds),
                codeWriterSummary,
                codeWriterTracker.getFiles(),
            );
            if (!codeOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Code loop', {
                    round: codeRound,
                    maxRounds,
                    passed: false,
                    summary: 'code-writer failed',
                });
                throw new Error('code-writer failed; stopping before commit');
            }

            jobPatch({ phase: 'code-loop', stage: 'test-runner', round });
            const testRunnerArgs = testRunnerAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                statusPath: runContext.statusPath,
                codeWriterOutput: codeWriterContent,
            });
            const testRunner = new AgentClass(
                roundLabel('test-runner', round, maxRounds),
                testRunnerArgs.instructions,
                testRunnerArgs.prompt,
                testRunnerArgs.options,
            );

            const runnerOut = await testRunner.run({ verbose });
            await jobCheckpoint();
            const { content: testRunnerContent, summary: testRunnerSummary } = splitStageSummary(runnerOut.result);
            printStageSummary(roundLabel('test-runner', round, maxRounds), testRunnerSummary);
            if (!runnerOut.ok) {
                appendLoopStatus(runContext.statusPath, 'Code loop', {
                    round: codeRound,
                    maxRounds,
                    passed: false,
                    summary: 'test-runner failed',
                });
                throw new Error('test-runner failed; stopping before commit');
            }

            const verdict = parseVerdict(testRunnerContent);
            codeSummary = verdict.summary;
            if (verdict.passed) {
                codeAccepted = { writerContent: codeWriterContent, verdict, round };
                break;
            }
            runnerFeedback = formatVerdictFeedback(verdict, testRunnerContent);
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

        jobPatch({ phase: 'commit', stage: 'commit', round: null });
        const message = `orch: ${runContext.slug} ${prompt.split('\n')[0]}`;
        const worktreeChanges = collectWorktreeChangesFn({
            worktreePath: worktree.worktreePath,
        });
        printFilesChanged(worktreeChanges);
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

        jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (jobSlug) {
            try {
                patchJobFn(jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    finishedAt: new Date().toISOString(),
                });
            } catch {
                // Best-effort: don't let a job-state write failure mask the real error.
            }
        }
        process.exit(1);
    }
}

/**
 * The detach-PARENT path: allocates a run directory, writes an initial
 * `run.json`, spawns a `--detach`-stripped re-invocation of this CLI with
 * `ORCH_JOB_SLUG`/`ORCH_DETACHED` set, patches in the child's pid, and
 * returns immediately. `runPipeline` (the child/pipeline-running path) never
 * runs in this process.
 */
export async function runDetached(prompt, options = {}) {
    const {
        agent,
        maxRounds = 5,
        verbose,
        cwd = process.cwd(),
        createRunContext: createRunContextFn = createRunContext,
        spawn: spawnFn = spawn,
        exit = (code) => process.exit(code),
    } = options;

    const backend = AGENT_BACKENDS[agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${agent}`);
    }

    if (!isBinaryOnPath(backend.binary)) {
        console.error(binaryMissingHint(agent));
        exit(1);
        return;
    }

    const slug = generateSlug();
    createRunContextFn({ cwd, slug });
    const { logPath } = jobPaths(cwd, slug);
    const startedAt = new Date().toISOString();

    writeJob(cwd, slug, {
        slug,
        task: prompt,
        agent,
        maxRounds,
        cwd,
        pauseRequested: false,
        branch: null,
        worktree: null,
        startedAt,
        finishedAt: null,
        exitCode: null,
        logPath,
        pid: null,
        state: 'starting',
        phase: null,
        stage: null,
        round: null,
    });

    const logFd = fs.openSync(logPath, 'a');

    const childArgs = [__filename, prompt, '--agent', agent, '--max-rounds', String(maxRounds)];
    if (verbose) childArgs.push('--verbose');

    const child = spawnFn(process.execPath, childArgs, {
        cwd,
        env: { ...process.env, ORCH_JOB_SLUG: slug, ORCH_DETACHED: '1' },
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    patchJob(cwd, slug, { pid: child.pid, state: 'running' });

    console.log(`started ${slug} (pid ${child.pid})`);
    exit(0);
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
    .option('--detach', 'Run the pipeline in the background and return immediately; manage it with orch list/status/pause/resume/stop/logs. Cannot be combined with --ask, --quick, or --dry-run')
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

Headless runs:
  $ orch "long-running task" --detach --agent claude   # start in the background, prints the run slug
  $ orch list                                          # show all tracked runs
  $ orch status [slug]                                 # show full status (defaults to most recent)
  $ orch pause <slug>                                  # request a pause at the next stage boundary
  $ orch resume <slug>                                 # resume a paused/pausing run
  $ orch stop <slug>                                   # send SIGTERM to a running job
  $ orch logs <slug> [-f]                              # print (or follow) a run's log file
`,
    )
    .action(async (task, options) => {
        const prompt = task.join(' ').trim();
        if (!prompt) {
            console.error('Error: task cannot be empty');
            process.exit(1);
            return;
        }

        if (options.detach) {
            const conflicts = ['ask', 'quick', 'dryRun']
                .filter((key) => options[key])
                .map((key) => `--${key === 'dryRun' ? 'dry-run' : key}`);
            if (conflicts.length > 0) {
                console.error(`Error: --detach cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            await runDetached(prompt, options);
            return;
        }

        await runPipeline(prompt, options);
    });

program
    .command('list')
    .description('List all runs (active and finished) tracked under .orch/ in this directory')
    .action(() => {
        const jobs = listJobs(process.cwd());
        if (jobs.length === 0) {
            console.log('no runs');
            return;
        }
        console.log(formatJobsTable(jobs));
    });

program
    .command('status')
    .argument('[slug]', 'Run slug to show; defaults to the most recently started run in this directory')
    .description('Show full status for a run')
    .action((slug) => {
        const cwd = process.cwd();
        let record;
        if (slug) {
            record = readJob(cwd, slug);
            if (!record) {
                console.error(`Error: unknown run ${slug}`);
                process.exit(1);
                return;
            }
            record = reconcileJob(cwd, slug, record);
        } else {
            const jobs = listJobs(cwd);
            if (jobs.length === 0) {
                console.error('Error: no runs found in this directory');
                process.exit(1);
                return;
            }
            [record] = jobs;
        }
        console.log(formatStatus(cwd, record));
    });

program
    .command('pause')
    .argument('<slug>', 'Run slug to pause')
    .description('Request a running job to pause at its next stage-boundary checkpoint')
    .action((slug) => {
        try {
            requestPause(process.cwd(), slug);
            console.log(`pause requested for ${slug}`);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('resume')
    .argument('<slug>', 'Run slug to resume')
    .description('Resume a paused (or pausing) job')
    .action((slug) => {
        try {
            requestResume(process.cwd(), slug);
            console.log(`resumed ${slug}`);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('stop')
    .argument('<slug>', 'Run slug to stop')
    .description('Send SIGTERM to a running job (or reconcile a dead one to crashed)')
    .action((slug) => {
        try {
            const result = stopJob(process.cwd(), slug);
            if (result.action === 'signaled') {
                console.log(`stop signal sent to ${slug} (pid ${result.record.pid})`);
            } else if (result.action === 'crashed') {
                console.log(`${slug} process was already gone; marked crashed`);
            } else {
                console.log(`${slug} is already ${result.record.state}`);
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

const jobsCmd = program
    .command('jobs')
    .description('Manage orch job artifacts under .orch/');

jobsCmd
    .command('clean')
    .description('Delete all orch jobs from the .orch folder')
    .action(async () => {
        const cwd = process.cwd();
        const orchDir = path.join(cwd, '.orch');
        if (!fs.existsSync(orchDir) || fs.readdirSync(orchDir).length === 0) {
            console.log('no jobs to clean');
            return;
        }

        const rl = readline.createInterface({ input, output });
        let answer;
        try {
            answer = await rl.question('Are you sure? [y/N] ');
        } finally {
            rl.close();
        }

        if (!/^y(es)?$/i.test(answer.trim())) {
            console.log('aborted');
            return;
        }

        const removed = cleanJobs(cwd);
        console.log(`deleted ${removed.length} job${removed.length === 1 ? '' : 's'} from .orch/`);
    });

program
    .command('logs')
    .argument('<slug>', 'Run slug to show logs for')
    .option('-f, --follow', 'Follow the log file until the job reaches a terminal state (Ctrl+C to stop)')
    .description("Print a run's orch.log")
    .action((slug, options) => {
        const cwd = process.cwd();
        const record = readJob(cwd, slug);
        if (!record) {
            console.error(`Error: unknown run ${slug}`);
            process.exit(1);
            return;
        }
        const { logPath } = jobPaths(cwd, slug);
        if (!fs.existsSync(logPath)) {
            console.error(`Error: no log file for ${slug}`);
            process.exit(1);
            return;
        }

        if (!options.follow) {
            process.stdout.write(fs.readFileSync(logPath));
            return;
        }

        const fd = fs.openSync(logPath, 'r');
        let position = 0;
        const pump = () => {
            const { size } = fs.fstatSync(fd);
            if (size > position) {
                const buf = Buffer.alloc(size - position);
                fs.readSync(fd, buf, 0, buf.length, position);
                process.stdout.write(buf);
                position = size;
            }
        };
        pump();

        const stop = () => {
            clearInterval(interval);
            fs.closeSync(fd);
            process.exit(0);
        };

        const interval = setInterval(() => {
            pump();
            const current = reconcileJob(cwd, slug, readJob(cwd, slug));
            if (TERMINAL_JOB_STATES.includes(current.state)) stop();
        }, 500);

        process.once('SIGINT', stop);
    });

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === __filename) {
    program.parse();
}
