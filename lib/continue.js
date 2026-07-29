import fs from 'node:fs';
import path from 'node:path';
import { readJob, reconcileJob, jobPaths } from './jobs.js';

const CONTINUE_ELIGIBLE = new Set(['done', 'failed', 'stopped', 'crashed']);

/** Plain Error whose `toString()` is just the message (no `Error:` prefix), so
 * `assert.throws(fn, /^exact message$/)` contracts match Node's RegExp check. */
function fail(message) {
    const err = new Error(message);
    err.name = '';
    return err;
}

/**
 * Pure eligibility gate for `orch continue`. Reconciles first; never mutates
 * beyond reconcile's dead-pid → crashed rewrite. Throws plain Error messages
 * (CLI wraps with `Error: ${err.message}`).
 */
export function validateContinue(cwd, slug, { task, ask, quick } = {}) {
    const existing = readJob(cwd, slug);
    if (!existing) throw fail(`unknown run ${slug}`);

    if (ask) throw fail('orch continue does not support --ask; use the default orch command');
    if (quick) throw fail('orch continue does not support --quick; use the default orch command');

    if (typeof task !== 'string' || !task.trim()) {
        throw fail('task cannot be empty');
    }

    const record = reconcileJob(cwd, slug, existing);

    if (!CONTINUE_ELIGIBLE.has(record.state)) {
        throw fail(
            `cannot continue ${slug} while state is ${record.state}; use orch resume / orch stop`,
        );
    }

    if (record.role === 'coordinator') {
        throw fail(
            `cannot continue coordinator ${slug}; continue each failed worker slug, then orch --integrate ${slug}`,
        );
    }

    if (record.role === 'integration') {
        const parent = record.parent ?? '<parent-slug>';
        throw fail(
            `cannot continue integration ${slug}; use orch --integrate ${parent}`,
        );
    }

    if (!record.worktree || !record.branch) {
        throw fail(`${slug} has no worktree; continue only applies to complex runs`);
    }

    if (!fs.existsSync(record.worktree)) {
        throw fail(`worktree missing at ${record.worktree}; cannot continue ${slug}`);
    }

    return record;
}

/**
 * Snapshot prior outcome for continue reopen. Prefer `record.lastOutcome`;
 * otherwise synthesize from terminal fields (+ best-effort status.md scrape).
 * Never throws.
 */
export function snapshotPriorOutcome(cwd, slug, record) {
    if (record?.lastOutcome) return record.lastOutcome;

    let summary = '';
    try {
        const statusPath = path.join(jobPaths(cwd, slug).dir, 'status.md');
        if (fs.existsSync(statusPath)) {
            const content = fs.readFileSync(statusPath, 'utf8');
            const matches = [...content.matchAll(/^- Summary:\s*(.*)$/gm)];
            if (matches.length > 0) {
                summary = (matches[matches.length - 1][1] || '').trim();
            }
        }
    } catch {
        summary = '';
    }

    return {
        state: record.state,
        phase: record.phase ?? null,
        stage: record.stage ?? null,
        round: record.round ?? null,
        exitCode: record.exitCode ?? null,
        finishedAt: record.finishedAt ?? null,
        task: record.task ?? null,
        summary,
        error: null,
    };
}

function displayOrNone(value) {
    if (value == null || value === '') return '(none recorded)';
    return String(value);
}

/**
 * Build the `[Prior run outcome]…[/Prior run outcome]` block injected into
 * research/planner prompts on continue.
 */
export function buildPriorOutcomeText(prior, {
    slug,
    continuation,
    worktreePath,
    branch,
    parentSlug,
    workerId,
} = {}) {
    const p = prior ?? {};
    const lines = [
        '[Prior run outcome]',
        `- Continuation: this is continue ${continuation} on slug ${slug}`,
        `- Prior state: ${displayOrNone(p.state)}`,
        `- Prior phase: ${displayOrNone(p.phase)}`,
        `- Prior stage: ${displayOrNone(p.stage)}`,
        `- Prior round: ${p.round == null ? 'null' : p.round}`,
        `- Prior task: ${displayOrNone(p.task)}`,
        `- Summary: ${displayOrNone(p.summary)}`,
        `- Error: ${displayOrNone(p.error)}`,
        `- Worktree: ${worktreePath} (branch ${branch} tip is the starting point; do not assume a clean tree)`,
    ];
    if (parentSlug) lines.push(`- Fan-out parent: ${parentSlug}`);
    if (workerId) lines.push(`- Worker id: ${workerId}`);
    lines.push('[/Prior run outcome]');
    return lines.join('\n');
}
