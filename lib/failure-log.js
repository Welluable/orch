import fs from 'node:fs';
import path from 'node:path';

/**
 * Pure failure.log section formatting + append. No jobs imports — safe for
 * both lib/agent.js (in-process buffer flush) and lib/jobs.js (crashed
 * header-only write) without circular dependencies.
 */

/** Relative pointer for status / lastOutcome.error (matches resume.md sample). */
export function failureLogPointer(slug) {
    return `see .orch/${slug}/failure.log`;
}

function fmtField(label, value) {
    const rendered = value == null || value === '' ? '' : String(value);
    return `${label}:${' '.repeat(Math.max(1, 11 - label.length))}${rendered}`;
}

/**
 * Build one `=== orch failure ===` section (header + stage verbose + optional
 * prior summaries). `stageVerbose` may be empty (crashed / header-only).
 */
export function formatFailureSection({
    slug,
    state,
    phase = null,
    stage = null,
    round = null,
    exitCode = null,
    finishedAt,
    task = null,
    error = null,
    stageVerbose = '',
    priorStages = [],
}) {
    const stageLabel = stage ?? 'unknown';
    const lines = [
        '=== orch failure ===',
        fmtField('slug', slug),
        fmtField('state', state),
        fmtField('phase', phase),
        fmtField('stage', stage),
        fmtField('round', round),
        fmtField('exitCode', exitCode),
        fmtField('finishedAt', finishedAt),
        fmtField('task', task),
        fmtField('error', error),
        '',
        `=== stage verbose (${stageLabel}) ===`,
        stageVerbose.endsWith('\n') || stageVerbose === '' ? stageVerbose : `${stageVerbose}\n`,
    ];

    if (priorStages.length > 0) {
        lines.push('=== prior stage summaries (best-effort) ===');
        for (const prior of priorStages) {
            const label = prior.stage ?? prior.phase ?? 'prior';
            lines.push(`--- ${label} ---`);
            const body = prior.verbose ?? '';
            lines.push(body.endsWith('\n') || body === '' ? body : `${body}\n`);
        }
    }

    return lines.join('\n');
}

/** Append a section to `failureLogPath`, creating the file/dir if needed. */
export function appendFailureLog(failureLogPath, section) {
    fs.mkdirSync(path.dirname(failureLogPath), { recursive: true });
    const prefix = fs.existsSync(failureLogPath) ? '\n' : '';
    fs.appendFileSync(failureLogPath, prefix + section, 'utf8');
}
