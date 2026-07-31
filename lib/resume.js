import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJob, reconcileJob, patchJob, jobPaths } from './jobs.js';
import { readSeq } from './seq.js';
import { snapshotPriorOutcome } from './continue.js';

const FAILURE_RESUME_STATES = new Set(['failed', 'stopped', 'crashed']);
const UNPAUSE_STATES = new Set(['paused', 'pausing']);

/** Plain Error whose `toString()` is just the message (no `Error:` prefix). */
function fail(message) {
    const err = new Error(message);
    err.name = '';
    return err;
}

function cursorLabel(record) {
    const phase = record.phase ?? record.lastOutcome?.phase ?? '?';
    const stage = record.stage ?? record.lastOutcome?.stage ?? '?';
    return `${phase}/${stage}`;
}

/**
 * Pure eligibility gate for `orch resume`. Reconciles first; never mutates
 * beyond reconcile's dead-pid → crashed rewrite.
 *
 * Returns `{ mode, record }` where mode is:
 *   - `'unpause'`  — live paused/pausing → existing requestResume path
 *   - `'noop'`     — already running (successful no-op)
 *   - `'failure'`  — terminal failure resume (recover → reentry)
 */
export function validateResume(cwd, slug, { ask, quick } = {}) {
    const existing = readJob(cwd, slug);
    if (!existing) throw fail(`unknown run ${slug}`);

    if (ask) throw fail('orch resume does not support --ask; use the default orch command');
    if (quick) throw fail('orch resume does not support --quick; use the default orch command');

    const record = reconcileJob(cwd, slug, existing);

    if (UNPAUSE_STATES.has(record.state)) {
        return { mode: 'unpause', record };
    }

    if (record.state === 'running') {
        return { mode: 'noop', record };
    }

    if (record.state === 'done') {
        throw fail(
            `${slug} is done; nothing to resume.\nuse: orch continue ${slug} "<new task>"`,
        );
    }

    if (!FAILURE_RESUME_STATES.has(record.state)) {
        throw fail(`cannot resume ${slug} while state is ${record.state}`);
    }

    if (record.role === 'coordinator') {
        if (readSeq(cwd, slug)) {
            throw fail(
                `cannot resume coordinator ${slug}; resume each failed unit slug, then orch --seq-continue ${slug}`,
            );
        }
        throw fail(
            `cannot resume coordinator ${slug}; resume each failed worker slug, then orch --integrate ${slug}`,
        );
    }

    if (record.role === 'integration') {
        const parent = record.parent ?? '<parent-slug>';
        throw fail(
            `cannot resume integration ${slug}; use orch --integrate ${parent}`,
        );
    }

    if (!record.worktree || !record.branch) {
        throw fail(
            `${slug} has no worktree; nothing to stage-resume (quick-fix / ask runs cannot be resumed)`,
        );
    }

    if (!fs.existsSync(record.worktree)) {
        throw fail(`worktree missing at ${record.worktree}; cannot resume ${slug}`);
    }

    return { mode: 'failure', record };
}

/**
 * Reopen a terminal failure job for same-task resume. Restores
 * phase/stage/round from `prior` (not research reset). Same slug/worktree.
 */
export function reopenForResume(cwd, slug, {
    pid,
    prior,
    agent,
    maxRounds,
    startedAt,
} = {}) {
    const existing = readJob(cwd, slug);
    if (!existing) throw new Error(`reopenForResume: unknown job ${slug}`);

    const started = startedAt ?? new Date().toISOString();
    const resumeCount = (existing.resumeCount ?? 0) + 1;
    const resumes = Array.isArray(existing.resumes) ? [...existing.resumes] : [];
    resumes.push({
        n: resumeCount,
        startedAt: started,
        prior: prior ?? null,
    });

    const phase = prior?.phase ?? existing.phase ?? null;
    const stage = prior?.stage ?? existing.stage ?? null;
    const round = prior?.round ?? existing.round ?? null;

    return patchJob(cwd, slug, {
        agent: agent ?? existing.agent,
        maxRounds: maxRounds ?? existing.maxRounds,
        pid,
        startedAt: started,
        state: 'running',
        phase,
        stage,
        round,
        finishedAt: null,
        exitCode: null,
        pauseRequested: false,
        lastOutcome: null,
        resumeCount,
        resumes,
    });
}

function readOptional(filePath) {
    try {
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    } catch {
        // best-effort
    }
    return null;
}

