import { parseTriageJson } from './parse-triage-json.js';

const UNPARSEABLE = { passed: false, summary: 'unparseable verdict' };

/**
 * Parse a critic/runner final message as a pass/fail verdict.
 * Reuses triage JSON extraction; requires `typeof passed === 'boolean'`.
 */
export function parseVerdict(result) {
    const parsed = parseTriageJson(result);
    if (!parsed || typeof parsed.passed !== 'boolean') {
        return { ...UNPARSEABLE };
    }

    const verdict = {
        passed: parsed.passed,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };

    if (Array.isArray(parsed.failures)) {
        verdict.failures = parsed.failures;
    }

    return verdict;
}
