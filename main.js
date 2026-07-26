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
import { allocateJob } from './lib/job-lifecycle.js';
import { setJobSlug, exitCodeForSignal, formatElapsed } from './lib/agent.js';
import {
    jobPaths,
    readJob,
    patchJob,
    listJobs,
    reconcileJob,
    checkpointPause,
    requestPause,
    requestResume,
    stopJob,
    cleanJobs,
    isPidAlive,
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
import { integratorAgentArgs } from './agents/integrator.js';
import { boundariesAgentArgs } from './agents/boundaries.js';
import { decomposerAgentArgs } from './agents/decomposer.js';
import {
    readFanout,
    writeFanout,
    patchWorker,
    patchIntegration,
    recordChangedFiles,
    buildWorkerEnvelope,
    buildIntegrationEnvelope,
    validateDecomposition,
    planLayers,
    chooseConcurrency,
    detectOverlaps,
    ensureScaffoldSubtask,
} from './lib/fanout.js';
import { parseDecomposition } from './lib/parse-decomposition.js';
import {
    mergeBranches,
    abortMerge,
    conflictedFiles,
    hasConflictMarkers,
} from './lib/integrate.js';

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

function jobDuration(job) {
    if (!job.startedAt) return '-';
    const start = new Date(job.startedAt).getTime();
    if (Number.isNaN(start)) return '-';
    const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
    if (Number.isNaN(end)) return '-';
    return formatElapsed(Math.max(0, end - start));
}

function formatJobsTable(jobs) {
    const header = ['SLUG', 'STATE', 'PHASE', 'AGENT', 'STARTED', 'DURATION', 'PID'];
    const rows = jobs.map((job) => [
        job.slug,
        job.state,
        job.phase ?? '-',
        job.agent ?? '-',
        formatRelativeTime(job.startedAt),
        jobDuration(job),
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

function defaultExecFile(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/** The test-writer ⇄ test-critic loop shared by `runPipeline` and `runWorkerPipeline`. */
async function runTestLoop({
    prompt,
    worktreePath,
    branch,
    taskPath,
    statusPath,
    maxRounds,
    AgentClass,
    verbose,
    jobPatch,
    jobCheckpoint,
}) {
    let testAccepted = null;
    let criticFeedback = null;
    let testRound = 0;
    let testSummary = '';

    for (let round = 1; round <= maxRounds; round++) {
        testRound = round;

        jobPatch({ phase: 'test-loop', stage: 'test-writer', round });
        const testWriterArgs = testWriterAgentArgs({
            prompt,
            cwd: worktreePath,
            worktreePath,
            branch,
            taskPath,
            statusPath,
            criticFeedback,
        });
        const testWriterTracker = new FileTracker({ cwd: worktreePath });
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
            appendLoopStatus(statusPath, 'Test loop', {
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
            cwd: worktreePath,
            worktreePath,
            branch,
            taskPath,
            statusPath,
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
            appendLoopStatus(statusPath, 'Test loop', {
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

    appendLoopStatus(statusPath, 'Test loop', {
        round: testAccepted?.round ?? testRound,
        maxRounds,
        passed: Boolean(testAccepted),
        summary: testAccepted?.verdict.summary ?? testSummary,
    });

    if (!testAccepted) {
        throw new Error(`test loop exhausted after ${maxRounds} rounds`);
    }

    return testAccepted;
}

/**
 * The code-writer ⇄ test-runner loop shared by `runPipeline`, `runWorkerPipeline`, and
 * `runIntegratePipeline`. `runnerFirst` (used by `--integrate`'s verify loop) skips
 * `code-writer` on round 1 only; if that lone `test-runner` attempt fails, rounds 2+
 * alternate `code-writer` → `test-runner` exactly like the default writer-first shape.
 */
async function runCodeLoop({
    prompt,
    worktreePath,
    branch,
    taskPath,
    statusPath,
    maxRounds,
    AgentClass,
    verbose,
    jobPatch,
    jobCheckpoint,
    acceptedVerification,
    runnerFirst = false,
    loopTitle = 'Code loop',
}) {
    let codeAccepted = null;
    let runnerFeedback = null;
    let codeRound = 0;
    let codeSummary = '';
    let codeWriterContent = null;

    for (let round = 1; round <= maxRounds; round++) {
        codeRound = round;
        const skipWriter = runnerFirst && round === 1;

        if (!skipWriter) {
            jobPatch({ phase: 'code-loop', stage: 'code-writer', round });
            const codeWriterArgs = codeWriterAgentArgs({
                prompt,
                cwd: worktreePath,
                worktreePath,
                branch,
                taskPath,
                statusPath,
                round,
                acceptedVerification,
                runnerFeedback,
            });
            const codeWriterTracker = new FileTracker({ cwd: worktreePath });
            const codeWriter = new AgentClass(
                roundLabel('code-writer', round, maxRounds),
                codeWriterArgs.instructions,
                codeWriterArgs.prompt,
                { ...codeWriterArgs.options, fileTracker: codeWriterTracker },
            );

            const codeOut = await codeWriter.run({ verbose });
            await jobCheckpoint();
            const { content, summary } = splitStageSummary(codeOut.result);
            codeWriterContent = content;
            printStageSummary(
                roundLabel('code-writer', round, maxRounds),
                summary,
                codeWriterTracker.getFiles(),
            );
            if (!codeOut.ok) {
                appendLoopStatus(statusPath, loopTitle, {
                    round: codeRound,
                    maxRounds,
                    passed: false,
                    summary: 'code-writer failed',
                });
                throw new Error('code-writer failed; stopping before commit');
            }
        }

        jobPatch({ phase: 'code-loop', stage: 'test-runner', round });
        const testRunnerArgs = testRunnerAgentArgs({
            prompt,
            cwd: worktreePath,
            worktreePath,
            branch,
            statusPath,
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
            appendLoopStatus(statusPath, loopTitle, {
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

    appendLoopStatus(statusPath, loopTitle, {
        round: codeAccepted?.round ?? codeRound,
        maxRounds,
        passed: Boolean(codeAccepted),
        summary: codeAccepted?.verdict.summary ?? codeSummary,
    });

    if (!codeAccepted) {
        throw new Error(`code loop exhausted after ${maxRounds} rounds`);
    }

    return codeAccepted;
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
        jobPatch({ phase: 'ask' });
        const ask = askAgentArgs({ prompt, cwd: invocationCwd });
        const askAgent = new AgentClass(ask.name, ask.instructions, ask.prompt, ask.options);

        try {
            const askResult = await askAgent.run({ verbose });
            if (!askResult.ok) {
                console.error(`Error: ask agent failed`);
                jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                process.exit(1);
                return;
            }
            const { content, summary } = splitStageSummary(askResult.result);
            printStageSummary('ask', summary);
            console.log(content);
            jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
            process.exit(1);
        }
        return;
    }

    if (options.quick) {
        jobPatch({ phase: 'quick-fix' });
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
                jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                process.exit(1);
                return;
            }
            const { summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', quickFixSummary, quickFixTracker.getFiles());
            jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
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
        const testAccepted = await runTestLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            taskPath: runContext.taskPath,
            statusPath: runContext.statusPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
        });

        // --- code loop: code-writer ⇄ test-runner ---
        const acceptedVerification = [
            testAccepted.verdict.summary,
            testAccepted.writerContent,
        ]
            .filter(Boolean)
            .join('\n');

        await runCodeLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            taskPath: runContext.taskPath,
            statusPath: runContext.statusPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
            acceptedVerification,
        });

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

    const { slug } = allocateJob({
        cwd,
        prompt,
        agent,
        maxRounds,
        state: 'starting',
        createRunContext: createRunContextFn,
    });
    const { logPath } = jobPaths(cwd, slug);

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

/**
 * The `--worker <parent>:<workerId>` driver: skips triage and runs research → planner →
 * worktree (from the fan-out's recorded `base`) → test loop → code loop (writer-first) →
 * commit, exactly like `runPipeline` minus triage. `prompt` is the worker's subtask text
 * with the envelope already appended by the CLI wiring. On success, patches the parent's
 * `fanout.json.workers[]` entry to `state:'done'` with `sha`/`changedFiles`; on failure,
 * patches it (and this job's own `run.json`) to `state:'failed'` before exiting non-zero.
 */
export async function runWorkerPipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const { parentSlug, workerId, base } = options;

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const patchWorkerFn = options.patchWorker ?? patchWorker;
    const recordChangedFilesFn = options.recordChangedFiles ?? recordChangedFiles;
    const execFileFn = options.execFile;

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? cwd;
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

    if (!options.AgentClass) {
        ensureBinaryOnPath(backend.binary, options.agent);
    }

    try {
        const runContext = createRunContextFn(jobSlug ? { cwd, slug: jobSlug } : { cwd });

        jobPatch({ phase: 'research', stage: 'research', round: null });
        const research = researchAgentArgs({ prompt, cwd, researchPath: runContext.researchPath });
        const researchAgent = new AgentClass(
            research.name,
            research.instructions,
            research.prompt,
            research.options,
        );
        const researchResult = await researchAgent.run({ verbose });
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
        printStageSummary('research', researchSummary);

        jobPatch({ phase: 'plan', stage: 'planner', round: null });
        const planner = plannerAgentArgs({
            prompt,
            cwd,
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
        const worktree = createWorktreeFn({ cwd, slug: runContext.slug, base });
        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
        fs.writeFileSync(
            runContext.statusPath,
            `# Status\n\n- Slug: \`${runContext.slug}\`\n- Branch: \`${worktree.branch}\`\n- Worktree: \`${worktree.worktreePath}\`\n- Parent: \`${parentSlug}\`\n- Worker: \`${workerId}\`\n`,
        );

        const testAccepted = await runTestLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            taskPath: runContext.taskPath,
            statusPath: runContext.statusPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
        });

        const acceptedVerification = [testAccepted.verdict.summary, testAccepted.writerContent]
            .filter(Boolean)
            .join('\n');

        await runCodeLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            taskPath: runContext.taskPath,
            statusPath: runContext.statusPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
            acceptedVerification,
        });

        jobPatch({ phase: 'commit', stage: 'commit', round: null });
        const message = `orch: ${runContext.slug} ${prompt.split('\n')[0]}`;
        const worktreeChanges = collectWorktreeChangesFn({ worktreePath: worktree.worktreePath });
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
        } else {
            fs.appendFileSync(
                runContext.statusPath,
                `\n## Commit\n\n- No changes to commit on \`${commitResult.branch}\`.\n`,
            );
            console.log(`commit: no changes on ${commitResult.branch}`);
        }

        let changedFiles = [];
        try {
            changedFiles = recordChangedFilesFn({
                repoRoot: worktree.repoRoot,
                base,
                branch: worktree.branch,
                execFile: execFileFn,
            });
        } catch {
            // Best-effort: changedFiles is informational only, never masks a successful commit.
        }

        patchWorkerFn(cwd, parentSlug, workerId, {
            state: 'done',
            sha: commitResult.sha,
            changedFiles,
        });
        jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        try {
            patchWorkerFn(cwd, parentSlug, workerId, { state: 'failed' });
        } catch {
            // Best-effort: don't let a fanout-state write failure mask the real error.
        }
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
 * The `--integrate <parent>` driver: reuses (or creates) the integration worktree keyed
 * by the parent slug, merges `fanout.integration.candidates` in order (repairing conflicts
 * via the `integrator` agent, one conflict at a time), then runs a runner-first verify
 * loop and commits on green. Never invokes triage/research/planner/test-writer/test-critic.
 * Appends every step to `.orch/<job-slug>/integration.md` as it happens.
 */
export async function runIntegratePipeline(options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const { parentSlug } = options;

    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const readFanoutFn = options.readFanout ?? readFanout;
    const patchIntegrationFn = options.patchIntegration ?? patchIntegration;
    const mergeBranchesFn = options.mergeBranches ?? mergeBranches;
    const abortMergeFn = options.abortMerge ?? abortMerge;
    const conflictedFilesFn = options.conflictedFiles ?? conflictedFiles;
    const hasConflictMarkersFn = options.hasConflictMarkers ?? hasConflictMarkers;
    const execFileFn = options.execFile ?? defaultExecFile;

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? cwd;
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

    if (!options.AgentClass) {
        ensureBinaryOnPath(backend.binary, options.agent);
    }

    const fanout = readFanoutFn(cwd, parentSlug);
    if (!fanout) {
        console.error(`Error: unknown parent ${parentSlug} (no fanout.json found)`);
        process.exit(1);
        return;
    }

    const integrationSlug = jobSlug ?? parentSlug;
    const integrationDir = path.join(jobCwd, '.orch', integrationSlug);
    const integrationMdPath = path.join(integrationDir, 'integration.md');
    const logIntegration = (line) => {
        fs.mkdirSync(integrationDir, { recursive: true });
        fs.appendFileSync(integrationMdPath, `${line}\n`);
    };

    let merged = [...fanout.integration.merged];
    let skipped = [...(fanout.integration.skipped ?? [])];

    try {
        fs.mkdirSync(integrationDir, { recursive: true });
        fs.appendFileSync(integrationMdPath, `# Integration: ${parentSlug}\n\n`);

        jobPatch({ phase: 'worktree', stage: 'worktree', round: null });

        const reuseWorktreePath = `${cwd}-${parentSlug}`;
        const expectedBranch = `orch/${parentSlug}`;
        let worktree = null;

        if (fs.existsSync(reuseWorktreePath)) {
            const currentBranch = execFileFn('git', ['-C', reuseWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
            if (currentBranch === expectedBranch) {
                worktree = { repoRoot: cwd, worktreePath: reuseWorktreePath, branch: expectedBranch };
            }
        }

        const reused = Boolean(worktree);
        if (!worktree) {
            worktree = createWorktreeFn({ cwd, slug: parentSlug, base: fanout.base });
        }

        logIntegration(
            reused
                ? `- Reused existing worktree at \`${worktree.worktreePath}\` on \`${worktree.branch}\`.`
                : `- Created worktree at \`${worktree.worktreePath}\` on \`${worktree.branch}\`.`,
        );

        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });
        patchIntegrationFn(cwd, parentSlug, (current) => ({
            worktree: current.worktree ?? worktree.worktreePath,
            branch: current.branch ?? worktree.branch,
        }));

        let remaining = fanout.integration.candidates.filter(
            (branch) => !merged.includes(branch) && !skipped.includes(branch),
        );

        while (remaining.length > 0) {
            const results = mergeBranchesFn({
                cwd: worktree.worktreePath,
                candidates: remaining,
                merged,
                overlappingFiles: fanout.integration.overlappingFiles,
                execFile: execFileFn,
            });

            for (const result of results) {
                if (result.status === 'skipped') continue;

                if (result.status === 'merged') {
                    merged.push(result.branch);
                    patchIntegrationFn(cwd, parentSlug, (current) => ({
                        merged: [...current.merged, result.branch],
                    }));
                    logIntegration(`- Merged \`${result.branch}\` cleanly.`);
                    continue;
                }

                // status === 'conflict'
                logIntegration(`- Conflict merging \`${result.branch}\`; entering repair.`);
                patchIntegrationFn(cwd, parentSlug, { state: 'repairing' });

                const conflicted = conflictedFilesFn({ cwd: worktree.worktreePath, execFile: execFileFn });
                const involvedWorkers = fanout.workers
                    .filter((worker) => worker.branch === result.branch)
                    .map(({ id, title, subtask, area }) => ({ id, title, subtask, area }));

                jobPatch({ phase: 'integrate', stage: 'integrator', round: null });
                const integratorArgs = integratorAgentArgs({
                    prompt: `Resolve the merge conflict from combining \`${result.branch}\` into the integration branch for "${fanout.task}".`,
                    cwd: worktree.worktreePath,
                    conflictedFiles: conflicted,
                    mergeOutput: result.output,
                    involvedWorkers,
                });
                const integratorAgent = new AgentClass(
                    'integrator',
                    integratorArgs.instructions,
                    integratorArgs.prompt,
                    integratorArgs.options,
                );

                let integratorOk = false;
                try {
                    const integratorOut = await integratorAgent.run({ verbose });
                    await jobCheckpoint();
                    const { summary: integratorSummary } = splitStageSummary(integratorOut.result);
                    printStageSummary('integrator', integratorSummary);
                    integratorOk = Boolean(integratorOut.ok);
                } catch (err) {
                    logIntegration(`- Integrator agent errored: ${err.message}`);
                    integratorOk = false;
                }

                const stillConflicted = integratorOk
                    ? hasConflictMarkersFn({ cwd: worktree.worktreePath, execFile: execFileFn })
                    : true;

                if (!stillConflicted) {
                    execFileFn('git', ['-C', worktree.worktreePath, 'commit']);
                    merged.push(result.branch);
                    patchIntegrationFn(cwd, parentSlug, (current) => ({
                        merged: [...current.merged, result.branch],
                    }));
                    logIntegration(`- Integrator resolved conflicts in \`${result.branch}\`; merge completed.`);
                } else {
                    abortMergeFn({ cwd: worktree.worktreePath, execFile: execFileFn });
                    skipped.push(result.branch);
                    patchIntegrationFn(cwd, parentSlug, (current) => ({
                        skipped: [...(current.skipped ?? []), result.branch],
                    }));
                    logIntegration(`- Conflicts in \`${result.branch}\` remained unresolved; aborted merge and skipped.`);
                }
            }

            remaining = remaining.slice(results.length);
        }

        // --- runner-first verify loop: test-runner first, code-writer only on failure ---
        await runCodeLoop({
            prompt: fanout.task,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            taskPath: path.join(integrationDir, 'task.md'),
            statusPath: integrationMdPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
            acceptedVerification: '',
            runnerFirst: true,
            loopTitle: 'Verify loop',
        });

        jobPatch({ phase: 'commit', stage: 'commit', round: null });
        const message = `orch: ${parentSlug} ${fanout.task.split('\n')[0]}`;
        const commitResult = commitWorktreeFn({
            worktreePath: worktree.worktreePath,
            branch: `orch/${parentSlug}`,
            message,
        });

        logIntegration(
            commitResult.committed
                ? `- Committed \`${commitResult.sha}\` on \`${commitResult.branch}\`.`
                : `- No changes to commit on \`${commitResult.branch}\`.`,
        );

        patchIntegrationFn(cwd, parentSlug, {
            state: 'done',
            sha: commitResult.sha,
            merged,
            skipped,
        });
        jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        try {
            logIntegration(`- Error: ${err.message}`);
        } catch {
            // Best-effort: don't let a log write failure mask the real error.
        }
        try {
            patchIntegrationFn(cwd, parentSlug, { state: 'failed', merged, skipped });
        } catch {
            // Best-effort: don't let a fanout-state write failure mask the real error.
        }
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sentinel thrown by the coordinator's scheduling loop when a SIGINT/SIGTERM/SIGHUP
 * cascade fires mid-flight, so the pending awaits unwind without a second exit call. */
class FanoutInterrupted extends Error {}

/**
 * SIGINT/SIGHUP/SIGTERM cascade: reads `fanout.json`, resolves every worker's and the
 * integration session's own pid via its `run.json`, filters through `isPidAlive`, and
 * SIGTERMs each live one. Never touches worktrees. Composes with (does not replace)
 * `lib/agent.js`'s existing `shutdown()` — the coordinator's own signal handling calls
 * both this and the normal in-process agent-CLI reaping.
 */
export function cascadeStopFanoutChildren(cwd, parentSlug, { kill = (pid, signal) => process.kill(pid, signal), isPidAlive: isPidAliveFn = isPidAlive } = {}) {
    const fanout = readFanout(cwd, parentSlug);
    if (!fanout) return;

    const slugs = fanout.workers.filter((worker) => worker.slug).map((worker) => worker.slug);
    if (fanout.integration?.slug) slugs.push(fanout.integration.slug);

    for (const slug of slugs) {
        const record = readJob(cwd, slug);
        if (!record) continue;
        if (isPidAliveFn(record.pid)) {
            kill(record.pid, 'SIGTERM');
        }
    }
}

/**
 * The `--fan-out` coordinator: triage → boundaries → decompose → schedule workers →
 * overlap detection → spawn integrate → report. Never creates its own worktree or runs
 * implementer stages itself — those only happen on the decline path (today's
 * single-worktree pipeline, reusing `runTestLoop`/`runCodeLoop`) or inside spawned
 * children. See `.spec/fanout-3-coordinator.md` and `.spec/fanout.md`.
 */
export async function runFanoutPipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const maxWorkers = options.maxWorkers ?? 4;
    const maxConcurrency = options.maxConcurrency ?? null;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const invocationCwd = options.cwd ?? process.cwd();

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const spawnFn = options.spawn ?? spawn;
    const execFileFn = options.execFile ?? defaultExecFile;
    const allocateJobFn = options.allocateJob ?? allocateJob;
    const reconcileJobFn = options.reconcileJob ?? reconcileJob;
    const readFanoutFn = options.readFanout ?? readFanout;
    const writeFanoutFn = options.writeFanout ?? writeFanout;
    const patchWorkerFn = options.patchWorker ?? patchWorker;
    const patchIntegrationFn = options.patchIntegration ?? patchIntegration;
    const exitFn = options.exit ?? ((code) => process.exit(code));
    const pollIntervalMs = options.pollIntervalMs ?? 500;

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

    if (!options.AgentClass) {
        ensureBinaryOnPath(backend.binary, options.agent);
    }

    console.log(`cwd:   ${invocationCwd}`);
    console.log(`agent: ${options.agent}`);
    console.log();

    let interrupted = false;
    const onSignal = (signal) => {
        interrupted = true;
        try {
            cascadeStopFanoutChildren(invocationCwd, jobSlug);
        } catch {
            // Best-effort: never let the cascade itself block shutdown.
        }
        if (jobSlug) {
            try {
                patchJobFn(jobCwd, jobSlug, {
                    state: 'stopped',
                    exitCode: exitCodeForSignal(signal),
                    finishedAt: new Date().toISOString(),
                });
            } catch {
                // Best-effort: don't let a job-state write failure block shutdown.
            }
        }
        exitFn(exitCodeForSignal(signal));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGHUP', () => onSignal('SIGHUP'));

    try {
        jobPatch({ phase: 'triage', stage: 'triage', round: null });
        const triage = triageAgentArgs({ prompt, cwd: invocationCwd });
        const triageAgent = new AgentClass(triage.name, triage.instructions, triage.prompt, triage.options);
        const triageResult = await triageAgent.run({ verbose });
        await jobCheckpoint();
        const { content: triageContent, summary: triageSummary } = splitStageSummary(triageResult.result);
        printStageSummary('triage', triageSummary);
        const parsed = parseTriageJson(triageContent);

        if (parsed?.simple === true) {
            console.log('triage: simple — fan-out skipped (quick-fix)');
            jobPatch({ phase: 'quick-fix', stage: 'quick-fix', round: null });
            const quickFix = quickFixAgentArgs({ prompt, cwd: invocationCwd, fix_plan: parsed.fix_plan });
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
            exitFn(0);
            return;
        }

        console.log('triage: complex — fan-out requested');

        // --- boundaries: partitionability research only, runs exactly once ---
        const boundariesPath = path.join(jobCwd, '.orch', jobSlug, 'boundaries.md');
        jobPatch({ phase: 'boundaries', stage: 'boundaries', round: null });
        const boundaries = boundariesAgentArgs({ prompt, cwd: invocationCwd, boundariesPath });
        const boundariesAgent = new AgentClass(boundaries.name, boundaries.instructions, boundaries.prompt, boundaries.options);
        const boundariesResult = await boundariesAgent.run({ verbose });
        await jobCheckpoint();
        const { content: boundariesOutput, summary: boundariesSummary } = splitStageSummary(boundariesResult.result);
        printStageSummary('boundaries', boundariesSummary);
        console.log(`boundaries: ${boundariesSummary || 'done'}`);

        // --- decomposer: up to two repair round-trips on validation failure ---
        let feedback;
        let decision = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            jobPatch({ phase: 'decompose', stage: 'decomposer', round: attempt });
            const decomposer = decomposerAgentArgs({
                prompt, cwd: invocationCwd, boundariesOutput, maxWorkers, feedback,
            });
            const decomposerAgent = new AgentClass(decomposer.name, decomposer.instructions, decomposer.prompt, decomposer.options);
            const decomposerResult = await decomposerAgent.run({ verbose });
            await jobCheckpoint();
            const { content: decomposerContent, summary: decomposerSummary } = splitStageSummary(decomposerResult.result);
            printStageSummary('decomposer', decomposerSummary);

            const parsedDecomposition = parseDecomposition(decomposerContent);
            if (!parsedDecomposition) {
                feedback = ['decomposer output was not valid JSON'];
                if (attempt === 3) decision = { decline: true, why: 'decomposer did not return valid JSON after repair attempts' };
                continue;
            }
            if (parsedDecomposition.decomposable === false) {
                decision = { decline: true, why: parsedDecomposition.why };
                break;
            }

            const violations = validateDecomposition(parsedDecomposition, { maxWorkers });
            if (violations.length === 0) {
                decision = { decline: false, decomposition: parsedDecomposition };
                break;
            }
            feedback = violations;
            if (attempt === 3) {
                decision = { decline: true, why: `decomposition still invalid after repairs: ${violations.join('; ')}` };
            }
        }

        if (decision.decline) {
            console.log(`decomposer: declined — ${decision.why}`);
            console.log('falling through to the single-worktree pipeline');

            const runContext = createRunContextFn(jobSlug ? { cwd: invocationCwd, slug: jobSlug } : { cwd: invocationCwd });

            jobPatch({ phase: 'research', stage: 'research', round: null });
            const research = researchAgentArgs({ prompt, cwd: invocationCwd, researchPath: runContext.researchPath });
            const researchAgent = new AgentClass(research.name, research.instructions, research.prompt, research.options);
            const researchResult = await researchAgent.run({ verbose });
            await jobCheckpoint();
            const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
            printStageSummary('research', researchSummary);

            jobPatch({ phase: 'plan', stage: 'planner', round: null });
            const planner = plannerAgentArgs({
                prompt, cwd: invocationCwd, researchPath: runContext.researchPath, taskPath: runContext.taskPath, researchOutput: researchContent,
            });
            const plannerAgent = new AgentClass(planner.name, planner.instructions, planner.prompt, planner.options);
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

            const testAccepted = await runTestLoop({
                prompt,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                maxRounds,
                AgentClass,
                verbose,
                jobPatch,
                jobCheckpoint,
            });

            const acceptedVerification = [testAccepted.verdict.summary, testAccepted.writerContent].filter(Boolean).join('\n');

            await runCodeLoop({
                prompt,
                worktreePath: worktree.worktreePath,
                branch: worktree.branch,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                maxRounds,
                AgentClass,
                verbose,
                jobPatch,
                jobCheckpoint,
                acceptedVerification,
            });

            jobPatch({ phase: 'commit', stage: 'commit', round: null });
            const message = `orch: ${runContext.slug} ${prompt.split('\n')[0]}`;
            const worktreeChanges = collectWorktreeChangesFn({ worktreePath: worktree.worktreePath });
            printFilesChanged(worktreeChanges);
            const commitResult = commitWorktreeFn({ worktreePath: worktree.worktreePath, branch: worktree.branch, message });

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
            exitFn(0);
            return;
        }

        // --- validated: bootstrap fanout.json, never give the coordinator a worktree ---
        const { decomposition } = decision;
        const base = execFileFn('git', ['-C', invocationCwd, 'rev-parse', 'HEAD']).trim();

        const workers = decomposition.workers.map((worker) => ({
            id: worker.id,
            title: worker.title,
            subtask: worker.scaffold ? ensureScaffoldSubtask(worker.subtask) : worker.subtask,
            area: worker.area,
            owns: worker.owns ?? [],
            dependsOn: worker.dependsOn ?? [],
            scaffold: Boolean(worker.scaffold),
            slug: null,
            branch: null,
            state: 'pending',
            sha: null,
            changedFiles: [],
            overlaps: [],
        }));

        writeFanoutFn(invocationCwd, jobSlug, {
            parentSlug: jobSlug,
            task: prompt,
            base,
            maxWorkers,
            maxConcurrency,
            concurrency: workers.length,
            state: 'running',
            workers,
            integration: {
                slug: null,
                pid: null,
                branch: null,
                worktree: null,
                candidates: [],
                merged: [],
                skipped: [],
                overlappingFiles: [],
                state: 'pending',
                sha: null,
            },
            startedAt: new Date().toISOString(),
            finishedAt: null,
        });

        console.log(`decomposer: split into ${workers.length} worker${workers.length === 1 ? '' : 's'}`);

        const spawnWorkerChild = (worker) => {
            const siblingTitles = workers.filter((w) => w.id !== worker.id).map((w) => w.title).filter(Boolean);
            const envelope = buildWorkerEnvelope({
                subtask: worker.subtask, area: worker.area, scaffold: worker.scaffold, siblingTitles,
            });
            const workerPrompt = `${worker.subtask}\n\n${envelope}`;

            const { slug: workerSlug } = allocateJobFn({
                cwd: invocationCwd,
                prompt: workerPrompt,
                agent: options.agent,
                maxRounds,
                state: 'starting',
                parent: jobSlug,
                role: 'worker',
                workerId: worker.id,
            });
            patchWorkerFn(invocationCwd, jobSlug, worker.id, {
                slug: workerSlug,
                branch: `orch/${workerSlug}`,
                state: 'running',
            });

            const { logPath } = jobPaths(invocationCwd, workerSlug);
            const logFd = fs.openSync(logPath, 'a');
            const childArgs = [
                __filename, workerPrompt,
                '--agent', options.agent,
                '--max-rounds', String(maxRounds),
                '--worker', `${jobSlug}:${worker.id}`,
            ];
            const child = spawnFn(process.execPath, childArgs, {
                cwd: invocationCwd,
                env: { ...process.env, ORCH_JOB_SLUG: workerSlug, ORCH_DETACHED: '1', ORCH_FANOUT_DEPTH: '1' },
                detached: true,
                stdio: ['ignore', logFd, logFd],
            });
            child.unref();
            patchJobFn(invocationCwd, workerSlug, { pid: child.pid, state: 'running' });
            console.log(`[${worker.id} ${workerSlug}] running`);
            return workerSlug;
        };

        // A worker child self-patches its fanout.json entry to 'done'/'failed' the moment it
        // finishes (see runWorkerPipeline) — that is the primary settlement signal. reconcileJob
        // (dead-pid detection) is only consulted once a worker has been in-flight past a grace
        // period, so a worker that simply hasn't self-reported yet is never mistaken for a crash.
        const CRASH_CHECK_GRACE_MS = Math.max(pollIntervalMs * 10, 200);

        const settleWorker = (workerId, workerSlug, spawnedAt) => {
            const fanoutWorker = readFanoutFn(invocationCwd, jobSlug).workers.find((w) => w.id === workerId);
            if (fanoutWorker.state === 'done' || fanoutWorker.state === 'failed') {
                console.log(`[${workerId} ${workerSlug}] ${fanoutWorker.state}`);
                return true;
            }

            if (Date.now() - spawnedAt < CRASH_CHECK_GRACE_MS) return false;

            const record = reconcileJobFn(invocationCwd, workerSlug, readJob(invocationCwd, workerSlug));
            if (!TERMINAL_JOB_STATES.includes(record.state)) return false;

            if (fanoutWorker.state !== 'done' && fanoutWorker.state !== 'failed') {
                patchWorkerFn(invocationCwd, jobSlug, workerId, { state: 'failed' });
            }
            console.log(`[${workerId} ${workerSlug}] failed`);
            return true;
        };

        /** Spawns up to `concurrency` of `workerIds` at a time, polling to terminal state. */
        const runWorkerGroup = async (workerIds, concurrency) => {
            const byId = new Map(workers.map((w) => [w.id, w]));
            const pending = [...workerIds];
            const active = new Map();

            while (pending.length > 0 || active.size > 0) {
                while (active.size < concurrency && pending.length > 0) {
                    const id = pending.shift();
                    const workerSlug = spawnWorkerChild(byId.get(id));
                    active.set(id, { workerSlug, spawnedAt: Date.now() });
                }
                if (active.size === 0) break;

                await sleep(pollIntervalMs);
                if (interrupted) throw new FanoutInterrupted();

                for (const [id, { workerSlug, spawnedAt }] of [...active]) {
                    if (settleWorker(id, workerSlug, spawnedAt)) active.delete(id);
                }
            }
        };

        const scaffoldWorker = workers.find((w) => w.scaffold);
        let aborted = false;

        if (scaffoldWorker) {
            await runWorkerGroup([scaffoldWorker.id], 1);
            const scaffoldEntry = readFanoutFn(invocationCwd, jobSlug).workers.find((w) => w.id === scaffoldWorker.id);
            if (scaffoldEntry.state === 'done') {
                const current = readFanoutFn(invocationCwd, jobSlug);
                writeFanoutFn(invocationCwd, jobSlug, { ...current, base: scaffoldEntry.sha });
                console.log(`[${scaffoldWorker.id}] done — base updated to ${scaffoldEntry.sha.slice(0, 7)}`);
            } else {
                aborted = true;
                for (const worker of workers) {
                    if (worker.id === scaffoldWorker.id) continue;
                    patchWorkerFn(invocationCwd, jobSlug, worker.id, { state: 'skipped' });
                }
                console.log('scaffold worker failed; aborting fan-out before any parallel worker spawns');
            }
        }

        if (!aborted) {
            const remaining = workers.filter((w) => !scaffoldWorker || w.id !== scaffoldWorker.id);
            const forLayering = remaining.map((w) => ({
                ...w,
                dependsOn: (w.dependsOn || []).filter((dep) => !scaffoldWorker || dep !== scaffoldWorker.id),
            }));
            const layers = planLayers(forLayering);

            for (const layerIds of layers) {
                if (interrupted) throw new FanoutInterrupted();
                const currentDoc = readFanoutFn(invocationCwd, jobSlug);
                const byId = new Map(workers.map((w) => [w.id, w]));
                const toRun = [];
                for (const id of layerIds) {
                    const worker = byId.get(id);
                    const depFailed = (worker.dependsOn || []).some(
                        (dep) => currentDoc.workers.find((w) => w.id === dep)?.state === 'failed',
                    );
                    if (depFailed) {
                        patchWorkerFn(invocationCwd, jobSlug, id, { state: 'skipped' });
                        console.log(`[${id}] skipped — dependency failed`);
                    } else {
                        toRun.push(id);
                    }
                }
                if (toRun.length === 0) continue;

                const concurrency = chooseConcurrency({ layerSize: toRun.length, maxConcurrency });
                const currentForConcurrency = readFanoutFn(invocationCwd, jobSlug);
                writeFanoutFn(invocationCwd, jobSlug, { ...currentForConcurrency, concurrency });
                console.log(`schedule: concurrency ${concurrency}`);

                await runWorkerGroup(toRun, concurrency);
            }
        }

        // --- overlap detection + integration candidates ---
        const settledDoc = readFanoutFn(invocationCwd, jobSlug);
        const overlapUnion = detectOverlaps(settledDoc.workers);
        for (const worker of settledDoc.workers) {
            if (worker.overlaps && worker.overlaps.length > 0) {
                patchWorkerFn(invocationCwd, jobSlug, worker.id, { overlaps: worker.overlaps });
            }
        }
        console.log(`overlaps: ${overlapUnion.length > 0 ? overlapUnion.join(', ') : 'none'}`);

        const doneWorkers = settledDoc.workers.filter((w) => w.state === 'done');
        const failedWorkers = settledDoc.workers.filter((w) => w.state === 'failed');
        patchIntegrationFn(invocationCwd, jobSlug, {
            candidates: doneWorkers.map((w) => w.branch),
            overlappingFiles: overlapUnion,
        });

        let integrationDone = false;
        if (doneWorkers.length > 0) {
            const envelope = buildIntegrationEnvelope({
                task: prompt,
                branches: doneWorkers.map((w) => w.branch),
                overlappingFiles: overlapUnion,
            });

            const { slug: integrationSlug } = allocateJobFn({
                cwd: invocationCwd,
                prompt: envelope,
                agent: options.agent,
                maxRounds,
                state: 'starting',
                parent: jobSlug,
                role: 'integration',
            });
            patchIntegrationFn(invocationCwd, jobSlug, { slug: integrationSlug });

            const { logPath } = jobPaths(invocationCwd, integrationSlug);
            const logFd = fs.openSync(logPath, 'a');
            const childArgs = [
                __filename, envelope,
                '--agent', options.agent,
                '--max-rounds', String(maxRounds),
                '--integrate', jobSlug,
            ];
            const child = spawnFn(process.execPath, childArgs, {
                cwd: invocationCwd,
                env: { ...process.env, ORCH_JOB_SLUG: integrationSlug, ORCH_DETACHED: '1', ORCH_FANOUT_DEPTH: '1' },
                detached: true,
                stdio: ['ignore', logFd, logFd],
            });
            child.unref();
            patchJobFn(invocationCwd, integrationSlug, { pid: child.pid, state: 'running' });
            patchIntegrationFn(invocationCwd, jobSlug, { pid: child.pid });
            console.log(`[integrate ${integrationSlug}] running`);

            const integrateSpawnedAt = Date.now();
            for (;;) {
                await sleep(pollIntervalMs);
                if (interrupted) throw new FanoutInterrupted();

                const integrationState = readFanoutFn(invocationCwd, jobSlug).integration.state;
                if (integrationState === 'done') { integrationDone = true; break; }
                if (integrationState === 'failed') break;

                if (Date.now() - integrateSpawnedAt < CRASH_CHECK_GRACE_MS) continue;
                const record = reconcileJobFn(invocationCwd, integrationSlug, readJob(invocationCwd, integrationSlug));
                if (TERMINAL_JOB_STATES.includes(record.state)) {
                    if (record.state === 'done') integrationDone = true;
                    else patchIntegrationFn(invocationCwd, jobSlug, (current) => (current.state === 'done' ? {} : { state: 'failed' }));
                    break;
                }
            }

            const finalIntegration = readFanoutFn(invocationCwd, jobSlug).integration;
            if (finalIntegration.state === 'done' && finalIntegration.sha) {
                console.log(`[integrate ${integrationSlug}] merged ${doneWorkers.length} branch${doneWorkers.length === 1 ? '' : 'es'}`);
                console.log(`commit: ${finalIntegration.sha.slice(0, 7)} on ${finalIntegration.branch ?? `orch/${jobSlug}`}`);
                console.log(`merge:  git merge ${finalIntegration.branch ?? `orch/${jobSlug}`}`);
            } else {
                console.log(`[integrate ${integrationSlug}] failed`);
            }
        } else {
            console.log('no worker reached done; skipping integration');
        }

        const finalDoc = readFanoutFn(invocationCwd, jobSlug);
        const success = failedWorkers.length === 0 && integrationDone && Boolean(finalDoc.integration.sha);
        writeFanoutFn(invocationCwd, jobSlug, {
            ...finalDoc,
            state: success ? 'done' : 'failed',
            finishedAt: new Date().toISOString(),
        });

        if (failedWorkers.length > 0) {
            console.log(`${failedWorkers.length} worker${failedWorkers.length === 1 ? '' : 's'} failed: ${failedWorkers.map((w) => w.id).join(', ')}`);
            console.log(`retry integration after fixing it: orch --integrate ${jobSlug}`);
        }

        jobPatch({ state: success ? 'done' : 'failed', exitCode: success ? 0 : 1, finishedAt: new Date().toISOString() });
        exitFn(success ? 0 : 1);
    } catch (err) {
        if (err instanceof FanoutInterrupted) return;
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
        exitFn(1);
    }
}

/** Splits `--worker`'s `<parent-slug>:<worker-id>` value on the first colon. */
function splitParentWorker(value) {
    const idx = value.indexOf(':');
    if (idx === -1) return { parentSlug: null, workerId: null };
    return { parentSlug: value.slice(0, idx), workerId: value.slice(idx + 1) };
}

/** CLI glue for `--worker`: resolves the parent fan-out/worker record, builds the worker
 * envelope, allocates (or reuses) the job record, then calls `runWorkerPipeline`. */
async function runWorkerFromCli(options) {
    const cwd = process.cwd();
    const { parentSlug, workerId } = splitParentWorker(options.worker);
    if (!parentSlug || !workerId) {
        console.error(`Error: --worker must be in the form <parent-slug>:<worker-id>, got "${options.worker}"`);
        process.exit(1);
        return;
    }

    // ORCH_FANOUT_DEPTH guards against a future --fan-out spawning nested fan-outs.
    process.env.ORCH_FANOUT_DEPTH = '1';

    const fanout = readFanout(cwd, parentSlug);
    if (!fanout) {
        console.error(`Error: unknown parent ${parentSlug} (no fanout.json found)`);
        process.exit(1);
        return;
    }

    const worker = fanout.workers.find((w) => w.id === workerId);
    if (!worker) {
        console.error(`Error: unknown worker ${workerId} in ${parentSlug}`);
        process.exit(1);
        return;
    }

    const siblingTitles = fanout.workers
        .filter((w) => w.id !== workerId)
        .map((w) => w.title)
        .filter(Boolean);
    const envelope = buildWorkerEnvelope({
        subtask: worker.subtask,
        area: worker.area,
        scaffold: worker.scaffold,
        siblingTitles,
    });
    const workerPrompt = `${worker.subtask}\n\n${envelope}`;

    let jobSlug = process.env.ORCH_JOB_SLUG;
    if (!jobSlug) {
        const alloc = allocateJob({
            cwd,
            prompt: workerPrompt,
            agent: options.agent,
            maxRounds: options.maxRounds,
            state: 'running',
            pid: process.pid,
            parent: parentSlug,
            role: 'worker',
            workerId,
        });
        jobSlug = alloc.slug;
    }
    setJobSlug(jobSlug);

    await runWorkerPipeline(workerPrompt, {
        agent: options.agent,
        maxRounds: options.maxRounds,
        verbose: options.verbose,
        cwd,
        parentSlug,
        workerId,
        base: fanout.base,
        jobSlug,
        jobCwd: cwd,
    });
}

/** CLI glue for `--integrate`: resolves the parent fan-out, allocates (or reuses) the
 * integration job record, then calls `runIntegratePipeline`. */
async function runIntegrateFromCli(options) {
    const cwd = process.cwd();
    const parentSlug = options.integrate;

    // ORCH_FANOUT_DEPTH guards against a future --fan-out spawning nested fan-outs.
    process.env.ORCH_FANOUT_DEPTH = '1';

    const fanout = readFanout(cwd, parentSlug);
    if (!fanout) {
        console.error(`Error: unknown parent ${parentSlug} (no fanout.json found)`);
        process.exit(1);
        return;
    }

    let jobSlug = process.env.ORCH_JOB_SLUG;
    if (!jobSlug) {
        const alloc = allocateJob({
            cwd,
            prompt: fanout.task,
            agent: options.agent,
            maxRounds: options.maxRounds,
            state: 'running',
            pid: process.pid,
            parent: parentSlug,
            role: 'integration',
        });
        jobSlug = alloc.slug;
    }
    setJobSlug(jobSlug);

    await runIntegratePipeline({
        agent: options.agent,
        maxRounds: options.maxRounds,
        verbose: options.verbose,
        cwd,
        parentSlug,
        jobSlug,
        jobCwd: cwd,
    });
}

/** Commander option parser shared by `--max-rounds`, `--max-workers`, and `--max-concurrency`. */
function positiveIntParser(flagName) {
    return (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error(`${flagName} must be a positive integer`);
        }
        return n;
    };
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
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop (ignored with --ask and --quick)', positiveIntParser('--max-rounds'), 5)
    .option('--fan-out', 'Decompose the task into parallel workers coordinated by this process (see README Fan-out section). Cannot be combined with --ask, --quick, or --dry-run')
    .option('--max-workers <n>', 'Max number of parallel fan-out workers (only meaningful with --fan-out)', positiveIntParser('--max-workers'), 4)
    .option('--max-concurrency <n>', 'Optional hard ceiling on in-flight fan-out workers at once (only meaningful with --fan-out; default: coordinator chooses)', positiveIntParser('--max-concurrency'))
    .addOption(
        new Option('--agent <agent>', 'Agent backend to run the pipeline with: "cursor" (Cursor Agent CLI), "claude" (Claude Code CLI), or "agn" (agn CLI)')
            .choices(['cursor', 'claude', 'agn'])
            .default('cursor'),
    )
    .addOption(new Option('--worker <value>', 'internal: run a single fan-out worker "<parent-slug>:<worker-id>"').hideHelp())
    .addOption(new Option('--integrate <value>', 'internal: (re)run fan-out integration for "<parent-slug>"').hideHelp())
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

Fan-out:
  $ orch "implement the billing module" --fan-out --agent claude   # triage, decompose, run parallel workers, integrate
  $ orch "implement X" --fan-out --max-workers 6 --max-concurrency 3
`,
    )
    .action(async (task, options) => {
        const prompt = task.join(' ').trim();
        if (!prompt) {
            console.error('Error: task cannot be empty');
            process.exit(1);
            return;
        }

        if (options.fanOut) {
            const conflicts = ['ask', 'quick', 'dryRun']
                .filter((key) => options[key])
                .map((key) => `--${key === 'dryRun' ? 'dry-run' : key}`);
            if (conflicts.length > 0) {
                console.error(`Error: --fan-out cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            if (process.env.ORCH_FANOUT_DEPTH) {
                console.error('Error: --fan-out cannot be used inside a fan-out child (ORCH_FANOUT_DEPTH is already set)');
                process.exit(1);
                return;
            }

            const cwd = process.cwd();
            const { slug } = allocateJob({
                cwd,
                prompt,
                agent: options.agent,
                maxRounds: options.maxRounds,
                state: 'running',
                pid: process.pid,
                role: 'coordinator',
            });
            setJobSlug(slug);

            await runFanoutPipeline(prompt, {
                ...options,
                cwd,
                jobSlug: slug,
                jobCwd: cwd,
                maxWorkers: options.maxWorkers,
                maxConcurrency: options.maxConcurrency ?? null,
            });
            return;
        }

        if (options.worker || options.integrate) {
            const flagName = options.worker ? '--worker' : '--integrate';
            const conflicts = ['ask', 'quick', 'detach', 'dryRun']
                .filter((key) => options[key])
                .map((key) => `--${key === 'dryRun' ? 'dry-run' : key}`);
            if (conflicts.length > 0) {
                console.error(`Error: ${flagName} cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }

            if (options.worker) {
                await runWorkerFromCli(options);
            } else {
                await runIntegrateFromCli(options);
            }
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

        if (!options.dryRun) {
            const { slug } = allocateJob({
                cwd: process.cwd(),
                prompt,
                agent: options.agent,
                maxRounds: options.ask || options.quick ? null : options.maxRounds,
                state: 'running',
                pid: process.pid,
            });
            options.jobSlug = slug;
            setJobSlug(slug);
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
