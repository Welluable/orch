/**
 * Shared consumer hard rule for post-research stages (planner + implementers).
 * Keep one source of copy so instructions cannot drift across roles.
 *
 * @param {string} researchPath Absolute path to this run's research.md
 * @returns {string}
 */
export function researchConsumerHardRule(researchPath) {
    return (
        `Read research at ${researchPath} before exploring. ` +
        `Do not re-search or re-document architecture, build/test/lint commands, ` +
        `conventions, or entry points it already covers. Explore only what your ` +
        `stage still needs beyond that. The current worktree is authoritative for ` +
        `mutable code and runtime state if it disagrees with research.`
    );
}

/** Default cap for optional planner inline research excerpts. */
export const RESEARCH_INLINE_MAX_CHARS = 1200;

/**
 * Shrink optional inline research for planner prompts. Path + hard rule are
 * the default; a short excerpt is kept only when safe.
 *
 * @param {string | null | undefined} researchOutput
 * @param {{ researchPath?: string, maxChars?: number }} [opts]
 * @returns {string}
 */
export function shrinkResearchOutput(
    researchOutput,
    { researchPath = '', maxChars = RESEARCH_INLINE_MAX_CHARS } = {},
) {
    const text = typeof researchOutput === 'string' ? researchOutput.trim() : '';
    if (!text) return '';
    if (text.length <= maxChars) return text;
    const head = text.slice(0, maxChars).trimEnd();
    const pointer = researchPath
        ? `…(truncated; read the full research at ${researchPath})`
        : '…(truncated; read the full research file)';
    return `${head}\n${pointer}`;
}