function shortGitSummary(worktreePath) {
    if (!worktreePath || !fs.existsSync(worktreePath)) return '(worktree missing)';
    try {
        const status = execFileSync('git', ['status', '--short'], {
            cwd: worktreePath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (!status) return 'clean working tree';
        const lines = status.split('\n');
        const head = lines.slice(0, 8).join('; ');
        const more = lines.length > 8 ? ` (+${lines.length - 8} more)` : '';
        return `${lines.length} change(s): ${head}${more}`;
    } catch (err) {
        return `(git status unavailable: ${err.message?.split('\n')[0] ?? 'error'})`;
    }
}

function oneLineOrientation(prior, { hasTask, hasResearch, gitSummary }) {
    const state = prior?.state ?? 'unknown';
    const stage = prior?.stage ?? prior?.phase ?? 'unknown';
    const round = prior?.round != null ? ` round ${prior.round}` : '';
    const errHint = prior?.error
        ? prior.error.includes('failure.log')
            ? ' (see failure.log)'
            : ` (${String(prior.error).slice(0, 60)})`
        : '';
    const artifacts = [
        hasTask ? 'task.md present' : null,
        hasResearch ? 'research.md present' : null,
        gitSummary?.startsWith('clean') ? 'worktree intact' : 'worktree has changes',
    ].filter(Boolean).join(', ');
    return `${state} at ${stage}${round}${errHint}; ${artifacts}`;
}

/**
 * Deterministic recover: read cursor + failure.log + artifacts + git summary,
 * write recover.md, return brief + one-liner for UI / stage injection.
 */
export function runRecover(cwd, slug, { prior, worktreePath } = {}) {
    const paths = jobPaths(cwd, slug);
    const artifactDir = paths.dir;
    const failureLogPath = paths.failureLogPath;
    const researchPath = path.join(artifactDir, 'research.md');
    const taskPath = path.join(artifactDir, 'task.md');
    const statusPath = path.join(artifactDir, 'status.md');
    const recoverPath = path.join(artifactDir, 'recover.md');

    const failureLog = readOptional(failureLogPath);
    const research = readOptional(researchPath);
    const task = readOptional(taskPath);
    const status = readOptional(statusPath);
    const gitSummary = shortGitSummary(worktreePath ?? readJob(cwd, slug)?.worktree);

    const p = prior ?? snapshotPriorOutcome(cwd, slug, readJob(cwd, slug) ?? {});
    const oneLiner = oneLineOrientation(p, {
        hasTask: Boolean(task),
        hasResearch: Boolean(research),
        gitSummary,
    });

    const lines = [
        '# Recover',
        '',
        `- Slug: \`${slug}\``,
        `- Prior state: ${p.state ?? '(none)'}`,
        `- Prior phase: ${p.phase ?? '(none)'}`,
        `- Prior stage: ${p.stage ?? '(none)'}`,
        `- Prior round: ${p.round ?? 'null'}`,
        `- Prior task: ${p.task ?? '(none)'}`,
        `- Prior summary: ${p.summary || '(none)'}`,
        `- Prior error: ${p.error ?? '(none)'}`,
        `- failure.log: ${failureLog ? failureLogPath : '(absent)'}`,
        `- research.md: ${research ? 'present' : 'absent'}`,
        `- task.md: ${task ? 'present' : 'absent'}`,
        `- status.md: ${status ? 'present' : 'absent'}`,
        `- Worktree git: ${gitSummary}`,
        '',
        '## Orientation',
        '',
        oneLiner,
        '',
        '## Guidance',
        '',
        '- Re-enter the unfinished stage; do not restart research/plan when task.md / research.md already exist.',
        '- No destructive git (no reset/clean/force checkout).',
        '- Retry the recorded stage; overwrite its outputs safely.',
        '',
    ];

    if (failureLog) {
        const excerpt = failureLog.length > 4000
            ? `${failureLog.slice(-4000)}\n…(truncated)…`
            : failureLog;
        lines.push('## failure.log (excerpt)', '', '```', excerpt.trimEnd(), '```', '');
    }

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(recoverPath, `${lines.join('\n')}\n`, 'utf8');

    const brief = [
        '[Recover brief]',
        `- Orientation: ${oneLiner}`,
        `- Reentry: ${p.phase ?? '?'}/${p.stage ?? '?'} round ${p.round ?? 'null'}`,
        `- failure.log: ${failureLog ? failureLogPath : '(absent)'}`,
        `- recover.md: ${recoverPath}`,
        `- Worktree git: ${gitSummary}`,
        '- Do not re-run research/plan unless this stage is research or plan.',
        '[/Recover brief]',
    ].join('\n');

    return {
        oneLiner,
        brief,
        recoverPath,
        failureLogPath: failureLog ? failureLogPath : null,
    };
}

export { snapshotPriorOutcome, cursorLabel, FAILURE_RESUME_STATES };
