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
import { AgentOpencode } from './lib/agent-opencode.js';
import { parseTriageJson } from './lib/parse-triage-json.js';
import { parseVerdict } from './lib/parse-verdict.js';
import { splitStageSummary, printStageSummary, resolveStageSummary } from './lib/stage-summary.js';
import { createRunContext } from './lib/run-context.js';
import { createWorktree } from './lib/worktree.js';
import { commitWorktree, collectWorktreeChanges, printFilesChanged } from './lib/commit.js';
import {
    resolveBaseBranch,
    fetchBase,
    publish as realPublish,
} from './lib/publish.js';
import { buildPrTitle, buildPrBody } from './lib/pr-body.js';
import { FileTracker } from './lib/file-tracker.js';
import { allocateJob } from './lib/job-lifecycle.js';
import { setJobSlug, exitCodeForSignal, formatElapsed, flushFailureLog, beginStageCapture } from './lib/agent.js';
import {
    jobPaths,
    readJob,
    patchJob,
    listJobs,
    reconcileJob,
    checkpointPause,
    requestPause,
    requestResume,
    cascadePause,
    cascadeResume,
    stopJob,
    cleanJobs,
    liveSlugsBlockingClean,
    isPidAlive,
    reopenJob,
    buildLastOutcome,
} from './lib/jobs.js';
import {
    recordAskExchange,
    readAskSession,
    buildAskFollowUpPrompt,
} from './lib/ask-session.js';
import {
    validateContinue,
    snapshotPriorOutcome,
    buildPriorOutcomeText,
} from './lib/continue.js';
import {
    validateResume,
    reopenForResume,
    runRecover,
} from './lib/resume.js';
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
import { seqDecomposerAgentArgs, decomposeAgentArgs } from './agents/seq-decomposer.js';
import { adjustAgentArgs } from './agents/adjust.js';
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
import {
    readSeq,
    writeSeq,
    patchUnit,
    patchTip,
    appendAdjustment,
    validateSeqDecomposition,
    buildUnitEnvelope,
    validateAdjustResult,
    applyAdjustResult,
} from './lib/seq.js';
import { parseDecomposition } from './lib/parse-decomposition.js';
import {
    mergeBranches,
    abortMerge,
    conflictedFiles,
    hasConflictMarkers,
} from './lib/integrate.js';
import {
    resolveAgent,
    resolveNotify,
    writeConfig,
    printConfig,
    globalConfigPath,
    localConfigPath,
} from './lib/config.js';
import { setNotifyEnabled } from './lib/notify.js';

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
    opencode: {
        AgentClass: AgentOpencode,
        binary: 'opencode',
        missingHint:
            'opencode not found; install OpenCode (https://opencode.ai) or use --agent cursor',
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

/** Require `gh` on PATH and authenticated. Used before allocateJob when `--pr`. */
function ensureGhAuthenticated() {
    if (!isBinaryOnPath('gh')) {
        console.error('gh not found; install the GitHub CLI (https://cli.github.com) to use --pr');
        process.exit(1);
    }
    try {
        execFileSync('gh', ['auth', 'status'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        const detail = String(err.stderr || err.message || '').trim();
        console.error(
            detail
                ? `gh is not authenticated: ${detail}`
                : 'gh is not authenticated; run gh auth login',
        );
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

function displayJobRole(role) {
    if (role === 'integration') return 'integrate';
    if (role == null) return '-';
    return role;
}

/** Workers first (startedAt ascending), then the integration child last. */
function compareFanoutChildren(a, b) {
    const aIntegrate = a.role === 'integration' ? 1 : 0;
    const bIntegrate = b.role === 'integration' ? 1 : 0;
    if (aIntegrate !== bIntegrate) return aIntegrate - bIntegrate;
    return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
}

export function formatJobsTable(jobs) {
    const header = ['SLUG', 'ROLE', 'STATE', 'PHASE', 'AGENT', 'STARTED', 'DURATION', 'PID'];
    const childrenByParent = new Map();
    const topLevel = [];
    for (const job of jobs) {
        if (job.parent) {
            if (!childrenByParent.has(job.parent)) childrenByParent.set(job.parent, []);
            childrenByParent.get(job.parent).push(job);
        } else {
            topLevel.push(job);
        }
    }
    topLevel.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const ordered = [];
    for (const parent of topLevel) {
        ordered.push({ job: parent, indent: '' });
        const children = (childrenByParent.get(parent.slug) || []).slice().sort(compareFanoutChildren);
        for (const child of children) ordered.push({ job: child, indent: '  ' });
    }

    const rows = ordered.map(({ job, indent }) => [
        `${indent}${job.slug ?? '-'}`,
        displayJobRole(job.role),
        job.state ?? '-',
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

/** Status / list `next:` hint per `.spec/resume.md` decision 28. */
function nextHintForRecord(record) {
    if (!record) return null;
    if (record.state === 'paused' || record.state === 'pausing') {
        return `orch resume ${record.slug}`;
    }
    if (record.state === 'failed' || record.state === 'stopped' || record.state === 'crashed') {
        return `orch resume ${record.slug}`;
    }
    if (record.state === 'done') {
        return `orch continue ${record.slug} "<follow-up>"`;
    }
    return null;
}

export function formatStatus(cwd, record) {
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

    if (record.base) {
        lines.push(`base:     ${record.base}`);
    }
    if (record.prUrl) {
        lines.push(`pr:       ${record.prUrl}`);
    }

    if (record.parent) {
        lines.splice(1, 0, `parent:   ${record.parent}`);
    }

    if (record.continuation > 1) {
        const stateIdx = lines.findIndex((line) => line.startsWith('state:'));
        lines.splice(stateIdx + 1, 0, `continuation: ${record.continuation}`);
    }

    if (record.lastOutcome) {
        const o = record.lastOutcome;
        lines.push(`outcome:  ${o.phase ?? '-'} / ${o.stage ?? '-'} (round ${o.round ?? '-'})`);
        if (o.summary) lines.push(`summary:  ${o.summary}`);
        if (o.error) lines.push(`error:    ${o.error}`);
    }

    const statusPath = path.join(jobPaths(cwd, record.slug).dir, 'status.md');
    if (fs.existsSync(statusPath)) {
        const last = lastNonEmptyLine(fs.readFileSync(statusPath, 'utf8'));
        if (last) lines.push(`status:   ${last}`);
    }

    const nextHint = nextHintForRecord(record);
    if (nextHint) lines.push(`next:     ${nextHint}`);

    // Child view: parent line only — do not expand siblings.
    // Read children from disk without reconcile so status reflects recorded
    // state/phase/branch (listJobs would rewrite dead-pid live states to crashed).
    if (!record.parent) {
        const orchDir = path.join(path.resolve(cwd), '.orch');
        const children = [];
        if (fs.existsSync(orchDir)) {
            for (const name of fs.readdirSync(orchDir)) {
                const child = readJob(cwd, name);
                if (child?.parent === record.slug) children.push(child);
            }
        }
        children.sort(compareFanoutChildren);
        if (record.role === 'coordinator' || children.length > 0) {
            for (const child of children) {
                lines.push(`  ${child.slug}  ${child.state}  ${child.phase ?? '-'}  ${child.branch ?? '-'}`);
            }
        }
    }

    return lines.join('\n');
}

/** True when pause/resume/stop should cascade to children. */
function isCascadeParent(cwd, record) {
    if (record?.role === 'coordinator') return true;
    return listJobs(cwd).some((job) => job.parent === record.slug);
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

/** Patch a job to a terminal state and write a matching `lastOutcome` in the same write. */
function patchTerminalJob(patchJobFn, jobCwd, jobSlug, { state, exitCode, summary = '', error = null, task }) {
    if (!jobSlug) return null;
    const finishedAt = new Date().toISOString();
    let outcomeError = error;
    if (state === 'failed') {
        const pointer = flushFailureLog({
            cwd: jobCwd,
            slug: jobSlug,
            state,
            exitCode,
            finishedAt,
            task,
            error,
        });
        if (pointer) {
            outcomeError = pointer;
            console.error(`error:    ${pointer}`);
        }
    }
    patchJobFn(jobCwd, jobSlug, (current) => ({
        state,
        exitCode,
        finishedAt,
        lastOutcome: buildLastOutcome({
            state,
            phase: current.phase,
            stage: current.stage,
            round: current.round,
            exitCode,
            finishedAt,
            task: task ?? current.task,
            summary,
            error: outcomeError,
        }),
    }));
    return outcomeError;
}

/** Patch live cursor fields and start stage-verbose capture when a job is active. */
function patchJobCursor(patchJobFn, jobCwd, jobSlug, fields) {
    if (!jobSlug) return;
    if ('phase' in fields || 'stage' in fields) {
        beginStageCapture({
            phase: fields.phase ?? null,
            stage: fields.stage ?? null,
            round: 'round' in fields ? fields.round : null,
        });
    }
    return patchJobFn(jobCwd, jobSlug, fields);
}

/** The test-writer ⇄ test-critic loop shared by `runPipeline` and `runWorkerPipeline`. */
async function runTestLoop({
    prompt,
    worktreePath,
    branch,
    researchPath,
    taskPath,
    statusPath,
    maxRounds,
    AgentClass,
    verbose,
    jobPatch,
    jobCheckpoint,
    startAt = null,
}) {
    let testAccepted = null;
    let criticFeedback = null;
    let testRound = 0;
    let testSummary = '';

    // Resume at recorded round; always re-run writer for that round (need output for critic).
    const startRound = Math.max(1, Number(startAt?.round) || 1);

    for (let round = startRound; round <= maxRounds; round++) {
        testRound = round;

        jobPatch({ phase: 'test-loop', stage: 'test-writer', round });
        const testWriterArgs = testWriterAgentArgs({
            prompt,
            cwd: worktreePath,
            worktreePath,
            branch,
            researchPath,
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
            resolveStageSummary(roundLabel('test-writer', round, maxRounds), testWriterSummary, testWriterContent),
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
            researchPath,
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
        printStageSummary(
            roundLabel('test-critic', round, maxRounds),
            resolveStageSummary(roundLabel('test-critic', round, maxRounds), testCriticSummary, testCriticContent),
        );
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
    researchPath,
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
    startAt = null,
}) {
    let codeAccepted = null;
    let runnerFeedback = null;
    let codeRound = 0;
    let codeSummary = '';
    let codeWriterContent = null;

    const startRound = Math.max(1, Number(startAt?.round) || 1);
    // When resuming at test-runner, skip writer once for that round (runner-first style).
    let resumeSkipWriter = startAt?.stage === 'test-runner';

    for (let round = startRound; round <= maxRounds; round++) {
        codeRound = round;
        const skipWriter = (runnerFirst && round === 1) || (resumeSkipWriter && round === startRound);
        if (resumeSkipWriter && round === startRound) resumeSkipWriter = false;

        if (!skipWriter) {
            jobPatch({ phase: 'code-loop', stage: 'code-writer', round });
            const codeWriterArgs = codeWriterAgentArgs({
                prompt,
                cwd: worktreePath,
                worktreePath,
                branch,
                researchPath,
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
                resolveStageSummary(roundLabel('code-writer', round, maxRounds), summary, content),
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
            researchPath,
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
        printStageSummary(
            roundLabel('test-runner', round, maxRounds),
            resolveStageSummary(roundLabel('test-runner', round, maxRounds), testRunnerSummary, testRunnerContent),
        );
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

/**
 * Commit worktree changes and, when `pr` is set and the commit landed,
 * write pr.md, publish, and patch job/status. Shared by the complex path
 * and the abbreviated simple+`--pr` path.
 */
function commitAndMaybePublish({
    prompt,
    runContext,
    worktree,
    resolvedBase,
    pr,
    agent,
    jobPatch,
    collectWorktreeChangesFn,
    commitWorktreeFn,
    publishFn,
}) {
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

        if (pr) {
            jobPatch({ phase: 'publish', stage: 'publish', round: null });
            const plan = fs.existsSync(runContext.taskPath)
                ? fs.readFileSync(runContext.taskPath, 'utf8')
                : '';
            const bodyPath = path.join(runContext.artifactDir, 'pr.md');
            fs.writeFileSync(
                bodyPath,
                buildPrBody({
                    task: prompt,
                    plan,
                    changes: worktreeChanges,
                    slug: runContext.slug,
                    agent,
                    version,
                }),
            );
            const prResult = publishFn({
                worktreePath: worktree.worktreePath,
                remote: 'origin',
                branch: worktree.branch,
                base: resolvedBase,
                title: buildPrTitle(prompt),
                bodyPath,
            });
            jobPatch({
                pushedAt: new Date().toISOString(),
                prUrl: prResult.url,
                prNumber: prResult.number,
            });
            fs.appendFileSync(
                runContext.statusPath,
                `\n## Pull request\n\n- ${prResult.url}\n`,
            );
            console.log(`pr:     ${prResult.url}`);
        } else {
            console.log(`merge:  git merge ${commitResult.branch}`);
        }
        console.log(`next:   orch continue ${runContext.slug} "…"`);
    } else {
        fs.appendFileSync(
            runContext.statusPath,
            `\n## Commit\n\n- No changes to commit on \`${commitResult.branch}\`.\n`,
        );
        console.log(`commit: no changes on ${commitResult.branch}`);
        if (pr) {
            console.log('pr: skipped (no changes)');
        }
    }

    return commitResult;
}

export async function runPipeline(prompt, options) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const invocationCwd = process.cwd();

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? invocationCwd;

    // `--ask --from <slug>`: load the session before backend resolution so we
    // can fall back to session.agent (when CLI omitted --agent) and fail
    // missing/malformed sessions before any jobPatch creates `.orch/`.
    let askPrompt = prompt;
    const askFromSlug = options.ask ? (options.fromSlug ?? null) : null;
    if (askFromSlug) {
        let session;
        try {
            session = readAskSession(jobCwd, askFromSlug);
        } catch (err) {
            console.error(`Error: could not read ask session for ${askFromSlug}: ${err.message}`);
            process.exit(1);
            return;
        }
        if (!session) {
            console.error(`Error: no ask session found for ${askFromSlug} (missing ask.json)`);
            process.exit(1);
            return;
        }
        // Only when the CLI explicitly omitted --agent (cliAgentExplicit === false).
        // Direct runPipeline callers leave it undefined and keep options.agent.
        if (options.cliAgentExplicit === false && session.agent) {
            options.agent = session.agent;
        }
        askPrompt = buildAskFollowUpPrompt(session.turns ?? [], prompt);
    }

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
    const resolveBaseBranchFn = options.resolveBaseBranch ?? resolveBaseBranch;
    const fetchBaseFn = options.fetchBase ?? fetchBase;
    const publishFn = options.publish ?? ((args) => realPublish({
        ...args,
        pushBranch: options.pushBranch,
        findOpenPullRequest: options.findOpenPullRequest,
        createPullRequest: options.createPullRequest,
    }));
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
        const ask = askAgentArgs({ prompt: askPrompt, cwd: invocationCwd });
        const askAgent = new AgentClass(ask.name, ask.instructions, ask.prompt, ask.options);

        try {
            const askResult = await askAgent.run({ verbose });
            if (!askResult.ok) {
                // Failed asks do not invent assistant turns — leave ask.json
                // absent/unchanged (only persist after a successful answer).
                console.error(`Error: ask agent failed`);
                jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                process.exit(1);
                return;
            }
            const { content, summary } = splitStageSummary(askResult.result);
            printStageSummary('ask', resolveStageSummary('ask', summary, content));
            console.log(content);
            if (jobSlug) {
                // Persist the follow-up only — never the context-augmented blob.
                recordAskExchange(jobCwd, jobSlug, {
                    prompt,
                    answer: content,
                    agent: options.agent,
                });
            }
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
            const { content: quickFixContent, summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', resolveStageSummary('quick-fix', quickFixSummary, quickFixContent), quickFixTracker.getFiles());
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

    let resolvedBase = options.base ?? null;

    try {
        // Resolve/fetch base before any stage when --pr or --base is set.
        if (options.pr || options.base) {
            if (!resolvedBase) {
                resolvedBase = resolveBaseBranchFn({ cwd: invocationCwd });
            }
            fetchBaseFn({ cwd: invocationCwd, remote: 'origin', base: resolvedBase });
            if (options.pr) {
                jobPatch({ base: resolvedBase, remote: 'origin' });
            }
        }

        jobPatch({ phase: 'triage', stage: 'triage', round: null });
        await jobCheckpoint();
        const triageResult = await triageAgent.run({ verbose });
        await jobCheckpoint();
        const { content: triageContent, summary: triageSummary } = splitStageSummary(triageResult.result);
        printStageSummary('triage', resolveStageSummary('triage', triageSummary, triageContent));
        const parsed = parseTriageJson(triageContent);

        if (parsed?.simple === true) {
            // Without --pr: in-place quick-fix (no run context / worktree / commit).
            if (!options.pr) {
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
                const { content: quickFixContent, summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
                printStageSummary('quick-fix', resolveStageSummary('quick-fix', quickFixSummary, quickFixContent), quickFixTracker.getFiles());
                jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
                return;
            }

            // With --pr: abbreviated worktree → quick-fix → commit → publish
            // (no research, planner, or test/code loops).
            const runContext = createRunContextFn(
                jobSlug ? { cwd: invocationCwd, slug: jobSlug } : { cwd: invocationCwd },
            );
            console.log(`task ${runContext.slug} is started`);

            jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
            const worktree = createWorktreeFn({
                cwd: invocationCwd,
                slug: runContext.slug,
                ...(resolvedBase ? { base: `origin/${resolvedBase}` } : {}),
            });
            jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

            fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
            fs.writeFileSync(
                runContext.statusPath,
                `# Status\n\n- Slug: \`${runContext.slug}\`\n- Branch: \`${worktree.branch}\`\n- Worktree: \`${worktree.worktreePath}\`\n`,
            );

            jobPatch({ phase: 'quick-fix', stage: 'quick-fix', round: null });
            const quickFix = quickFixAgentArgs({
                prompt,
                cwd: worktree.worktreePath,
                fix_plan: parsed.fix_plan,
            });
            const quickFixTracker = new FileTracker({ cwd: worktree.worktreePath });
            const quickFixAgent = new AgentClass(
                quickFix.name,
                quickFix.instructions,
                quickFix.prompt,
                { ...quickFix.options, fileTracker: quickFixTracker },
            );

            const quickFixResult = await quickFixAgent.run({ verbose });
            await jobCheckpoint();
            const { content: quickFixContent, summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', resolveStageSummary('quick-fix', quickFixSummary, quickFixContent), quickFixTracker.getFiles());

            commitAndMaybePublish({
                prompt,
                runContext,
                worktree,
                resolvedBase,
                pr: true,
                agent: options.agent,
                jobPatch,
                collectWorktreeChangesFn,
                commitWorktreeFn,
                publishFn,
            });

            patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                state: 'done',
                exitCode: 0,
                summary: quickFixSummary ?? '',
                error: null,
                task: prompt,
            });
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
        printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

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
        const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

        jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
        const worktree = createWorktreeFn({
            cwd: invocationCwd,
            slug: runContext.slug,
            ...(resolvedBase ? { base: `origin/${resolvedBase}` } : {}),
        });
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
            researchPath: runContext.researchPath,
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

        const codeAccepted = await runCodeLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
            taskPath: runContext.taskPath,
            statusPath: runContext.statusPath,
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
            acceptedVerification,
        });

        commitAndMaybePublish({
            prompt,
            runContext,
            worktree,
            resolvedBase,
            pr: options.pr,
            agent: options.agent,
            jobPatch,
            collectWorktreeChangesFn,
            commitWorktreeFn,
            publishFn,
        });

        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: 'done',
            exitCode: 0,
            summary: codeAccepted?.verdict?.summary ?? '',
            error: null,
            task: prompt,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort: don't let a job-state write failure mask the real error.
            }
        }
        console.error(`next:   orch resume ${jobSlug ?? '<slug>'}`);
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
        seq = false,
        decompose = false,
        fromSlug = null,
        maxUnits = 8,
        fanOut = false,
        maxWorkers = 4,
        maxConcurrency = null,
        notify,
        pr = false,
        base,
        jobSlug: preallocatedSlug,
        createRunContext: createRunContextFn = createRunContext,
        spawn: spawnFn = spawn,
        exit = (code) => process.exit(code),
    } = options;

    if (seq && fanOut) {
        throw new Error('runDetached: seq and fanOut cannot both be set');
    }

    const backend = AGENT_BACKENDS[agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${agent}`);
    }

    if (!isBinaryOnPath(backend.binary)) {
        console.error(binaryMissingHint(agent));
        exit(1);
        return;
    }

    if (pr) {
        ensureGhAuthenticated();
    }

    const coordinator = Boolean(seq || fanOut);
    const detachPrompt = fromSlug
        ? (prompt || readSeq(cwd, fromSlug)?.task || fromSlug)
        : prompt;

    let slug = preallocatedSlug ?? (fromSlug || null);
    if (slug) {
        const existing = readJob(cwd, slug);
        if (!existing) {
            if (fromSlug) {
                throw new Error(`runDetached: unknown decompose job ${slug} (no run.json)`);
            }
            throw new Error(`runDetached: unknown pre-allocated job ${slug}`);
        }
        patchJob(cwd, slug, {
            state: 'starting',
            task: detachPrompt,
            agent,
            maxRounds,
            ...(fromSlug ? { role: 'coordinator', finishedAt: null, exitCode: null } : {}),
        });
    } else {
        ({ slug } = allocateJob({
            cwd,
            prompt: detachPrompt,
            agent,
            maxRounds,
            state: 'starting',
            createRunContext: createRunContextFn,
            role: coordinator ? 'coordinator' : null,
        }));
    }
    const { dir, logPath } = jobPaths(cwd, slug);
    fs.mkdirSync(dir, { recursive: true });

    const logFd = fs.openSync(logPath, 'a');

    const childArgs = [__filename];
    if (!fromSlug) childArgs.push(detachPrompt);
    childArgs.push('--agent', agent, '--max-rounds', String(maxRounds));
    if (verbose) childArgs.push('--verbose');
    if (fromSlug) {
        childArgs.push('--seq', '--from', fromSlug);
    } else if (seq) {
        childArgs.push('--seq', '--max-units', String(maxUnits));
    } else if (decompose) {
        childArgs.push('--decompose', '--max-units', String(maxUnits));
    }
    if (fanOut) {
        childArgs.push('--fan-out', '--max-workers', String(maxWorkers));
        if (maxConcurrency != null) {
            childArgs.push('--max-concurrency', String(maxConcurrency));
        }
    }
    if (pr) childArgs.push('--pr');
    if (base) childArgs.push('--base', base);
    appendNotifyArgs(childArgs, notify);

    const child = spawnFn(process.execPath, childArgs, {
        cwd,
        env: {
            ...process.env,
            ORCH_JOB_SLUG: slug,
            ORCH_DETACHED: '1',
        },
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    patchJob(cwd, slug, { pid: child.pid, state: 'running' });

    console.log(`started ${slug} (pid ${child.pid})`);
    exit(0);
}

/**
 * Continue pipeline: full complex stages on an existing worktree/branch.
 * Skips triage and `createWorktree`. Injects prior-outcome text into
 * research/planner only. See `.spec/continue.md`.
 */
export async function runContinuePipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const {
        slug,
        priorOutcome,
        continuation,
    } = options;

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const patchWorkerFn = options.patchWorker ?? patchWorker;
    const recordChangedFilesFn = options.recordChangedFiles ?? recordChangedFiles;
    const execFileFn = options.execFile;

    const jobSlug = options.jobSlug ?? slug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? cwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobRecord = (jobSlug && readJob(jobCwd, jobSlug)) || null;
    const worktreePath = options.worktreePath ?? jobRecord?.worktree;
    const branch = options.branch ?? jobRecord?.branch;
    const role = options.role ?? jobRecord?.role;
    const parentSlug = options.parentSlug ?? jobRecord?.parent;
    const workerId = options.workerId ?? jobRecord?.workerId;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
    };
    const jobCheckpoint = async () => {
        if (!jobSlug) return;
        await checkpointPauseFn(jobCwd, jobSlug, { pollIntervalMs: pausePollIntervalMs });
    };

    if (!options.AgentClass) {
        ensureBinaryOnPath(backend.binary, options.agent);
    }

    const priorBlock = buildPriorOutcomeText(priorOutcome, {
        slug,
        continuation,
        worktreePath,
        branch,
        parentSlug,
        workerId,
    });
    const researchPlannerPrompt = `${priorBlock}\n\nUser follow-up:\n${prompt}`;

    try {
        const runContext = createRunContextFn({ cwd, slug });

        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
        const prior = priorOutcome ?? {};
        const startedIso = new Date().toISOString();
        let continueSection = `\n## Continue ${continuation}\n\n`;
        continueSection += `- Task: ${prompt.split('\n')[0]}\n`;
        continueSection += `- Started: ${startedIso}\n`;
        continueSection += `- Branch: \`${branch}\`\n`;
        continueSection += `- Worktree: \`${worktreePath}\`\n`;
        if (parentSlug) continueSection += `- Fan-out parent: \`${parentSlug}\`\n`;
        if (workerId) continueSection += `- Worker id: \`${workerId}\`\n`;
        continueSection += `\n### Prior outcome\n\n`;
        continueSection += `- State: ${prior.state ?? '(none recorded)'}\n`;
        continueSection += `- Phase: ${prior.phase ?? '(none recorded)'}\n`;
        continueSection += `- Stage: ${prior.stage ?? '(none recorded)'}\n`;
        continueSection += `- Round: ${prior.round ?? 'null'}\n`;
        continueSection += `- Summary: ${prior.summary || '(none recorded)'}\n`;
        if (prior.error) continueSection += `- Error: ${prior.error}\n`;
        fs.appendFileSync(runContext.statusPath, continueSection);

        jobPatch({ phase: 'research', stage: 'research', round: null });
        const research = researchAgentArgs({
            prompt: researchPlannerPrompt,
            cwd: worktreePath,
            researchPath: runContext.researchPath,
        });
        const researchAgent = new AgentClass(
            research.name,
            research.instructions,
            research.prompt,
            research.options,
        );
        const researchResult = await researchAgent.run({ verbose });
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
        printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

        jobPatch({ phase: 'plan', stage: 'planner', round: null });
        const planner = plannerAgentArgs({
            prompt: researchPlannerPrompt,
            cwd: worktreePath,
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
        const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

        const testAccepted = await runTestLoop({
            prompt,
            worktreePath,
            branch,
            researchPath: runContext.researchPath,
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

        const codeAccepted = await runCodeLoop({
            prompt,
            worktreePath,
            branch,
            researchPath: runContext.researchPath,
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
        const message = `orch: ${slug} (continue ${continuation}): ${prompt.split('\n')[0]}`;
        const worktreeChanges = await collectWorktreeChangesFn({ worktreePath });
        printFilesChanged(worktreeChanges);
        const commitResult = await commitWorktreeFn({
            worktreePath,
            branch,
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

        if (role === 'worker' && parentSlug && workerId) {
            let changedFiles = [];
            try {
                changedFiles = recordChangedFilesFn({
                    repoRoot: cwd,
                    base: undefined,
                    branch,
                    execFile: execFileFn,
                });
            } catch {
                // Best-effort.
            }
            const seqDoc = readSeq(cwd, parentSlug);
            if (seqDoc) {
                const patchUnitFn = options.patchUnit ?? patchUnit;
                patchUnitFn(cwd, parentSlug, workerId, {
                    state: 'done',
                    sha: commitResult.sha,
                    changedFiles,
                    slug,
                });
                console.log(`next:   orch --seq-continue ${parentSlug}`);
            } else if (commitResult.committed) {
                patchWorkerFn(cwd, parentSlug, workerId, {
                    state: 'done',
                    sha: commitResult.sha,
                    changedFiles,
                });
                console.log(`next:   orch --integrate ${parentSlug}`);
            }
        }

        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: 'done',
            exitCode: 0,
            summary: codeAccepted?.verdict?.summary ?? '',
            error: null,
            task: prompt,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (role === 'worker' && parentSlug && workerId) {
            try {
                const seqDoc = readSeq(cwd, parentSlug);
                if (seqDoc) {
                    const patchUnitFn = options.patchUnit ?? patchUnit;
                    patchUnitFn(cwd, parentSlug, workerId, { state: 'failed' });
                } else {
                    patchWorkerFn(cwd, parentSlug, workerId, { state: 'failed' });
                }
            } catch {
                // Best-effort.
            }
        }
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort.
            }
        }
        process.exit(1);
    }
}

/**
 * Detach-parent path for `orch continue`: validate, PATH-check, spawn a
 * `--detach`-stripped re-invocation, reopen the existing slug with the child
 * pid, print `started`, exit. Never runs pipeline stages itself.
 */
export async function runContinueDetached(slug, prompt, options = {}) {
    const {
        agent,
        maxRounds = 5,
        verbose,
        cwd = process.cwd(),
        spawn: spawnFn = spawn,
        exit = (code) => process.exit(code),
        validateContinue: validateContinueFn = validateContinue,
        reopenJob: reopenJobFn = reopenJob,
        snapshotPriorOutcome: snapshotPriorOutcomeFn = snapshotPriorOutcome,
    } = options;

    const backend = AGENT_BACKENDS[agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${agent}`);
    }

    let record;
    try {
        record = validateContinueFn(cwd, slug, { task: prompt });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        exit(1);
        return;
    }

    if (!isBinaryOnPath(backend.binary)) {
        console.error(binaryMissingHint(agent));
        exit(1);
        return;
    }

    const prior = snapshotPriorOutcomeFn(cwd, slug, record);
    const { logPath } = jobPaths(cwd, slug);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');

    const childArgs = [
        __filename,
        'continue',
        slug,
        prompt,
        '--agent',
        agent,
        '--max-rounds',
        String(maxRounds),
    ];
    if (verbose) childArgs.push('--verbose');
    appendNotifyArgs(childArgs, options.notify);

    const child = spawnFn(process.execPath, childArgs, {
        cwd,
        env: { ...process.env, ORCH_JOB_SLUG: slug, ORCH_DETACHED: '1' },
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    const updated = reopenJobFn(cwd, slug, {
        task: prompt,
        agent,
        maxRounds,
        pid: child.pid,
        prior,
    });

    console.log(`started ${slug} (pid ${child.pid}, continuation ${updated.continuation})`);
    exit(0);
}

/**
 * Failure-resume pipeline: recover → re-enter unfinished stage → remaining phases.
 * Distinct from `runContinuePipeline` (new-task continue). See `.spec/resume.md`.
 */
export async function runResumePipeline(options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const {
        slug,
        priorOutcome,
        recoverBrief = '',
    } = options;

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const patchWorkerFn = options.patchWorker ?? patchWorker;
    const recordChangedFilesFn = options.recordChangedFiles ?? recordChangedFiles;
    const execFileFn = options.execFile;

    const jobSlug = options.jobSlug ?? slug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? cwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobRecord = (jobSlug && readJob(jobCwd, jobSlug)) || null;
    const worktreePath = options.worktreePath ?? jobRecord?.worktree;
    const branch = options.branch ?? jobRecord?.branch;
    const role = options.role ?? jobRecord?.role;
    const parentSlug = options.parentSlug ?? jobRecord?.parent;
    const workerId = options.workerId ?? jobRecord?.workerId;
    const prompt = options.prompt ?? jobRecord?.task ?? priorOutcome?.task ?? '';

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
    };
    const jobCheckpoint = async () => {
        if (!jobSlug) return;
        await checkpointPauseFn(jobCwd, jobSlug, { pollIntervalMs: pausePollIntervalMs });
    };

    if (!options.AgentClass) {
        ensureBinaryOnPath(backend.binary, options.agent);
    }

    const prior = priorOutcome ?? {};
    const phase = prior.phase ?? jobRecord?.phase ?? null;
    const stage = prior.stage ?? jobRecord?.stage ?? null;
    const round = prior.round ?? jobRecord?.round ?? null;

    const withRecover = (basePrompt) => (
        recoverBrief ? `${recoverBrief}\n\n${basePrompt}` : basePrompt
    );

    try {
        const runContext = createRunContextFn({ cwd, slug: jobSlug });
        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });

        const resumeSection = [
            '',
            '## Resume',
            '',
            `- Started: ${new Date().toISOString()}`,
            `- Prior state: ${prior.state ?? '(none)'}`,
            `- Reentry: ${phase ?? '-'}/${stage ?? '-'} (round ${round ?? '-'})`,
            `- Branch: \`${branch}\``,
            `- Worktree: \`${worktreePath}\``,
            '',
        ].join('\n');
        fs.appendFileSync(runContext.statusPath, resumeSection);

        const hasResearch = fs.existsSync(runContext.researchPath);
        const hasTask = fs.existsSync(runContext.taskPath);
        const skipEarly = ['worktree', 'test-loop', 'code-loop', 'commit'].includes(phase)
            && hasResearch && hasTask;

        let liveWorktree = worktreePath;
        let liveBranch = branch;
        let researchContent = hasResearch
            ? fs.readFileSync(runContext.researchPath, 'utf8')
            : '';

        // --- research (only when cursor is research, or early artifacts missing) ---
        if (phase === 'research' || (!skipEarly && !hasResearch && ['research', 'plan', null].includes(phase))) {
            jobPatch({ phase: 'research', stage: 'research', round: null });
            const research = researchAgentArgs({
                prompt: withRecover(prompt),
                cwd: liveWorktree || cwd,
                researchPath: runContext.researchPath,
            });
            const researchAgent = new AgentClass(
                research.name,
                research.instructions,
                research.prompt,
                research.options,
            );
            const researchResult = await researchAgent.run({ verbose });
            await jobCheckpoint();
            const split = splitStageSummary(researchResult.result);
            researchContent = split.content;
            printStageSummary('research', resolveStageSummary('research', split.summary, researchContent));
        }

        // --- plan ---
        if (phase === 'plan' || phase === 'research' || (!skipEarly && !hasTask)) {
            jobPatch({ phase: 'plan', stage: 'planner', round: null });
            const plannerPrompt = phase === 'plan' ? withRecover(prompt) : prompt;
            const researchOut = researchContent
                || (hasResearch ? fs.readFileSync(runContext.researchPath, 'utf8') : '');
            const planner = plannerAgentArgs({
                prompt: plannerPrompt,
                cwd: liveWorktree || cwd,
                researchPath: runContext.researchPath,
                taskPath: runContext.taskPath,
                researchOutput: researchOut,
            });
            const plannerAgent = new AgentClass(
                planner.name,
                planner.instructions,
                planner.prompt,
                planner.options,
            );
            const plannerResult = await plannerAgent.run({ verbose });
            await jobCheckpoint();
            const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
            printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));
        }

        // --- worktree ensure ---
        if (!liveWorktree || !fs.existsSync(liveWorktree) || phase === 'worktree') {
            if (liveWorktree && fs.existsSync(liveWorktree) && liveBranch) {
                jobPatch({ phase: 'worktree', stage: 'worktree', round: null, branch: liveBranch, worktree: liveWorktree });
            } else {
                jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
                const wt = createWorktreeFn({ cwd, slug: jobSlug });
                liveWorktree = wt.worktreePath;
                liveBranch = wt.branch;
                jobPatch({ branch: liveBranch, worktree: liveWorktree });
            }
        }

        let acceptedVerification = '';
        const enterTest = !phase || ['research', 'plan', 'worktree', 'test-loop'].includes(phase);
        const enterCode = !phase || ['research', 'plan', 'worktree', 'test-loop', 'code-loop'].includes(phase);
        const enterCommit = true;

        if (enterTest && phase !== 'code-loop' && phase !== 'commit') {
            const testStartAt = phase === 'test-loop'
                ? { stage: stage ?? 'test-writer', round: round ?? 1 }
                : null;
            const testPrompt = phase === 'test-loop' ? withRecover(prompt) : prompt;
            const testAccepted = await runTestLoop({
                prompt: testPrompt,
                worktreePath: liveWorktree,
                branch: liveBranch,
                researchPath: runContext.researchPath,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                maxRounds,
                AgentClass,
                verbose,
                jobPatch,
                jobCheckpoint,
                startAt: testStartAt,
            });
            acceptedVerification = [testAccepted.verdict.summary, testAccepted.writerContent]
                .filter(Boolean)
                .join('\n');
        } else if (hasTask) {
            // Code-loop / commit reentry: best-effort verification from task.md
            acceptedVerification = fs.readFileSync(runContext.taskPath, 'utf8').slice(0, 2000);
        }

        if (enterCode && phase !== 'commit') {
            const codeStartAt = phase === 'code-loop'
                ? { stage: stage ?? 'code-writer', round: round ?? 1 }
                : null;
            const codePrompt = phase === 'code-loop' ? withRecover(prompt) : prompt;
            const codeAccepted = await runCodeLoop({
                prompt: codePrompt,
                worktreePath: liveWorktree,
                branch: liveBranch,
                researchPath: runContext.researchPath,
                taskPath: runContext.taskPath,
                statusPath: runContext.statusPath,
                maxRounds,
                AgentClass,
                verbose,
                jobPatch,
                jobCheckpoint,
                acceptedVerification,
                startAt: codeStartAt,
            });

            if (enterCommit) {
                jobPatch({ phase: 'commit', stage: 'commit', round: null });
                const message = `orch: ${jobSlug} (resume): ${String(prompt).split('\n')[0]}`;
                const worktreeChanges = await collectWorktreeChangesFn({ worktreePath: liveWorktree });
                printFilesChanged(worktreeChanges);
                const commitResult = await commitWorktreeFn({
                    worktreePath: liveWorktree,
                    branch: liveBranch,
                    message,
                });

                if (commitResult.committed) {
                    fs.appendFileSync(
                        runContext.statusPath,
                        `\n## Commit\n\n- SHA: \`${commitResult.sha}\`\n- Branch: \`${commitResult.branch}\`\n`,
                    );
                    console.log(`commit: ${commitResult.sha.slice(0, 7)} on ${commitResult.branch}`);
                    console.log(`merge:  git merge ${commitResult.branch}`);
                    console.log(`next:   orch continue ${jobSlug} "…"`);
                } else {
                    fs.appendFileSync(
                        runContext.statusPath,
                        `\n## Commit\n\n- No changes to commit on \`${commitResult.branch}\`.\n`,
                    );
                    console.log(`commit: no changes on ${commitResult.branch}`);
                }

                if (role === 'worker' && parentSlug && workerId) {
                    let changedFiles = [];
                    try {
                        changedFiles = recordChangedFilesFn({
                            repoRoot: cwd,
                            base: undefined,
                            branch: liveBranch,
                            execFile: execFileFn,
                        });
                    } catch {
                        // Best-effort.
                    }
                    const seqDoc = readSeq(cwd, parentSlug);
                    if (seqDoc) {
                        const patchUnitFn = options.patchUnit ?? patchUnit;
                        patchUnitFn(cwd, parentSlug, workerId, {
                            state: 'done',
                            sha: commitResult.sha,
                            changedFiles,
                            slug: jobSlug,
                        });
                        console.log(`next:   orch --seq-continue ${parentSlug}`);
                    } else if (commitResult.committed) {
                        patchWorkerFn(cwd, parentSlug, workerId, {
                            state: 'done',
                            sha: commitResult.sha,
                            changedFiles,
                        });
                        console.log(`next:   orch --integrate ${parentSlug}`);
                    }
                }

                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'done',
                    exitCode: 0,
                    summary: codeAccepted?.verdict?.summary ?? '',
                    error: null,
                    task: prompt,
                });
            }
            return;
        }

        // commit-only reentry
        if (phase === 'commit') {
            jobPatch({ phase: 'commit', stage: 'commit', round: null });
            const message = `orch: ${jobSlug} (resume): ${String(prompt).split('\n')[0]}`;
            const worktreeChanges = await collectWorktreeChangesFn({ worktreePath: liveWorktree });
            printFilesChanged(worktreeChanges);
            const commitResult = await commitWorktreeFn({
                worktreePath: liveWorktree,
                branch: liveBranch,
                message,
            });
            if (commitResult.committed) {
                console.log(`commit: ${commitResult.sha.slice(0, 7)} on ${commitResult.branch}`);
                console.log(`next:   orch continue ${jobSlug} "…"`);
            } else {
                console.log(`commit: no changes on ${commitResult.branch}`);
            }
            if (role === 'worker' && parentSlug && workerId && commitResult.committed) {
                const seqDoc = readSeq(cwd, parentSlug);
                if (seqDoc) {
                    const patchUnitFn = options.patchUnit ?? patchUnit;
                    patchUnitFn(cwd, parentSlug, workerId, {
                        state: 'done',
                        sha: commitResult.sha,
                        changedFiles: [],
                        slug: jobSlug,
                    });
                } else {
                    patchWorkerFn(cwd, parentSlug, workerId, {
                        state: 'done',
                        sha: commitResult.sha,
                        changedFiles: [],
                    });
                }
            }
            patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                state: 'done',
                exitCode: 0,
                summary: '',
                error: null,
                task: prompt,
            });
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (role === 'worker' && parentSlug && workerId) {
            try {
                const seqDoc = readSeq(cwd, parentSlug);
                if (seqDoc) {
                    const patchUnitFn = options.patchUnit ?? patchUnit;
                    patchUnitFn(cwd, parentSlug, workerId, { state: 'failed' });
                } else {
                    patchWorkerFn(cwd, parentSlug, workerId, { state: 'failed' });
                }
            } catch {
                // Best-effort.
            }
        }
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort.
            }
        }
        console.error(`next:   orch resume ${jobSlug ?? '<slug>'}`);
        process.exit(1);
    }
}

/**
 * Detach-parent path for failure `orch resume`: spawn background child with
 * ORCH_JOB_SLUG, reopen with child pid, print resumed, exit.
 */
export async function runResumeDetached(slug, options = {}) {
    const {
        agent,
        maxRounds = 5,
        verbose,
        cwd = process.cwd(),
        spawn: spawnFn = spawn,
        exit = (code) => process.exit(code),
        validateResume: validateResumeFn = validateResume,
        reopenForResume: reopenForResumeFn = reopenForResume,
        snapshotPriorOutcome: snapshotPriorOutcomeFn = snapshotPriorOutcome,
    } = options;

    const backend = AGENT_BACKENDS[agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${agent}`);
    }

    let validated;
    try {
        validated = validateResumeFn(cwd, slug, {});
    } catch (err) {
        console.error(`Error: ${err.message}`);
        exit(1);
        return;
    }

    if (validated.mode !== 'failure') {
        console.error(`Error: --detach only applies to failure resume (got mode ${validated.mode})`);
        exit(1);
        return;
    }

    if (!isBinaryOnPath(backend.binary)) {
        console.error(binaryMissingHint(agent));
        exit(1);
        return;
    }

    const record = validated.record;
    const prior = snapshotPriorOutcomeFn(cwd, slug, record);
    const { logPath } = jobPaths(cwd, slug);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, 'a');

    const childArgs = [
        __filename,
        'resume',
        slug,
        '--agent',
        agent,
        '--max-rounds',
        String(maxRounds),
    ];
    if (verbose) childArgs.push('--verbose');
    appendNotifyArgs(childArgs, options.notify);

    const child = spawnFn(process.execPath, childArgs, {
        cwd,
        env: { ...process.env, ORCH_JOB_SLUG: slug, ORCH_DETACHED: '1' },
        detached: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();

    reopenForResumeFn(cwd, slug, {
        agent,
        maxRounds,
        pid: child.pid,
        prior,
    });

    // Recover runs in the child; parent only prints the resume line.
    console.log(`resumed ${slug} (pid ${child.pid})`);
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
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
        printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

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
        const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

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
            researchPath: runContext.researchPath,
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

        const codeAccepted = await runCodeLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
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
        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: 'done',
            exitCode: 0,
            summary: codeAccepted?.verdict?.summary ?? '',
            error: null,
            task: prompt,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        try {
            patchWorkerFn(cwd, parentSlug, workerId, { state: 'failed' });
        } catch {
            // Best-effort: don't let a fanout-state write failure mask the real error.
        }
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort: don't let a job-state write failure mask the real error.
            }
        }
        console.error(`next:   orch resume ${jobSlug ?? '<slug>'}`);
        if (parentSlug) console.error(`        orch --integrate ${parentSlug}`);
        process.exit(1);
    }
}

/**
 * The `--unit <parent>:<unitId>` driver: skips triage and runs research → planner →
 * worktree (from the seq tip) → test loop → code loop → commit. On success patches
 * `seq.json.units[]` to `done` with sha/changedFiles/slug; on failure, `failed` then exit 1.
 */
export async function runUnitPipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const { parentSlug, unitId, base } = options;
    const exitFn = options.exit ?? ((code) => process.exit(code));

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const collectWorktreeChangesFn = options.collectWorktreeChanges ?? collectWorktreeChanges;
    const patchUnitFn = options.patchUnit ?? patchUnit;
    const recordChangedFilesFn = options.recordChangedFiles ?? recordChangedFiles;
    const execFileFn = options.execFile;

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? cwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
        if (!researchResult.ok) throw researchResult.error ?? new Error('research failed');
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
        printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

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
        const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

        jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
        const worktree = await createWorktreeFn({ cwd, slug: runContext.slug, base });
        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
        fs.writeFileSync(
            runContext.statusPath,
            `# Status\n\n- Slug: \`${runContext.slug}\`\n- Branch: \`${worktree.branch}\`\n- Worktree: \`${worktree.worktreePath}\`\n- Parent: \`${parentSlug}\`\n- Worker: \`${unitId}\`\n`,
        );

        const testAccepted = await runTestLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
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

        const codeAccepted = await runCodeLoop({
            prompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
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
        const worktreeChanges = await collectWorktreeChangesFn({ worktreePath: worktree.worktreePath });
        printFilesChanged(worktreeChanges);
        const commitResult = await commitWorktreeFn({
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
        } else if (commitResult.sha) {
            console.log(`commit: ${String(commitResult.sha).slice(0, 7)} on ${worktree.branch}`);
        } else {
            fs.appendFileSync(
                runContext.statusPath,
                `\n## Commit\n\n- No changes to commit on \`${worktree.branch}\`.\n`,
            );
            console.log(`commit: no changes on ${worktree.branch}`);
        }

        let changedFiles = [];
        try {
            changedFiles = recordChangedFilesFn({
                repoRoot: worktree.repoRoot ?? cwd,
                base,
                branch: worktree.branch,
                execFile: execFileFn,
            });
        } catch {
            // Best-effort: changedFiles is informational only.
        }

        patchUnitFn(cwd, parentSlug, unitId, {
            state: 'done',
            sha: commitResult.sha,
            changedFiles,
            slug: runContext.slug,
        });
        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: 'done',
            exitCode: 0,
            summary: codeAccepted?.verdict?.summary ?? '',
            error: null,
            task: prompt,
        });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        try {
            patchUnitFn(cwd, parentSlug, unitId, { state: 'failed' });
        } catch {
            // Best-effort.
        }
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort.
            }
        }
        console.error(`next:   orch resume ${jobSlug ?? '<slug>'}`);
        if (parentSlug) console.error(`        orch --seq-continue ${parentSlug}`);
        exitFn(1);
    }
}

/**
 * Merge one unit branch into `orch/<parentSlug>`, repair conflicts once via
 * integrator, runner-first verify, then advance `seq.tip`. Merge/verify failure
 * marks the unit `failed` and exits non-zero.
 */
export async function mergeOneUnit(options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const cwd = options.cwd ?? process.cwd();
    const { parentSlug, unitId, unitBranch } = options;
    const exitFn = options.exit ?? ((code) => process.exit(code));
    const logFn = options.log ?? ((line) => console.log(line));

    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const readSeqFn = options.readSeq ?? readSeq;
    const patchUnitFn = options.patchUnit ?? patchUnit;
    const patchTipFn = options.patchTip ?? patchTip;
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
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
    };
    const jobCheckpoint = async () => {
        if (!jobSlug) return;
        await checkpointPauseFn(jobCwd, jobSlug, { pollIntervalMs: pausePollIntervalMs });
    };

    const failUnit = async (message) => {
        if (message) console.error(`Error: ${message}`);
        try {
            patchUnitFn(cwd, parentSlug, unitId, { state: 'failed' });
        } catch {
            // Best-effort.
        }
        exitFn(1);
    };

    try {
        const seq = readSeqFn(cwd, parentSlug);
        if (!seq) {
            await failUnit(`unknown parent ${parentSlug} (no seq.json found)`);
            return;
        }

        jobPatch({ phase: 'merge', stage: 'merge', round: null });

        const reuseWorktreePath = `${cwd}-${parentSlug}`;
        const expectedBranch = `orch/${parentSlug}`;
        let worktree = null;

        if (fs.existsSync(reuseWorktreePath)) {
            try {
                const currentBranch = execFileFn('git', ['-C', reuseWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
                if (currentBranch === expectedBranch) {
                    worktree = { repoRoot: cwd, worktreePath: reuseWorktreePath, branch: expectedBranch };
                }
            } catch {
                // Fall through to create.
            }
        }

        if (!worktree) {
            worktree = await createWorktreeFn({
                cwd,
                slug: parentSlug,
                base: seq.tip || seq.base,
            });
        }

        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

        const mergeResult = await mergeBranchesFn({
            cwd: worktree.worktreePath,
            candidates: [unitBranch],
            merged: [],
            overlappingFiles: [],
            execFile: execFileFn,
        });

        let conflicts = [];
        let mergedOk = false;
        let mergeOutput = '';
        if (Array.isArray(mergeResult)) {
            conflicts = mergeResult.filter((r) => r.status === 'conflict').map((r) => r.branch);
            mergedOk = mergeResult.some((r) => r.status === 'merged');
            mergeOutput = mergeResult.find((r) => r.status === 'conflict')?.output ?? '';
        } else {
            conflicts = mergeResult?.conflicts ?? [];
            mergedOk = (mergeResult?.merged ?? []).includes(unitBranch) || (mergeResult?.merged ?? []).length > 0;
        }

        if (conflicts.length > 0) {
            jobPatch({ phase: 'merge', stage: 'integrator', round: null });
            const conflicted = conflictedFilesFn({ cwd: worktree.worktreePath, execFile: execFileFn });
            const integratorArgs = integratorAgentArgs({
                prompt: `Resolve the merge conflict from combining \`${unitBranch}\` into the seq integration branch for "${seq.task}".`,
                cwd: worktree.worktreePath,
                conflictedFiles: conflicted,
                mergeOutput,
                involvedWorkers: [{ id: unitId, title: unitId, subtask: unitId, area: '' }],
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
                integratorOk = Boolean(integratorOut.ok);
            } catch {
                integratorOk = false;
            }

            const stillConflicted = integratorOk
                ? hasConflictMarkersFn({ cwd: worktree.worktreePath, execFile: execFileFn })
                : true;

            if (!stillConflicted) {
                try {
                    execFileFn('git', ['-C', worktree.worktreePath, 'commit']);
                } catch {
                    // May already be committed by integrator.
                }
                mergedOk = true;
            } else {
                try {
                    abortMergeFn({ cwd: worktree.worktreePath, execFile: execFileFn });
                } catch {
                    // Best-effort.
                }
                await failUnit(`merge conflict for ${unitId} could not be repaired`);
                return;
            }
        }

        if (!mergedOk && conflicts.length === 0) {
            await failUnit(`failed to merge ${unitBranch}`);
            return;
        }

        const artifactDir = path.join(jobCwd, '.orch', parentSlug);
        await runCodeLoop({
            prompt: seq.task,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: path.join(artifactDir, 'research.md'),
            taskPath: path.join(artifactDir, 'task.md'),
            statusPath: path.join(artifactDir, 'status.md'),
            maxRounds,
            AgentClass,
            verbose,
            jobPatch,
            jobCheckpoint,
            acceptedVerification: '',
            runnerFirst: true,
            loopTitle: 'Verify loop',
        });

        const commitResult = await commitWorktreeFn({
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            message: `orch: merge ${unitId} into ${parentSlug}`,
        });

        let tipSha = commitResult?.sha;
        if (!tipSha) {
            tipSha = execFileFn('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD']).trim();
        }
        patchTipFn(cwd, parentSlug, tipSha);
        logFn(`merged ${unitId} → tip ${String(tipSha).slice(0, 7)}`);
    } catch (err) {
        await failUnit(err.message);
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
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
                    const { content: integratorContent, summary: integratorSummary } = splitStageSummary(integratorOut.result);
                    printStageSummary('integrator', resolveStageSummary('integrator', integratorSummary, integratorContent));
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
        const codeAccepted = await runCodeLoop({
            prompt: fanout.task,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: path.join(integrationDir, 'research.md'),
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
        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: 'done',
            exitCode: 0,
            summary: codeAccepted?.verdict?.summary ?? '',
            error: null,
            task: fanout.task,
        });
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
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: fanout?.task,
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
 * SIGINT/SIGHUP/SIGTERM cascade for seq: reads `seq.json` unit slugs and SIGTERMs
 * live non-terminal children. Never touches worktrees.
 */
export function cascadeStopSeqChildren(cwd, parentSlug, { kill = (pid, signal) => process.kill(pid, signal), isPidAlive: isPidAliveFn = isPidAlive } = {}) {
    const seq = readSeq(cwd, parentSlug);
    if (!seq) return;

    const slugs = (seq.units || []).filter((unit) => unit.slug).map((unit) => unit.slug);
    for (const slug of slugs) {
        const record = readJob(cwd, slug);
        if (!record) continue;
        if (TERMINAL_JOB_STATES.includes(record.state)) continue;
        if (isPidAliveFn(record.pid)) {
            kill(record.pid, 'SIGTERM');
        }
    }
}

/**
 * CLI / management cascade stop: SIGTERM the parent pid if alive, then every
 * live child pid (via fan-out and/or seq helpers). The coordinator signal
 * handler keeps calling the child-only helpers so it does not re-signal itself.
 */
export function cascadeStop(cwd, parentSlug, { kill = (pid, signal) => process.kill(pid, signal), isPidAlive: isPidAliveFn = isPidAlive } = {}) {
    const parent = readJob(cwd, parentSlug);
    if (parent && isPidAliveFn(parent.pid)) {
        kill(parent.pid, 'SIGTERM');
    }
    cascadeStopFanoutChildren(cwd, parentSlug, { kill, isPidAlive: isPidAliveFn });
    cascadeStopSeqChildren(cwd, parentSlug, { kill, isPidAlive: isPidAliveFn });
}

/**
 * Ensure the seq coordinator worktree/branch exists. Prefer reuse when the
 * sibling path already has `orch/<slug>`; otherwise create at `base`.
 * Worktrees are created at `--seq` / `--seq --from` execute time — not during
 * plan-only `--decompose` (see `.spec/decompose.md` open choice).
 */
function ensureSeqCoordinatorWorktree({
    cwd,
    slug,
    base,
    createWorktreeFn,
    execFileFn,
}) {
    const repoRoot = execFileFn('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).trim();
    const worktreePath = `${path.join(path.dirname(repoRoot), path.basename(repoRoot))}-${slug}`;
    const branch = `orch/${slug}`;

    if (fs.existsSync(worktreePath)) {
        try {
            const currentBranch = execFileFn('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
            if (currentBranch === branch) {
                return { repoRoot, worktreePath, branch };
            }
        } catch {
            // Fall through to create.
        }
    }

    return createWorktreeFn({ cwd, slug, base });
}

/**
 * Plan-only `--decompose`: research → plan-mode seq-decomposer → write
 * `seq.json` with `state: "planned"` → exit. No triage, worktree, schedule,
 * merge, or adjust. Worktree creation is deferred to `--seq --from`.
 */
export async function runDecomposePipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxUnits = options.maxUnits ?? 8;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const invocationCwd = options.cwd ?? process.cwd();

    const createRunContextFn = options.createRunContext ?? createRunContext;
    const execFileFn = options.execFile ?? defaultExecFile;
    const writeSeqFn = options.writeSeq ?? writeSeq;
    const exitFn = options.exit ?? ((code) => process.exit(code));

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? invocationCwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
        if (jobSlug) {
            try {
                const exitCode = exitCodeForSignal(signal);
                const finishedAt = new Date().toISOString();
                patchJobFn(jobCwd, jobSlug, (current) => ({
                    state: 'stopped',
                    exitCode,
                    finishedAt,
                    lastOutcome: buildLastOutcome({
                        state: 'stopped',
                        phase: current.phase,
                        stage: current.stage,
                        round: current.round,
                        exitCode,
                        finishedAt,
                        task: prompt,
                        summary: '',
                        error: null,
                    }),
                }));
            } catch {
                // Best-effort.
            }
        }
        exitFn(exitCodeForSignal(signal));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGHUP', () => onSignal('SIGHUP'));

    try {
        const runContext = createRunContextFn(jobSlug ? { cwd: invocationCwd, slug: jobSlug } : { cwd: invocationCwd });

        jobPatch({ phase: 'research', stage: 'research', round: null });
        const research = researchAgentArgs({
            prompt,
            cwd: invocationCwd,
            researchPath: runContext.researchPath,
        });
        const researchAgent = new AgentClass(research.name, research.instructions, research.prompt, research.options);
        const researchResult = await researchAgent.run({ verbose });
        if (interrupted) {
            exitFn(exitCodeForSignal('SIGINT'));
            return;
        }
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
        const researchLine = resolveStageSummary('research', researchSummary, researchContent);
        printStageSummary('research', researchLine);
        console.log(`research: ${researchLine || 'done'}`);

        let feedback;
        let decision = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            jobPatch({ phase: 'decompose', stage: 'seq-decomposer', round: attempt });
            const decomposer = decomposeAgentArgs({
                prompt,
                cwd: invocationCwd,
                maxUnits,
                feedback,
                researchPath: runContext.researchPath,
                researchOutput: researchContent,
            });
            const decomposerAgent = new AgentClass(
                decomposer.name,
                decomposer.instructions,
                decomposer.prompt,
                decomposer.options,
            );
            const decomposerResult = await decomposerAgent.run({ verbose });
            if (interrupted) {
                exitFn(exitCodeForSignal('SIGINT'));
                return;
            }
            await jobCheckpoint();
            const { content: decomposerContent, summary: decomposerSummary } = splitStageSummary(decomposerResult.result);
            printStageSummary(
                'seq-decomposer',
                resolveStageSummary('seq-decomposer', decomposerSummary, decomposerContent),
            );

            const parsedDecomposition = parseDecomposition(decomposerContent);
            if (!parsedDecomposition) {
                feedback = ['decomposer output was not valid JSON'];
                if (attempt === 3) {
                    decision = { ok: false, why: 'decomposer did not return valid JSON after repair attempts' };
                }
                continue;
            }
            // Plan mode ignores/drops decomposable:false — require units.
            const violations = validateSeqDecomposition(parsedDecomposition, {
                maxUnits,
                minUnits: 1,
            });
            if (violations.length === 0) {
                decision = { ok: true, decomposition: parsedDecomposition };
                break;
            }
            feedback = violations;
            if (attempt === 3) {
                decision = {
                    ok: false,
                    why: `decomposition still invalid after repairs: ${violations.join('; ')}`,
                };
            }
        }

        if (!decision?.ok) {
            console.error(`Error: decompose failed — ${decision?.why ?? 'unknown'}`);
            jobPatch({
                state: 'failed',
                exitCode: 1,
                finishedAt: new Date().toISOString(),
                phase: 'decompose',
            });
            exitFn(1);
            return;
        }

        const head = execFileFn('git', ['-C', invocationCwd, 'rev-parse', 'HEAD']).trim();
        const units = decision.decomposition.units.map((unit) => ({
            id: unit.id,
            title: unit.title,
            subtask: unit.subtask,
            state: 'pending',
            slug: null,
            sha: null,
            changedFiles: null,
        }));

        writeSeqFn(invocationCwd, jobSlug, {
            version: 1,
            parentSlug: jobSlug,
            task: prompt,
            base: head,
            tip: head,
            maxUnits,
            units,
            adjustments: [],
            state: 'planned',
            startedAt: new Date().toISOString(),
            finishedAt: null,
        });

        console.log(`decomposer: ${units.length} unit${units.length === 1 ? '' : 's'}`);
        console.log();
        for (const unit of units) {
            const idPad = unit.id.padEnd(12);
            console.log(`  ${idPad} ${unit.title}`);
        }
        console.log();
        console.log(`wrote: .orch/${jobSlug}/seq.json`);
        console.log(`next:  orch --seq --from ${jobSlug}`);

        jobPatch({
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
            phase: 'decompose',
            stage: null,
            round: null,
        });
        exitFn(0);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
                });
            } catch {
                // Best-effort.
            }
        }
        exitFn(1);
    }
}

/**
 * The `--seq` coordinator: triage → seq-decomposer (no boundaries) → schedule
 * units concurrency 1 → merge+verify after each → hybrid adjust. Decline falls
 * through to the single-worktree pipeline with no seq.json.
 *
 * With `options.fromSlug` (`--seq --from <slug>`): load a planned `seq.json`,
 * skip triage/research/decompose, create the coordinator worktree at execute
 * time, set `state: "running"`, and enter the schedule loop.
 */
export async function runSeqPipeline(prompt, options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    let maxUnits = options.maxUnits ?? 8;
    const fromSlug = options.fromSlug ?? null;
    let taskPrompt = prompt;
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
    const readSeqFn = options.readSeq ?? readSeq;
    const writeSeqFn = options.writeSeq ?? writeSeq;
    const patchUnitFn = options.patchUnit ?? patchUnit;
    const appendAdjustmentFn = options.appendAdjustment ?? appendAdjustment;
    const mergeOneUnitFn = options.mergeOneUnit ?? mergeOneUnit;
    const isPidAliveFn = options.isPidAlive ?? isPidAlive;
    const exitFn = options.exit ?? ((code) => process.exit(code));
    const pollIntervalMs = options.pollIntervalMs ?? 500;

    const jobSlug = options.jobSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? invocationCwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
            cascadeStopSeqChildren(invocationCwd, jobSlug);
        } catch {
            // Best-effort.
        }
        if (jobSlug) {
            try {
                const exitCode = exitCodeForSignal(signal);
                const finishedAt = new Date().toISOString();
                patchJobFn(jobCwd, jobSlug, (current) => ({
                    state: 'stopped',
                    exitCode,
                    finishedAt,
                    lastOutcome: buildLastOutcome({
                        state: 'stopped',
                        phase: current.phase,
                        stage: current.stage,
                        round: current.round,
                        exitCode,
                        finishedAt,
                        task: taskPrompt,
                        summary: '',
                        error: null,
                    }),
                }));
            } catch {
                // Best-effort.
            }
        }
        exitFn(exitCodeForSignal(signal));
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGHUP', () => onSignal('SIGHUP'));

    const runDeclinePipeline = async () => {
        const runContext = createRunContextFn(jobSlug ? { cwd: invocationCwd, slug: jobSlug } : { cwd: invocationCwd });

        jobPatch({ phase: 'research', stage: 'research', round: null });
        const research = researchAgentArgs({ prompt: taskPrompt, cwd: invocationCwd, researchPath: runContext.researchPath });
        const researchAgent = new AgentClass(research.name, research.instructions, research.prompt, research.options);
        const researchResult = await researchAgent.run({ verbose });
        await jobCheckpoint();
        const { content: researchContent, summary: researchSummary } = splitStageSummary(researchResult.result);
        printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

        jobPatch({ phase: 'plan', stage: 'planner', round: null });
        const planner = plannerAgentArgs({
            prompt: taskPrompt, cwd: invocationCwd, researchPath: runContext.researchPath, taskPath: runContext.taskPath, researchOutput: researchContent,
        });
        const plannerAgent = new AgentClass(planner.name, planner.instructions, planner.prompt, planner.options);
        const plannerResult = await plannerAgent.run({ verbose });
        await jobCheckpoint();
        const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
        printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

        jobPatch({ phase: 'worktree', stage: 'worktree', round: null });
        const worktree = await createWorktreeFn({ cwd: invocationCwd, slug: runContext.slug });
        jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

        fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
        fs.writeFileSync(
            runContext.statusPath,
            `# Status\n\n- Slug: \`${runContext.slug}\`\n- Branch: \`${worktree.branch}\`\n- Worktree: \`${worktree.worktreePath}\`\n`,
        );

        const testAccepted = await runTestLoop({
            prompt: taskPrompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
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
            prompt: taskPrompt,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            researchPath: runContext.researchPath,
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
        const message = `orch: ${runContext.slug} ${taskPrompt.split('\n')[0]}`;
        const worktreeChanges = await collectWorktreeChangesFn({ worktreePath: worktree.worktreePath });
        printFilesChanged(worktreeChanges);
        const commitResult = await commitWorktreeFn({ worktreePath: worktree.worktreePath, branch: worktree.branch, message });

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
    };

    const runAdjust = async (seqDoc) => {
        const doneUnits = seqDoc.units.filter((u) => u.state === 'done');
        const pendingUnits = seqDoc.units.filter((u) => u.state === 'pending');
        if (pendingUnits.length === 0) return seqDoc;

        let feedback;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            jobPatch({ phase: 'adjust', stage: 'adjust', round: attempt });
            const adjust = adjustAgentArgs({
                originalTask: taskPrompt,
                doneUnits,
                pendingUnits,
                tip: seqDoc.tip,
                cwd: invocationCwd,
                maxUnits,
                feedback,
            });
            const adjustAgent = new AgentClass(adjust.name, adjust.instructions, adjust.prompt, adjust.options);
            const adjustResult = await adjustAgent.run({ verbose });
            await jobCheckpoint();
            const { content: adjustContent, summary: adjustSummary } = splitStageSummary(adjustResult.result);
            printStageSummary('adjust', resolveStageSummary('adjust', adjustSummary, adjustContent));

            const parsed = parseDecomposition(adjustContent);
            if (!parsed) {
                feedback = ['adjust output was not valid JSON'];
                continue;
            }
            const violations = validateAdjustResult(parsed, { units: seqDoc.units, maxUnits });
            if (violations.length === 0) {
                const applied = applyAdjustResult(seqDoc, parsed);
                writeSeqFn(invocationCwd, jobSlug, applied);
                const rewriteIds = (parsed.rewrites || []).map((r) => r.id);
                const dropIds = parsed.drops || [];
                const summaryParts = [];
                if (rewriteIds.length) summaryParts.push(`rewrote ${rewriteIds.join(', ')}`);
                if (dropIds.length) summaryParts.push(`dropped ${dropIds.join(', ')}`);
                const summary = summaryParts.join('; ') || 'no changes';
                appendAdjustmentFn(invocationCwd, jobSlug, {
                    afterUnitId: doneUnits[doneUnits.length - 1]?.id ?? null,
                    tip: applied.tip,
                    summary,
                });
                console.log(`adjust: ${summary}`);
                return applied;
            }
            feedback = violations;
        }
        console.log('adjust: validation failed after repairs — keeping previous pending list');
        return seqDoc;
    };

    const spawnUnitChild = async (unit, tip) => {
        const envelope = buildUnitEnvelope({
            id: unit.id,
            title: unit.title,
            subtask: unit.subtask,
            originalTask: taskPrompt,
        });
        const unitPrompt = `${unit.subtask}\n\n${envelope}`;

        const allocated = await allocateJobFn({
            cwd: invocationCwd,
            prompt: unitPrompt,
            agent: options.agent,
            maxRounds,
            state: 'starting',
            parent: jobSlug,
            role: 'worker',
            workerId: unit.id,
        });
        const unitSlug = allocated.slug;
        patchUnitFn(invocationCwd, jobSlug, unit.id, {
            slug: unitSlug,
            state: 'running',
        });

        const { logPath } = jobPaths(invocationCwd, unitSlug);
        const logFd = fs.openSync(logPath, 'a');
        const childArgs = [
            __filename, unitPrompt,
            '--agent', options.agent,
            '--max-rounds', String(maxRounds),
            '--unit', `${jobSlug}:${unit.id}`,
        ];
        const child = spawnFn(process.execPath, childArgs, {
            cwd: invocationCwd,
            env: {
                ...process.env,
                ORCH_JOB_SLUG: unitSlug,
                ORCH_DETACHED: '1',
                ORCH_SEQ_DEPTH: '1',
                ORCH_FANOUT_DEPTH: '1',
            },
            detached: true,
            stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        patchJobFn(invocationCwd, unitSlug, { pid: child.pid, state: 'running' });
        console.log(`[${unit.id} ${unitSlug}] running (base ${String(tip).slice(0, 7)})`);
        return unitSlug;
    };

    const waitForUnit = async (unitId, unitSlug) => {
        const spawnedAt = Date.now();
        for (;;) {
            if (interrupted) return 'interrupted';
            await sleep(pollIntervalMs);
            await jobCheckpoint();

            const seq = readSeqFn(invocationCwd, jobSlug);
            const unit = seq?.units?.find((u) => u.id === unitId);
            if (unit && (unit.state === 'done' || unit.state === 'failed' || unit.state === 'skipped')) {
                return unit.state;
            }

            const job = reconcileJobFn(invocationCwd, unitSlug, readJob(invocationCwd, unitSlug));
            if (job && TERMINAL_JOB_STATES.includes(job.state)) {
                if (unit && unit.state !== 'done' && unit.state !== 'failed') {
                    const nextState = job.state === 'done' ? 'done' : 'failed';
                    patchUnitFn(invocationCwd, jobSlug, unitId, {
                        state: nextState,
                        sha: job.sha ?? null,
                    });
                    return nextState;
                }
                return job.state === 'done' ? 'done' : 'failed';
            }

            // Grace period before treating a dead pid as a crash (mirrors fan-out).
            if (job && !job.pid && Date.now() - spawnedAt > Math.max(pollIntervalMs * 4, 2000)) {
                patchUnitFn(invocationCwd, jobSlug, unitId, { state: 'failed' });
                return 'failed';
            }
        }
    };

    const runScheduleLoop = async () => {
        jobPatch({ phase: 'schedule', stage: null, round: null });

        for (;;) {
            if (interrupted) {
                exitFn(exitCodeForSignal('SIGINT'));
                return;
            }

            await jobCheckpoint();

            let seq = readSeqFn(invocationCwd, jobSlug);
            const firstPending = seq.units.find((u) => u.state === 'pending');
            if (!firstPending) {
                const failed = seq.units.some((u) => u.state === 'failed');
                writeSeqFn(invocationCwd, jobSlug, {
                    ...seq,
                    state: failed ? 'failed' : 'done',
                    finishedAt: new Date().toISOString(),
                });
                jobPatch({
                    state: failed ? 'failed' : 'done',
                    exitCode: failed ? 1 : 0,
                    finishedAt: new Date().toISOString(),
                });
                if (failed) {
                    exitFn(1);
                } else {
                    console.log(`seq complete: ${seq.units.filter((u) => u.state === 'done').length}/${seq.units.length} merged`);
                    console.log(`merge:  git merge orch/${jobSlug}`);
                    exitFn(0);
                }
                return;
            }

            // Re-attach to a live running unit instead of spawning a duplicate.
            const live = seq.units.find((u) => u.state === 'running' && u.slug);
            if (live) {
                const terminal = await waitForUnit(live.id, live.slug);
                if (terminal === 'interrupted') {
                    exitFn(exitCodeForSignal('SIGINT'));
                    return;
                }
                if (terminal !== 'done') {
                    console.log(`[${live.id} …] ${terminal}`);
                    const liveSlug = live.slug;
                    console.log(`stopped: chain halted; next: orch continue ${liveSlug} "fix …"`);
                    writeSeqFn(invocationCwd, jobSlug, {
                        ...readSeqFn(invocationCwd, jobSlug),
                        state: 'failed',
                        finishedAt: new Date().toISOString(),
                    });
                    jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                    exitFn(1);
                    return;
                }
                console.log(`[${live.id} …] done — merging`);
                await mergeOneUnitFn({
                    cwd: invocationCwd,
                    parentSlug: jobSlug,
                    unitId: live.id,
                    unitBranch: `orch/${live.slug}`,
                    agent: options.agent,
                    AgentClass,
                    maxRounds,
                    verbose,
                    jobSlug,
                    jobCwd,
                    createWorktree: createWorktreeFn,
                    commitWorktree: commitWorktreeFn,
                    execFile: execFileFn,
                    exit: exitFn,
                });
                seq = readSeqFn(invocationCwd, jobSlug);
                await runAdjust(seq);
                continue;
            }

            const tip = seq.tip;
            const unitSlug = await spawnUnitChild(firstPending, tip);
            const terminal = await waitForUnit(firstPending.id, unitSlug);
            if (terminal === 'interrupted') {
                exitFn(exitCodeForSignal('SIGINT'));
                return;
            }
            if (terminal !== 'done') {
                console.log(`[${firstPending.id} …] ${terminal}`);
                console.log(`stopped: chain halted; next: orch continue ${unitSlug} "fix …"`);
                writeSeqFn(invocationCwd, jobSlug, {
                    ...readSeqFn(invocationCwd, jobSlug),
                    state: 'failed',
                    finishedAt: new Date().toISOString(),
                });
                jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                exitFn(1);
                return;
            }

            console.log(`[${firstPending.id} …] done — merging`);
            await mergeOneUnitFn({
                cwd: invocationCwd,
                parentSlug: jobSlug,
                unitId: firstPending.id,
                unitBranch: `orch/${unitSlug}`,
                agent: options.agent,
                AgentClass,
                maxRounds,
                verbose,
                jobSlug,
                jobCwd,
                createWorktree: createWorktreeFn,
                commitWorktree: commitWorktreeFn,
                execFile: execFileFn,
                exit: exitFn,
            });
            seq = readSeqFn(invocationCwd, jobSlug);
            await runAdjust(seq);
        }
    };

    try {
        if (fromSlug) {
            const seqDoc = readSeqFn(invocationCwd, fromSlug);
            if (!seqDoc) {
                console.error(`Error: unknown parent ${fromSlug} (no seq.json found)`);
                exitFn(1);
                return;
            }

            const pending = (seqDoc.units ?? []).filter((u) => u.state === 'pending');
            const runningUnits = (seqDoc.units ?? []).filter((u) => u.state === 'running');
            const failedUnits = (seqDoc.units ?? []).filter((u) => u.state === 'failed');
            const allTerminal = (seqDoc.units ?? []).every((u) =>
                u.state === 'done' || u.state === 'failed' || u.state === 'skipped');

            if (seqDoc.state === 'running') {
                const job = reconcileJobFn(invocationCwd, fromSlug, readJob(invocationCwd, fromSlug));
                const liveCoordinator = job
                    && job.state === 'running'
                    && job.pid
                    && isPidAliveFn(job.pid)
                    && job.pid !== process.pid;
                if (liveCoordinator) {
                    console.error(`Error: seq ${fromSlug} is already running (pid ${job.pid})`);
                    exitFn(1);
                    return;
                }
            }

            if (allTerminal && pending.length === 0 && runningUnits.length === 0) {
                if (failedUnits.length > 0 || seqDoc.state === 'failed') {
                    console.log(`seq ${fromSlug}: already failed; no pending units left`);
                    exitFn(1);
                    return;
                }
                console.log(`seq ${fromSlug}: already done; nothing to run`);
                exitFn(0);
                return;
            }

            taskPrompt = seqDoc.task;
            maxUnits = seqDoc.maxUnits ?? maxUnits;

            // Reuse the decompose job record as coordinator (do not allocate a second slug).
            jobPatch({
                state: 'running',
                role: 'coordinator',
                phase: 'schedule',
                stage: null,
                round: null,
                finishedAt: null,
                exitCode: null,
                task: taskPrompt,
                pid: process.pid,
            });

            // v1 tip drift: if planned tip ≠ HEAD, advance tip to current HEAD.
            let tip = seqDoc.tip || seqDoc.base;
            if (seqDoc.state === 'planned') {
                const head = execFileFn('git', ['-C', invocationCwd, 'rev-parse', 'HEAD']).trim();
                if (tip && tip !== head) {
                    tip = head;
                } else if (!tip) {
                    tip = head;
                }
            }

            const worktree = ensureSeqCoordinatorWorktree({
                cwd: invocationCwd,
                slug: jobSlug,
                base: tip,
                createWorktreeFn,
                execFileFn,
            });
            jobPatch({ branch: worktree.branch, worktree: worktree.worktreePath });

            writeSeqFn(invocationCwd, jobSlug, {
                ...seqDoc,
                tip,
                state: 'running',
                finishedAt: null,
            });

            console.log(`from: ${fromSlug} (${(seqDoc.units ?? []).length} units) — skipping triage/decompose`);
            await runScheduleLoop();
            return;
        }

        jobPatch({ phase: 'triage', stage: 'triage', round: null });
        const triage = triageAgentArgs({ prompt: taskPrompt, cwd: invocationCwd });
        const triageAgent = new AgentClass(triage.name, triage.instructions, triage.prompt, triage.options);
        const triageResult = await triageAgent.run({ verbose });
        await jobCheckpoint();
        const { content: triageContent, summary: triageSummary } = splitStageSummary(triageResult.result);
        printStageSummary('triage', resolveStageSummary('triage', triageSummary, triageContent));
        const parsed = parseTriageJson(triageContent);

        if (parsed?.simple === true) {
            console.log('triage: simple — seq skipped (quick-fix)');
            jobPatch({ phase: 'quick-fix', stage: 'quick-fix', round: null });
            const quickFix = quickFixAgentArgs({ prompt: taskPrompt, cwd: invocationCwd, fix_plan: parsed.fix_plan });
            const quickFixTracker = new FileTracker({ cwd: invocationCwd });
            const quickFixAgent = new AgentClass(
                quickFix.name,
                quickFix.instructions,
                quickFix.prompt,
                { ...quickFix.options, fileTracker: quickFixTracker },
            );
            const quickFixResult = await quickFixAgent.run({ verbose });
            await jobCheckpoint();
            const { content: quickFixContent, summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', resolveStageSummary('quick-fix', quickFixSummary, quickFixContent), quickFixTracker.getFiles());
            jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
            exitFn(0);
            return;
        }

        console.log('triage: complex — seq requested');

        let feedback;
        let decision = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            jobPatch({ phase: 'decompose', stage: 'seq-decomposer', round: attempt });
            const decomposer = seqDecomposerAgentArgs({
                prompt: taskPrompt, cwd: invocationCwd, maxUnits, feedback,
            });
            const decomposerAgent = new AgentClass(decomposer.name, decomposer.instructions, decomposer.prompt, decomposer.options);
            const decomposerResult = await decomposerAgent.run({ verbose });
            await jobCheckpoint();
            const { content: decomposerContent, summary: decomposerSummary } = splitStageSummary(decomposerResult.result);
            printStageSummary('seq-decomposer', resolveStageSummary('seq-decomposer', decomposerSummary, decomposerContent));

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

            const violations = validateSeqDecomposition(parsedDecomposition, { maxUnits });
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
            await runDeclinePipeline();
            return;
        }

        const { decomposition } = decision;
        const base = execFileFn('git', ['-C', invocationCwd, 'rev-parse', 'HEAD']).trim();

        await ensureSeqCoordinatorWorktree({
            cwd: invocationCwd,
            slug: jobSlug,
            base,
            createWorktreeFn,
            execFileFn,
        });

        const units = decomposition.units.map((unit) => ({
            id: unit.id,
            title: unit.title,
            subtask: unit.subtask,
            state: 'pending',
            slug: null,
            sha: null,
            changedFiles: null,
        }));

        writeSeqFn(invocationCwd, jobSlug, {
            version: 1,
            parentSlug: jobSlug,
            task: taskPrompt,
            base,
            tip: base,
            maxUnits,
            units,
            adjustments: [],
            state: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
        });

        console.log(`decomposer: ${units.length} units`);
        await runScheduleLoop();
    } catch (err) {
        console.error(`Error: ${err.message}`);
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: taskPrompt,
                });
            } catch {
                // Best-effort.
            }
        }
        exitFn(1);
    }
}

/**
 * Hidden `--seq-continue <parent>`: merge any done-but-unmerged units, adjust,
 * then continue the pending schedule loop.
 */
export async function runSeqContinuePipeline(options = {}) {
    const verbose = Boolean(options.verbose);
    const maxRounds = options.maxRounds ?? 5;
    const backend = AGENT_BACKENDS[options.agent];
    if (!backend) {
        throw new Error(`Unknown agent backend: ${options.agent}`);
    }
    const AgentClass = options.AgentClass ?? backend.AgentClass;
    const invocationCwd = options.cwd ?? process.cwd();
    const parentSlug = options.parentSlug;
    const exitFn = options.exit ?? ((code) => process.exit(code));
    const pollIntervalMs = options.pollIntervalMs ?? 500;

    const createWorktreeFn = options.createWorktree ?? createWorktree;
    const commitWorktreeFn = options.commitWorktree ?? commitWorktree;
    const spawnFn = options.spawn ?? spawn;
    const execFileFn = options.execFile ?? defaultExecFile;
    const allocateJobFn = options.allocateJob ?? allocateJob;
    const reconcileJobFn = options.reconcileJob ?? reconcileJob;
    const readSeqFn = options.readSeq ?? readSeq;
    const writeSeqFn = options.writeSeq ?? writeSeq;
    const patchUnitFn = options.patchUnit ?? patchUnit;
    const appendAdjustmentFn = options.appendAdjustment ?? appendAdjustment;
    const mergeOneUnitFn = options.mergeOneUnit ?? mergeOneUnit;

    const jobSlug = options.jobSlug ?? parentSlug ?? process.env.ORCH_JOB_SLUG;
    const jobCwd = options.jobCwd ?? invocationCwd;
    const patchJobFn = options.patchJob ?? patchJob;
    const checkpointPauseFn = options.checkpointPause ?? checkpointPause;
    const pausePollIntervalMs = options.pausePollIntervalMs ?? 500;

    const jobPatch = (fields) => {
        if (!jobSlug) return;
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
    };
    const jobCheckpoint = async () => {
        if (!jobSlug) return;
        await checkpointPauseFn(jobCwd, jobSlug, { pollIntervalMs: pausePollIntervalMs });
    };

    const seq = readSeqFn(invocationCwd, parentSlug);
    if (!seq) {
        console.error(`Error: unknown parent ${parentSlug} (no seq.json found)`);
        exitFn(1);
        return;
    }

    const maxUnits = seq.maxUnits ?? 8;
    const prompt = seq.task;

    const runAdjust = async (seqDoc) => {
        const doneUnits = seqDoc.units.filter((u) => u.state === 'done');
        const pendingUnits = seqDoc.units.filter((u) => u.state === 'pending');
        if (pendingUnits.length === 0) return seqDoc;

        let feedback;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const adjust = adjustAgentArgs({
                originalTask: prompt,
                doneUnits,
                pendingUnits,
                tip: seqDoc.tip,
                cwd: invocationCwd,
                maxUnits,
                feedback,
            });
            const adjustAgent = new AgentClass(adjust.name, adjust.instructions, adjust.prompt, adjust.options);
            const adjustResult = await adjustAgent.run({ verbose });
            await jobCheckpoint();
            const { content: adjustContent } = splitStageSummary(adjustResult.result);
            const parsed = parseDecomposition(adjustContent);
            if (!parsed) {
                feedback = ['adjust output was not valid JSON'];
                continue;
            }
            const violations = validateAdjustResult(parsed, { units: seqDoc.units, maxUnits });
            if (violations.length === 0) {
                const applied = applyAdjustResult(seqDoc, parsed);
                writeSeqFn(invocationCwd, parentSlug, applied);
                appendAdjustmentFn(invocationCwd, parentSlug, {
                    afterUnitId: doneUnits[doneUnits.length - 1]?.id ?? null,
                    tip: applied.tip,
                    summary: 'seq-continue adjust',
                });
                return applied;
            }
            feedback = violations;
        }
        return seqDoc;
    };

    const spawnUnitChild = async (unit) => {
        const envelope = buildUnitEnvelope({
            id: unit.id,
            title: unit.title,
            subtask: unit.subtask,
            originalTask: prompt,
        });
        const unitPrompt = `${unit.subtask}\n\n${envelope}`;
        const allocated = await allocateJobFn({
            cwd: invocationCwd,
            prompt: unitPrompt,
            agent: options.agent,
            maxRounds,
            state: 'starting',
            parent: parentSlug,
            role: 'worker',
            workerId: unit.id,
        });
        const unitSlug = allocated.slug;
        patchUnitFn(invocationCwd, parentSlug, unit.id, { slug: unitSlug, state: 'running' });
        const { logPath } = jobPaths(invocationCwd, unitSlug);
        const logFd = fs.openSync(logPath, 'a');
        const childArgs = [
            __filename, unitPrompt,
            '--agent', options.agent,
            '--max-rounds', String(maxRounds),
            '--unit', `${parentSlug}:${unit.id}`,
        ];
        const child = spawnFn(process.execPath, childArgs, {
            cwd: invocationCwd,
            env: {
                ...process.env,
                ORCH_JOB_SLUG: unitSlug,
                ORCH_DETACHED: '1',
                ORCH_SEQ_DEPTH: '1',
                ORCH_FANOUT_DEPTH: '1',
            },
            detached: true,
            stdio: ['ignore', logFd, logFd],
        });
        child.unref();
        patchJobFn(invocationCwd, unitSlug, { pid: child.pid, state: 'running' });
        return unitSlug;
    };

    const waitForUnit = async (unitId, unitSlug) => {
        for (;;) {
            await sleep(pollIntervalMs);
            await jobCheckpoint();
            const current = readSeqFn(invocationCwd, parentSlug);
            const unit = current?.units?.find((u) => u.id === unitId);
            if (unit && (unit.state === 'done' || unit.state === 'failed')) return unit.state;
            const job = reconcileJobFn(invocationCwd, unitSlug, readJob(invocationCwd, unitSlug));
            if (job && TERMINAL_JOB_STATES.includes(job.state)) {
                return job.state === 'done' ? 'done' : 'failed';
            }
        }
    };

    try {
        jobPatch({ state: 'running', phase: 'schedule', finishedAt: null, exitCode: null });
        writeSeqFn(invocationCwd, parentSlug, { ...seq, state: 'running', finishedAt: null });

        // Merge any done units whose tip may not yet include them (done-but-unmerged).
        let current = readSeqFn(invocationCwd, parentSlug);
        for (const unit of current.units) {
            if (unit.state === 'done' && unit.slug) {
                // Heuristic: merge if unit sha is set and tip still looks like an earlier base,
                // or always attempt merge of the most recent done unit that hasn't been adjusted after.
                const alreadyAdjusted = (current.adjustments || []).some((a) => a.afterUnitId === unit.id);
                if (!alreadyAdjusted) {
                    await mergeOneUnitFn({
                        cwd: invocationCwd,
                        parentSlug,
                        unitId: unit.id,
                        unitBranch: `orch/${unit.slug}`,
                        agent: options.agent,
                        AgentClass,
                        maxRounds,
                        verbose,
                        jobSlug,
                        jobCwd,
                        createWorktree: createWorktreeFn,
                        commitWorktree: commitWorktreeFn,
                        execFile: execFileFn,
                        exit: (code) => {
                            if (code !== 0) throw new Error(`merge of ${unit.id} failed`);
                        },
                    });
                    current = await runAdjust(readSeqFn(invocationCwd, parentSlug));
                }
            }
        }

        for (;;) {
            await jobCheckpoint();
            current = readSeqFn(invocationCwd, parentSlug);
            const pending = current.units.find((u) => u.state === 'pending');
            if (!pending) {
                writeSeqFn(invocationCwd, parentSlug, {
                    ...current,
                    state: 'done',
                    finishedAt: new Date().toISOString(),
                });
                jobPatch({ state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
                exitFn(0);
                return;
            }

            const unitSlug = await spawnUnitChild(pending);
            const terminal = await waitForUnit(pending.id, unitSlug);
            if (terminal !== 'done') {
                writeSeqFn(invocationCwd, parentSlug, {
                    ...readSeqFn(invocationCwd, parentSlug),
                    state: 'failed',
                    finishedAt: new Date().toISOString(),
                });
                jobPatch({ state: 'failed', exitCode: 1, finishedAt: new Date().toISOString() });
                exitFn(1);
                return;
            }

            await mergeOneUnitFn({
                cwd: invocationCwd,
                parentSlug,
                unitId: pending.id,
                unitBranch: `orch/${unitSlug}`,
                agent: options.agent,
                AgentClass,
                maxRounds,
                verbose,
                jobSlug,
                jobCwd,
                createWorktree: createWorktreeFn,
                commitWorktree: commitWorktreeFn,
                execFile: execFileFn,
                exit: exitFn,
            });
            await runAdjust(readSeqFn(invocationCwd, parentSlug));
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        exitFn(1);
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
        return patchJobCursor(patchJobFn, jobCwd, jobSlug, fields);
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
                const exitCode = exitCodeForSignal(signal);
                const finishedAt = new Date().toISOString();
                patchJobFn(jobCwd, jobSlug, (current) => ({
                    state: 'stopped',
                    exitCode,
                    finishedAt,
                    lastOutcome: buildLastOutcome({
                        state: 'stopped',
                        phase: current.phase,
                        stage: current.stage,
                        round: current.round,
                        exitCode,
                        finishedAt,
                        task: prompt,
                        summary: '',
                        error: null,
                    }),
                }));
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
        printStageSummary('triage', resolveStageSummary('triage', triageSummary, triageContent));
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
            const { content: quickFixContent, summary: quickFixSummary } = splitStageSummary(quickFixResult.result);
            printStageSummary('quick-fix', resolveStageSummary('quick-fix', quickFixSummary, quickFixContent), quickFixTracker.getFiles());
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
        printStageSummary('boundaries', resolveStageSummary('boundaries', boundariesSummary, boundariesOutput));
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
            printStageSummary('decomposer', resolveStageSummary('decomposer', decomposerSummary, decomposerContent));

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
            printStageSummary('research', resolveStageSummary('research', researchSummary, researchContent));

            jobPatch({ phase: 'plan', stage: 'planner', round: null });
            const planner = plannerAgentArgs({
                prompt, cwd: invocationCwd, researchPath: runContext.researchPath, taskPath: runContext.taskPath, researchOutput: researchContent,
            });
            const plannerAgent = new AgentClass(planner.name, planner.instructions, planner.prompt, planner.options);
            const plannerResult = await plannerAgent.run({ verbose });
            await jobCheckpoint();
            const { content: plannerContent, summary: plannerSummary } = splitStageSummary(plannerResult.result);
            printStageSummary('planner', resolveStageSummary('planner', plannerSummary, plannerContent));

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
                researchPath: runContext.researchPath,
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
                researchPath: runContext.researchPath,
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

        /** Spawns up to `concurrency` of `workerIds` at a time, polling to terminal state.
         * Honors `jobCheckpoint` before each spawn and on each poll tick; while paused does
         * not spawn or advance. Re-attaches to still-live children instead of re-spawning;
         * skips workers already `done`/`failed`/`skipped`. */
        const runWorkerGroup = async (workerIds, concurrency) => {
            const byId = new Map(workers.map((w) => [w.id, w]));
            const pending = [...workerIds];
            const active = new Map();

            while (pending.length > 0 || active.size > 0) {
                while (active.size < concurrency && pending.length > 0) {
                    await jobCheckpoint();
                    if (interrupted) throw new FanoutInterrupted();

                    const id = pending.shift();
                    const fanoutWorker = readFanoutFn(invocationCwd, jobSlug).workers.find((w) => w.id === id);

                    if (fanoutWorker && ['done', 'failed', 'skipped'].includes(fanoutWorker.state)) {
                        continue;
                    }

                    if (fanoutWorker?.slug) {
                        const existing = readJob(invocationCwd, fanoutWorker.slug);
                        if (existing && !TERMINAL_JOB_STATES.includes(existing.state)) {
                            // Re-attach to a still-live child — do not spawn a duplicate.
                            active.set(id, { workerSlug: fanoutWorker.slug, spawnedAt: Date.now() });
                            continue;
                        }
                        if (existing && TERMINAL_JOB_STATES.includes(existing.state)) {
                            if (fanoutWorker.state !== 'done' && fanoutWorker.state !== 'failed') {
                                patchWorkerFn(invocationCwd, jobSlug, id, { state: 'failed' });
                            }
                            continue;
                        }
                    }

                    // Spawn only still-pending workers (no slug / not live or terminal).
                    const workerSlug = spawnWorkerChild(byId.get(id));
                    active.set(id, { workerSlug, spawnedAt: Date.now() });
                }
                if (active.size === 0) break;

                await sleep(pollIntervalMs);
                if (interrupted) throw new FanoutInterrupted();
                await jobCheckpoint();

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
        await jobCheckpoint();
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
        await jobCheckpoint();
        const integrationGate = readFanoutFn(invocationCwd, jobSlug).integration;
        const integrationAlreadyDone = integrationGate?.state === 'done';
        let integrationSlug = integrationGate?.slug ?? null;
        let integrationLive = false;
        if (integrationSlug && !integrationAlreadyDone) {
            const existingIntegrate = readJob(invocationCwd, integrationSlug);
            integrationLive = Boolean(existingIntegrate && !TERMINAL_JOB_STATES.includes(existingIntegrate.state));
        }

        if (integrationAlreadyDone) {
            integrationDone = true;
            console.log(`[integrate ${integrationSlug ?? 'done'}] already done — skipping spawn`);
        } else if (integrationLive) {
            // Re-attach to an already-live integrate child; do not spawn a duplicate.
            console.log(`[integrate ${integrationSlug}] re-attached`);
            const integrateSpawnedAt = Date.now();
            for (;;) {
                await sleep(pollIntervalMs);
                if (interrupted) throw new FanoutInterrupted();
                await jobCheckpoint();

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
        } else if (doneWorkers.length > 0) {
            const envelope = buildIntegrationEnvelope({
                task: prompt,
                branches: doneWorkers.map((w) => w.branch),
                overlappingFiles: overlapUnion,
            });

            const allocated = allocateJobFn({
                cwd: invocationCwd,
                prompt: envelope,
                agent: options.agent,
                maxRounds,
                state: 'starting',
                parent: jobSlug,
                role: 'integration',
            });
            integrationSlug = allocated.slug;
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
                await jobCheckpoint();

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

        const finishedAt = new Date().toISOString();
        const summary = success
            ? `fan-out complete: ${doneWorkers.length} worker${doneWorkers.length === 1 ? '' : 's'} integrated`
            : (failedWorkers.length > 0
                ? `${failedWorkers.length} worker(s) failed`
                : 'fan-out failed');
        patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
            state: success ? 'done' : 'failed',
            exitCode: success ? 0 : 1,
            summary,
            error: success ? null : summary,
            task: prompt,
        });
        exitFn(success ? 0 : 1);
    } catch (err) {
        if (err instanceof FanoutInterrupted) return;
        console.error(`Error: ${err.message}`);
        if (jobSlug) {
            try {
                patchTerminalJob(patchJobFn, jobCwd, jobSlug, {
                    state: 'failed',
                    exitCode: 1,
                    summary: '',
                    error: err.message,
                    task: prompt,
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

/** CLI glue for `--unit`: resolves the parent seq/unit record, builds the unit
 * envelope, allocates (or reuses) the job record, then calls `runUnitPipeline`. */
async function runUnitFromCli(options) {
    const cwd = process.cwd();
    const { parentSlug, workerId: unitId } = splitParentWorker(options.unit);
    if (!parentSlug || !unitId) {
        console.error(`Error: --unit must be in the form <parent-slug>:<unit-id>, got "${options.unit}"`);
        process.exit(1);
        return;
    }

    process.env.ORCH_SEQ_DEPTH = '1';
    process.env.ORCH_FANOUT_DEPTH = '1';

    const seq = readSeq(cwd, parentSlug);
    if (!seq) {
        console.error(`Error: unknown parent ${parentSlug} (no seq.json found)`);
        process.exit(1);
        return;
    }

    const unit = seq.units.find((u) => u.id === unitId);
    if (!unit) {
        console.error(`Error: unknown unit ${unitId} in ${parentSlug}`);
        process.exit(1);
        return;
    }

    const envelope = buildUnitEnvelope({
        id: unit.id,
        title: unit.title,
        subtask: unit.subtask,
        originalTask: seq.task,
    });
    const unitPrompt = `${unit.subtask}\n\n${envelope}`;

    let jobSlug = process.env.ORCH_JOB_SLUG;
    if (!jobSlug) {
        const alloc = allocateJob({
            cwd,
            prompt: unitPrompt,
            agent: options.agent,
            maxRounds: options.maxRounds,
            state: 'running',
            pid: process.pid,
            parent: parentSlug,
            role: 'worker',
            workerId: unitId,
        });
        jobSlug = alloc.slug;
    }
    setJobSlug(jobSlug);

    await runUnitPipeline(unitPrompt, {
        agent: options.agent,
        maxRounds: options.maxRounds,
        verbose: options.verbose,
        cwd,
        parentSlug,
        unitId,
        base: seq.tip,
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

/** Resolve the effective agent (CLI > local > global > cursor) or exit 1. */
function resolveAgentOrExit(cliAgent, cwd = process.cwd()) {
    try {
        return resolveAgent({ cliAgent, cwd });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
        return undefined;
    }
}

/**
 * Resolve CLI `--notify` / `--no-notify` to `true` | `false` | `undefined`.
 * Commander stores both on `opts.notify` (negatable); detect both-via-argv
 * for the mutual-exclusion error.
 */
function cliNotifyFromOptions(options, argv = process.argv) {
    const hasNotify = argv.includes('--notify');
    const hasNoNotify = argv.includes('--no-notify');
    if (hasNotify && hasNoNotify) {
        console.error('Error: --notify and --no-notify are mutually exclusive');
        process.exit(1);
        return undefined;
    }
    if (options.notify === true) return true;
    if (options.notify === false) return false;
    return undefined;
}

function resolveNotifyOrExit(cliNotify, cwd = process.cwd()) {
    try {
        return resolveNotify({ cliNotify, cwd });
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
        return undefined;
    }
}

/** Apply process-level notify gate from CLI flags + config (skip for dry-run). */
function applyNotifyEnabled(options, { cwd = process.cwd(), dryRun = false } = {}) {
    if (dryRun) {
        setNotifyEnabled(false);
        return false;
    }
    const cliNotify = cliNotifyFromOptions(options);
    const enabled = resolveNotifyOrExit(cliNotify, cwd);
    setNotifyEnabled(enabled);
    return enabled;
}

/** Append `--notify` / `--no-notify` to child argv when the parent had an explicit flag. */
function appendNotifyArgs(args, notify) {
    if (notify === true) args.push('--notify');
    else if (notify === false) args.push('--no-notify');
}

const program = new Command();

program
    .name('orch')
    .version(version)
    .description('The Orchestrator: triage → research → plan → implement pipeline against a task')
    .argument('[task...]', 'Task description to use as the prompt (mention a file path and the agent will read it)')
    .option('-v, --verbose', 'Stream agent thinking/output deltas to stderr as the pipeline runs')
    .option('--dry-run', 'Check that the selected agent CLI is on PATH and exit; do not run the pipeline')
    .option('--ask', 'Ask a read-only question about the codebase; print the reply and exit (skips triage and all write pipelines). Pair with --from <slug> for a same-session follow-up via ask.json')
    .option('--quick', 'Skip triage, run quick-fix directly in the current working tree; create no artifacts, worktrees, or commits')
    .option('--detach', 'Run the pipeline in the background and return immediately; manage it with orch list/status/pause/resume/stop/logs. Cannot be combined with --ask, --quick, or --dry-run')
    .option('--pr', 'Always create a worktree, commit, push orch/<slug>, and open a pull request with gh (including triage → quick-fix; skips research/planner on that path). Requires gh on PATH and authenticated. Cannot be combined with --ask, --quick, or --dry-run')
    .option('--base <branch>', 'Remote base branch for the worktree start point and (with --pr) the pull request base; defaults to the remote\'s default branch when --pr is set')
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop (ignored with --ask and --quick)', positiveIntParser('--max-rounds'), 5)
    .option('--fan-out', 'Decompose into parallel workers, then integrate once. Cannot be combined with --ask, --quick, --dry-run, --seq, or --decompose')
    .option('--seq', 'Decompose into ordered units; merge each, then adjust the next. With --from <slug>, run a planned backlog without re-decomposing. Cannot be combined with --fan-out, --ask, --quick, --dry-run, or --decompose')
    .option('--decompose', 'Plan-only sequential decomposition: research, write seq.json (state planned), and exit. Run later with --seq --from <slug>. Cannot be combined with --seq, --fan-out, --ask, --quick, --dry-run, or --from')
    .option('--from <slug>', 'With --seq or --ask: load seq.json schedule or continue ask.json for <slug>. With --ask, requires a follow-up prompt and reuses the ask slug')
    .option('--max-workers <n>', 'Max number of parallel fan-out workers (only meaningful with --fan-out)', positiveIntParser('--max-workers'), 4)
    .option('--max-units <n>', 'Max number of sequential units (meaningful with --seq or --decompose; rejected with --from)', positiveIntParser('--max-units'), 8)
    .option('--max-concurrency <n>', 'Optional hard ceiling on in-flight fan-out workers at once (only meaningful with --fan-out; default: coordinator chooses)', positiveIntParser('--max-concurrency'))
    .option('--notify', 'Enable desktop notification when a job reaches a terminal state (default: on)')
    .option('--no-notify', 'Disable desktop notifications for this run')
    .addOption(
        new Option('--agent <agent>', 'Agent backend to run the pipeline with: "cursor" (Cursor Agent CLI), "claude" (Claude Code CLI), "agn" (agn CLI), or "opencode" (OpenCode CLI). Omitting uses local then global config, else cursor')
            .choices(['cursor', 'claude', 'agn', 'opencode']),
    )
    .addOption(new Option('--worker <value>', 'internal: run a single fan-out worker "<parent-slug>:<worker-id>"').hideHelp())
    .addOption(new Option('--unit <value>', 'internal: run a single seq unit "<parent-slug>:<unit-id>"').hideHelp())
    .addOption(new Option('--integrate <value>', 'internal: (re)run fan-out integration for "<parent-slug>"').hideHelp())
    .addOption(new Option('--seq-continue <value>', 'internal: resume a seq coordinator after a fixed unit "<parent-slug>"').hideHelp())
    .addHelpText(
        'after',
        `
Examples:
  $ orch "fix the typo in the README" --agent claude
  $ orch "fix the bug described in task.md" --agent cursor -v
  $ orch "implement the local spec" --agent agn -v
  $ orch "fix the typo in the README" --agent opencode
  $ orch --ask "where is the CLI entrypoint?" --agent claude
  $ orch --ask --from <slug> "and how is triage wired?" --agent claude
  $ orch --quick "fix the typo in the README" --agent claude
  $ orch "noop" --dry-run --agent cursor
  $ orch "noop" --dry-run --agent opencode
  $ orch config                                          # print effective agent
  $ orch config --agent claude                           # pin global default
  $ orch config --agent agn --local                      # pin project default
  $ orch config --agent opencode                         # pin OpenCode as default

Headless runs:
  $ orch "long-running task" --detach --agent claude   # start in the background, prints the run slug
  $ orch "implement the flag" --pr --agent claude      # push and open a PR after commit
  $ orch "implement the flag" --pr --base develop      # PR against develop; worktree starts at origin/develop
  $ orch list                                          # show all tracked runs
  $ orch status [slug]                                 # show full status (defaults to most recent)
  $ orch pause <slug>                                  # request a pause at the next stage boundary
  $ orch resume <slug>                                 # unpause live pause, or recover failed/stopped/crashed
  $ orch resume <slug> --detach                        # recover a failed/stopped/crashed job in the background
  $ orch continue <slug> "new task"                    # new work on a done run's worktree
                                                       # (workers: same command; then re-integrate the parent)
  $ orch continue <slug> "new task" --detach           # same, backgrounded under the same slug
  $ orch stop <slug>                                   # send SIGTERM to a running job
  $ orch logs <slug> [-f]                              # print (or follow) a run's log file

Fan-out:
  $ orch "implement the billing module" --fan-out --agent claude   # triage, decompose, run parallel workers, integrate
  $ orch "implement X" --fan-out --max-workers 6 --max-concurrency 3

Sequential (--seq):
  $ orch "implement the billing module" --seq --agent claude
  $ orch "implement X" --seq --max-units 6
  $ orch --seq --from wise-pine-e904

Decompose (plan only):
  $ orch "implement the billing module" --decompose --agent claude
  $ orch "fix the typo" --decompose --max-units 6
  $ orch "…" --decompose --detach
`,
    )
    .action(async (task, options) => {
        const prompt = (Array.isArray(task) ? task : []).join(' ').trim();

        // Capture before resolveAgent fills a config default — needed so
        // `--ask --from` can fall back to session.agent when --agent is omitted.
        const cliAgentExplicit = Boolean(options.agent);
        options.agent = resolveAgentOrExit(options.agent);
        options.cliAgentExplicit = cliAgentExplicit;
        applyNotifyEnabled(options, { dryRun: Boolean(options.dryRun) });

        if (options.seqContinue) {
            const cwd = process.cwd();
            const parentSlug = options.seqContinue;
            const seq = readSeq(cwd, parentSlug);
            if (!seq) {
                console.error(`Error: unknown parent ${parentSlug} (no seq.json found)`);
                process.exit(1);
                return;
            }
            let jobSlug = process.env.ORCH_JOB_SLUG;
            if (!jobSlug) {
                jobSlug = parentSlug;
                setJobSlug(jobSlug);
            }
            await runSeqContinuePipeline({
                agent: options.agent,
                maxRounds: options.maxRounds,
                verbose: options.verbose,
                cwd,
                parentSlug,
                jobSlug,
                jobCwd: cwd,
            });
            return;
        }

        if (options.from && !options.seq && !options.ask) {
            console.error('Error: --from requires --seq or --ask');
            process.exit(1);
            return;
        }

        if (options.decompose && options.from) {
            console.error('Error: --decompose cannot be combined with --from');
            process.exit(1);
            return;
        }

        // --seq --from: task comes from seq.json; no free-form prompt.
        if (options.seq && options.from) {
            if (prompt) {
                console.error('Error: --seq --from does not take a task prompt (task comes from seq.json)');
                process.exit(1);
                return;
            }
            if (process.argv.includes('--max-units')) {
                console.error('Error: --max-units cannot be combined with --seq --from (maxUnits is frozen in seq.json)');
                process.exit(1);
                return;
            }

            const conflicts = ['ask', 'quick', 'dryRun', 'decompose', 'fanOut']
                .filter((key) => options[key])
                .map((key) => {
                    if (key === 'dryRun') return '--dry-run';
                    if (key === 'fanOut') return '--fan-out';
                    return `--${key}`;
                });
            if (conflicts.length > 0) {
                console.error(`Error: --seq --from cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            if (process.env.ORCH_SEQ_DEPTH || process.env.ORCH_FANOUT_DEPTH) {
                console.error('Error: --seq cannot be used inside a seq/fan-out child (ORCH_SEQ_DEPTH or ORCH_FANOUT_DEPTH is already set)');
                process.exit(1);
                return;
            }

            const cwd = process.cwd();
            const fromSlug = options.from;
            const seq = readSeq(cwd, fromSlug);
            if (!seq) {
                console.error(`Error: unknown parent ${fromSlug} (no seq.json found)`);
                process.exit(1);
                return;
            }

            if (options.detach) {
                await runDetached(seq.task, {
                    ...options,
                    seq: true,
                    fromSlug,
                    notify: cliNotifyFromOptions(options),
                });
                return;
            }

            setJobSlug(fromSlug);
            await runSeqPipeline(seq.task, {
                ...options,
                cwd,
                jobSlug: fromSlug,
                jobCwd: cwd,
                fromSlug,
                maxUnits: seq.maxUnits ?? options.maxUnits,
            });
            return;
        }

        if (!prompt) {
            // `[task...]` stays optional so hidden `--seq-continue` / `--from` can omit a
            // positional; still mirror commander's required-arg error when argv
            // has no task parts at all (vs empty/whitespace → cannot be empty).
            const taskParts = Array.isArray(task) ? task : [];
            if (taskParts.length === 0) {
                console.error("error: missing required argument 'task'");
            } else {
                console.error('Error: task cannot be empty');
            }
            process.exit(1);
            return;
        }

        if (options.seq && options.fanOut) {
            console.error('Error: --seq cannot be combined with --fan-out');
            process.exit(1);
            return;
        }

        if (options.decompose && options.seq) {
            console.error('Error: --decompose cannot be combined with --seq');
            process.exit(1);
            return;
        }

        if (options.decompose && options.fanOut) {
            console.error('Error: --decompose cannot be combined with --fan-out');
            process.exit(1);
            return;
        }

        if (options.pr) {
            const prConflicts = ['ask', 'quick', 'dryRun']
                .filter((key) => options[key])
                .map((key) => `--${key === 'dryRun' ? 'dry-run' : key}`);
            if (prConflicts.length > 0) {
                console.error(`Error: --pr cannot be combined with ${prConflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            ensureGhAuthenticated();
        }

        if (options.decompose) {
            const conflicts = ['ask', 'quick', 'dryRun', 'seq', 'fanOut', 'from']
                .filter((key) => options[key])
                .map((key) => {
                    if (key === 'dryRun') return '--dry-run';
                    if (key === 'fanOut') return '--fan-out';
                    if (key === 'from') return '--from';
                    return `--${key}`;
                });
            if (conflicts.length > 0) {
                console.error(`Error: --decompose cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }

            if (options.detach) {
                await runDetached(prompt, {
                    ...options,
                    decompose: true,
                    maxUnits: options.maxUnits,
                    notify: cliNotifyFromOptions(options),
                });
                return;
            }

            const cwd = process.cwd();
            let slug = process.env.ORCH_JOB_SLUG;
            if (!slug) {
                const alloc = allocateJob({
                    cwd,
                    prompt,
                    agent: options.agent,
                    maxRounds: options.maxRounds,
                    state: 'running',
                    pid: process.pid,
                    // role stays unset until --seq --from promotes to coordinator
                });
                slug = alloc.slug;
            }
            setJobSlug(slug);

            await runDecomposePipeline(prompt, {
                ...options,
                cwd,
                jobSlug: slug,
                jobCwd: cwd,
                maxUnits: options.maxUnits,
            });
            return;
        }

        if (options.seq) {
            const conflicts = ['ask', 'quick', 'dryRun', 'decompose']
                .filter((key) => options[key])
                .map((key) => (key === 'dryRun' ? '--dry-run' : `--${key}`));
            if (conflicts.length > 0) {
                console.error(`Error: --seq cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            if (process.env.ORCH_SEQ_DEPTH || process.env.ORCH_FANOUT_DEPTH) {
                console.error('Error: --seq cannot be used inside a seq/fan-out child (ORCH_SEQ_DEPTH or ORCH_FANOUT_DEPTH is already set)');
                process.exit(1);
                return;
            }

            if (options.detach) {
                await runDetached(prompt, {
                    ...options,
                    seq: true,
                    maxUnits: options.maxUnits,
                    notify: cliNotifyFromOptions(options),
                });
                return;
            }

            const cwd = process.cwd();
            let slug = process.env.ORCH_JOB_SLUG;
            if (!slug) {
                const alloc = allocateJob({
                    cwd,
                    prompt,
                    agent: options.agent,
                    maxRounds: options.maxRounds,
                    state: 'running',
                    pid: process.pid,
                    role: 'coordinator',
                });
                slug = alloc.slug;
            }
            setJobSlug(slug);

            await runSeqPipeline(prompt, {
                ...options,
                cwd,
                jobSlug: slug,
                jobCwd: cwd,
                maxUnits: options.maxUnits,
            });
            return;
        }

        if (options.fanOut) {
            const conflicts = ['ask', 'quick', 'dryRun', 'decompose']
                .filter((key) => options[key])
                .map((key) => (key === 'dryRun' ? '--dry-run' : `--${key}`));
            if (conflicts.length > 0) {
                console.error(`Error: --fan-out cannot be combined with ${conflicts.join(', ')}`);
                process.exit(1);
                return;
            }
            if (process.env.ORCH_FANOUT_DEPTH || process.env.ORCH_SEQ_DEPTH) {
                console.error('Error: --fan-out cannot be used inside a fan-out/seq child (ORCH_FANOUT_DEPTH or ORCH_SEQ_DEPTH is already set)');
                process.exit(1);
                return;
            }

            if (options.detach) {
                await runDetached(prompt, {
                    ...options,
                    fanOut: true,
                    maxWorkers: options.maxWorkers,
                    maxConcurrency: options.maxConcurrency ?? null,
                    notify: cliNotifyFromOptions(options),
                });
                return;
            }

            const cwd = process.cwd();
            let slug = process.env.ORCH_JOB_SLUG;
            if (!slug) {
                const alloc = allocateJob({
                    cwd,
                    prompt,
                    agent: options.agent,
                    maxRounds: options.maxRounds,
                    state: 'running',
                    pid: process.pid,
                    role: 'coordinator',
                });
                slug = alloc.slug;
            }
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

        if (options.worker || options.integrate || options.unit) {
            const flagName = options.worker ? '--worker' : options.unit ? '--unit' : '--integrate';
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
            } else if (options.unit) {
                await runUnitFromCli(options);
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
            await runDetached(prompt, {
                ...options,
                notify: cliNotifyFromOptions(options),
            });
            return;
        }

        if (!options.dryRun) {
            // Detached (and other) children already carry ORCH_JOB_SLUG from the
            // parent allocation — reuse it so triage/pipeline does not create a
            // second run.json / orch list entry. Mirrors the --seq guard above.
            // `--ask --from <slug>` reuses the existing ask-session slug (never
            // allocateJob a sibling).
            let slug = process.env.ORCH_JOB_SLUG;
            if (!slug) {
                if (options.ask && options.from) {
                    slug = options.from;
                    options.fromSlug = options.from;
                } else {
                    const alloc = allocateJob({
                        cwd: process.cwd(),
                        prompt,
                        agent: options.agent,
                        maxRounds: options.ask || options.quick ? null : options.maxRounds,
                        state: 'running',
                        pid: process.pid,
                    });
                    slug = alloc.slug;
                }
            } else if (options.ask && options.from) {
                options.fromSlug = options.from;
            }
            options.jobSlug = slug;
            setJobSlug(slug);
        }

        await runPipeline(prompt, options);
    });

program
    .command('serve')
    .description(
        'Long-lived home products HTTP server + mobile UI. ' +
        'Products live under ~/.orch/products/; requires gh auth login; ' +
        'blank init creates private GitHub repos; served jobs always --pr. ' +
        'Default bind 0.0.0.0:7333 with NO AUTH — anyone on the LAN who can ' +
        'reach the port can create repos and run agents. Open the UI from a ' +
        'phone at http://<machine-ip>:7333/.',
    )
    .option('--port <n>', 'Listen port (default 7333)', (v) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0) throw new Error('--port must be a non-negative integer');
        return n;
    }, 7333)
    .option('--host <addr>', 'Listen address (default 0.0.0.0 — LAN reachable, no auth)', '0.0.0.0')
    .option('--concurrency <n>', 'Max live jobs across all products', (v) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1) throw new Error('--concurrency must be a positive integer');
        return n;
    }, 2)
    .option('--max-queue <n>', 'Max waiting (queued) jobs', (v) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1) throw new Error('--max-queue must be a positive integer');
        return n;
    }, 64)
    .addOption(
        new Option('--agent <agent>', 'Default agent backend for served jobs')
            .choices(['cursor', 'claude', 'agn', 'opencode']),
    )
    .option('--max-rounds <n>', 'Default max writer⇄critic / writer⇄runner rounds', positiveIntParser('--max-rounds'), 5)
    .option('--base <branch>', 'Default remote base branch for publish')
    .option('--github-owner <owner>', 'Default GitHub owner/org for blank product init (private gh repo create)')
    .action(async (options) => {
        const { startServe } = await import('./lib/serve.js');
        const { runAsk } = await import('./lib/ask-run.js');
        const cwd = process.cwd();
        const agent = resolveAgentOrExit(options.agent, cwd);
        try {
            const handle = await startServe({
                host: options.host,
                port: options.port,
                concurrency: options.concurrency,
                maxQueue: options.maxQueue,
                agent,
                maxRounds: options.maxRounds,
                base: options.base,
                githubOwner: options.githubOwner,
                runDetached,
                runAsk,
                isBinaryOnPath,
                execFileSync,
            });
            const shutdown = async () => {
                try {
                    await handle.close();
                } catch {
                    // ignore close errors on signal
                }
                process.exit(0);
            };
            process.once('SIGINT', () => { void shutdown(); });
            process.once('SIGTERM', () => { void shutdown(); });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('continue')
    .description(
        'Start new complex work on a done run\'s existing worktree (not crash recovery — use orch resume for failed/stopped/crashed). Workers: continue the worker slug, then re-integrate the parent',
    )
    .argument('<slug>', 'Existing run slug under .orch/')
    .argument('<task...>', 'New task prompt for this continue iteration')
    .option('-v, --verbose', 'Stream agent thinking/output deltas to stderr as the pipeline runs')
    .option('--dry-run', 'Validate eligibility and agent PATH; do not reopen the job or run agents')
    .option('--ask', 'Rejected: continue does not support --ask')
    .option('--quick', 'Rejected: continue does not support --quick')
    .option('--detach', 'Run the continue in the background under the same slug')
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop', positiveIntParser('--max-rounds'), 5)
    .option('--notify', 'Enable desktop notification when the continue job reaches a terminal state')
    .option('--no-notify', 'Disable desktop notifications for this continue')
    .addOption(
        new Option('--agent <agent>', 'Agent backend: "cursor", "claude", "agn", or "opencode". Omitting uses local then global config, else cursor')
            .choices(['cursor', 'claude', 'agn', 'opencode']),
    )
    .action(async (slug, taskParts, options, command) => {
        // Parent program also defines --ask/--quick/--dry-run/--agent/--detach/
        // --max-rounds; when those flags appear after the continue arguments,
        // Commander attaches them to the parent. Merge via optsWithGlobals.
        const opts = typeof command.optsWithGlobals === 'function'
            ? command.optsWithGlobals()
            : { ...program.opts(), ...options };
        const prompt = taskParts.join(' ').trim();
        const cwd = process.cwd();

        opts.agent = resolveAgentOrExit(opts.agent, cwd);
        applyNotifyEnabled(opts, { cwd, dryRun: Boolean(opts.dryRun) });

        let record;
        try {
            record = validateContinue(cwd, slug, {
                task: prompt,
                ask: opts.ask,
                quick: opts.quick,
            });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
            return;
        }

        if (opts.detach) {
            await runContinueDetached(slug, prompt, {
                agent: opts.agent,
                maxRounds: opts.maxRounds,
                verbose: opts.verbose,
                cwd,
                notify: cliNotifyFromOptions(opts),
            });
            return;
        }

        if (opts.dryRun) {
            const backend = AGENT_BACKENDS[opts.agent];
            if (!isBinaryOnPath(backend.binary)) {
                console.error(binaryMissingHint(opts.agent));
                process.exit(1);
                return;
            }
            console.log(`dry-run: continue ${slug} ok`);
            return;
        }

        const alreadyReopened = Boolean(process.env.ORCH_JOB_SLUG);
        let priorOutcome;
        let continuation;
        let worktreePath = record.worktree;
        let branch = record.branch;
        let role = record.role;
        let parentSlug = record.parent;
        let workerId = record.workerId;

        if (!alreadyReopened) {
            priorOutcome = snapshotPriorOutcome(cwd, slug, record);
            const updated = reopenJob(cwd, slug, {
                task: prompt,
                agent: opts.agent,
                maxRounds: opts.maxRounds,
                pid: process.pid,
                prior: priorOutcome,
            });
            continuation = updated.continuation;
            setJobSlug(slug);
        } else {
            const live = readJob(cwd, slug) ?? record;
            continuation = live.continuation ?? 2;
            const entries = Array.isArray(live.continuations) ? live.continuations : [];
            const last = entries[entries.length - 1];
            priorOutcome = last?.prior ?? snapshotPriorOutcome(cwd, slug, live);
            worktreePath = live.worktree ?? worktreePath;
            branch = live.branch ?? branch;
            role = live.role ?? role;
            parentSlug = live.parent ?? parentSlug;
            workerId = live.workerId ?? workerId;
            setJobSlug(slug);
        }

        // PATH check after reopen (foreground) so empty-PATH tests can observe the bump.
        const backend = AGENT_BACKENDS[opts.agent];
        ensureBinaryOnPath(backend.binary, opts.agent);

        await runContinuePipeline(prompt, {
            agent: opts.agent,
            maxRounds: opts.maxRounds,
            verbose: opts.verbose,
            cwd,
            slug,
            worktreePath,
            branch,
            role,
            parentSlug,
            workerId,
            priorOutcome,
            continuation,
            jobSlug: slug,
            jobCwd: cwd,
        });
    });

program
    .command('config')
    .description('Print or set default agent / notify (global ~/.orch/config or local .orch/config)')
    .addOption(
        new Option('--agent <agent>', 'Set the default agent backend')
            .choices(['cursor', 'claude', 'agn', 'opencode']),
    )
    .option('--notify', 'Set notify: true in the target config')
    .option('--no-notify', 'Set notify: false in the target config')
    .option('--global', 'Write the global config (~/.orch/config); default when setting a value')
    .option('--local', 'Write the project-local config (.orch/config)')
    .action((options, command) => {
        // Parent also defines --agent/--notify/--no-notify; flags after `config`
        // may land on the parent. Merge so either placement works.
        const opts = typeof command.optsWithGlobals === 'function'
            ? command.optsWithGlobals()
            : { ...program.opts(), ...options };
        const cwd = process.cwd();

        if (opts.global && opts.local) {
            console.error('Error: --global and --local are mutually exclusive');
            process.exit(1);
            return;
        }

        const hasNotify = process.argv.includes('--notify');
        const hasNoNotify = process.argv.includes('--no-notify');
        if (hasNotify && hasNoNotify) {
            console.error('Error: --notify and --no-notify are mutually exclusive');
            process.exit(1);
            return;
        }

        const settingNotify = hasNotify || hasNoNotify;
        const settingAgent = Boolean(opts.agent);
        const writing = settingAgent || settingNotify;

        if ((opts.global || opts.local) && !writing) {
            console.error('Error: --global/--local require --agent, --notify, or --no-notify (omit flags to print config)');
            process.exit(1);
            return;
        }

        if (writing) {
            const targetPath = opts.local
                ? localConfigPath(cwd)
                : globalConfigPath();
            const patch = {};
            if (settingAgent) patch.agent = opts.agent;
            if (hasNotify) patch.notify = true;
            if (hasNoNotify) patch.notify = false;
            try {
                writeConfig(targetPath, patch);
            } catch (err) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
                return;
            }
            console.log(`wrote ${targetPath}`);
            process.stdout.write(`${JSON.stringify(patch, null, 2)}\n`);
            return;
        }

        try {
            printConfig({ cwd });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('list')
    .description('List all runs (active and finished) tracked under .orch/ in this directory')
    .action(() => {
        applyNotifyEnabled({});
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
        applyNotifyEnabled({}, { cwd });
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
        const cwd = process.cwd();
        try {
            const record = readJob(cwd, slug);
            if (!record) throw new Error(`requestPause: unknown job ${slug}`);
            if (isCascadeParent(cwd, record)) {
                const { childrenSignaled } = cascadePause(cwd, slug);
                console.log(`pause requested for ${slug} (${childrenSignaled} children signaled)`);
            } else {
                requestPause(cwd, slug);
                console.log(`pause requested for ${slug}`);
            }
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });

program
    .command('resume')
    .argument('<slug>', 'Run slug to resume')
    .description(
        'Unpause a live paused/pausing job, or recover a failed/stopped/crashed complex job at its unfinished stage',
    )
    .option('-v, --verbose', 'Stream agent thinking/output deltas to stderr as the pipeline runs')
    .option('--dry-run', 'Validate eligibility only; do not unpause, reopen, or run agents')
    .option('--ask', 'Rejected: resume does not support --ask')
    .option('--quick', 'Rejected: resume does not support --quick')
    .option('--detach', 'Run failure resume in the background under the same slug')
    .option('--max-rounds <n>', 'Max writer⇄critic and writer⇄runner iterations per implementer loop', positiveIntParser('--max-rounds'), 5)
    .addOption(
        new Option('--agent <agent>', 'Agent backend: "cursor", "claude", "agn", or "opencode". Omitting uses local then global config, else cursor')
            .choices(['cursor', 'claude', 'agn', 'opencode']),
    )
    .action(async (slug, options, command) => {
        const opts = typeof command.optsWithGlobals === 'function'
            ? command.optsWithGlobals()
            : { ...program.opts(), ...options };
        const cwd = process.cwd();
        opts.agent = resolveAgentOrExit(opts.agent, cwd);
        applyNotifyEnabled(opts, { cwd, dryRun: Boolean(opts.dryRun) });

        let validated;
        try {
            validated = validateResume(cwd, slug, {
                ask: opts.ask,
                quick: opts.quick,
            });
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
            return;
        }

        const { mode, record } = validated;

        if (opts.dryRun) {
            if (mode === 'failure') {
                const backend = AGENT_BACKENDS[opts.agent];
                if (!isBinaryOnPath(backend.binary)) {
                    console.error(binaryMissingHint(opts.agent));
                    process.exit(1);
                    return;
                }
            }
            console.log(`dry-run: resume ${slug} ok (${mode})`);
            return;
        }

        if (mode === 'unpause') {
            try {
                if (isCascadeParent(cwd, record)) {
                    cascadeResume(cwd, slug);
                    console.log(`resumed ${slug}`);
                } else {
                    requestResume(cwd, slug);
                    console.log(`resumed ${slug}`);
                }
            } catch (err) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
            return;
        }

        if (mode === 'noop') {
            console.log(`resumed ${slug}`);
            return;
        }

        // mode === 'failure'
        if (opts.detach) {
            await runResumeDetached(slug, {
                agent: opts.agent,
                maxRounds: opts.maxRounds,
                verbose: opts.verbose,
                cwd,
                notify: cliNotifyFromOptions(opts),
            });
            return;
        }

        const alreadyReopened = Boolean(process.env.ORCH_JOB_SLUG);
        let priorOutcome;
        let worktreePath = record.worktree;
        let branch = record.branch;
        let role = record.role;
        let parentSlug = record.parent;
        let workerId = record.workerId;
        let recoverBrief = '';

        if (!alreadyReopened) {
            priorOutcome = snapshotPriorOutcome(cwd, slug, record);
            reopenForResume(cwd, slug, {
                agent: opts.agent,
                maxRounds: opts.maxRounds,
                pid: process.pid,
                prior: priorOutcome,
            });
            setJobSlug(slug);
            const recovered = runRecover(cwd, slug, {
                prior: priorOutcome,
                worktreePath,
            });
            console.log(`orch: [recover] ${recovered.oneLiner}`);
            recoverBrief = recovered.brief;
        } else {
            const live = readJob(cwd, slug) ?? record;
            const entries = Array.isArray(live.resumes) ? live.resumes : [];
            const last = entries[entries.length - 1];
            priorOutcome = last?.prior ?? snapshotPriorOutcome(cwd, slug, live);
            worktreePath = live.worktree ?? worktreePath;
            branch = live.branch ?? branch;
            role = live.role ?? role;
            parentSlug = live.parent ?? parentSlug;
            workerId = live.workerId ?? workerId;
            setJobSlug(slug);
            const recoverPath = path.join(jobPaths(cwd, slug).dir, 'recover.md');
            if (!fs.existsSync(recoverPath)) {
                const recovered = runRecover(cwd, slug, {
                    prior: priorOutcome,
                    worktreePath,
                });
                console.log(`orch: [recover] ${recovered.oneLiner}`);
                recoverBrief = recovered.brief;
            } else {
                recoverBrief = fs.readFileSync(recoverPath, 'utf8');
                const orient = recoverBrief.match(/^- Orientation: (.+)$/m)
                    || recoverBrief.match(/^([^\n]+)$/m);
                console.log(`orch: [recover] ${orient?.[1] ?? 'resuming from recover.md'}`);
            }
        }

        const backend = AGENT_BACKENDS[opts.agent];
        if (!isBinaryOnPath(backend.binary)) {
            console.error(binaryMissingHint(opts.agent));
            process.exit(1);
            return;
        }

        console.log(`resumed ${slug} (pid ${process.pid})`);
        await runResumePipeline({
            agent: opts.agent,
            maxRounds: opts.maxRounds,
            verbose: opts.verbose,
            cwd,
            slug,
            jobSlug: slug,
            priorOutcome,
            recoverBrief,
            worktreePath,
            branch,
            role,
            parentSlug,
            workerId,
            prompt: priorOutcome?.task ?? record.task,
        });
    });

program
    .command('stop')
    .argument('<slug>', 'Run slug to stop')
    .description('Send SIGTERM to a running job (or reconcile a dead one to crashed)')
    .action((slug) => {
        const cwd = process.cwd();
        applyNotifyEnabled({}, { cwd });
        try {
            const record = readJob(cwd, slug);
            if (!record) throw new Error(`stopJob: unknown job ${slug}`);
            if (isCascadeParent(cwd, record)) {
                cascadeStop(cwd, slug);
                console.log(`stop signal sent to ${slug} and its children`);
            } else {
                const result = stopJob(cwd, slug);
                if (result.action === 'signaled') {
                    console.log(`stop signal sent to ${slug} (pid ${result.record.pid})`);
                } else if (result.action === 'crashed') {
                    console.log(`${slug} process was already gone; marked crashed`);
                } else {
                    console.log(`${slug} is already ${result.record.state}`);
                }
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
    .description('Delete all orch jobs from .orch/ (refuses while live jobs are running; orch stop <slug> first)')
    .action(async () => {
        const cwd = process.cwd();
        const orchDir = path.join(cwd, '.orch');
        if (!fs.existsSync(orchDir) || fs.readdirSync(orchDir).length === 0) {
            console.log('no jobs to clean');
            return;
        }

        // Refuse before prompting so we never ask to wipe dirs we will not delete.
        const live = liveSlugsBlockingClean(cwd);
        if (live.length > 0) {
            console.error(
                `Error: cannot clean while live jobs exist: ${live.join(', ')}. ` +
                `Stop them first with: orch stop <slug>`,
            );
            process.exit(1);
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

        try {
            const removed = cleanJobs(cwd);
            console.log(`deleted ${removed.length} job${removed.length === 1 ? '' : 's'} from .orch/`);
        } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
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
