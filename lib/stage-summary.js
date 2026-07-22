const SUMMARY_DELIMITER = '<<<SUMMARY>>>';

/**
 * Split a stage's final message into its required content and the optional
 * natural-language summary paragraph appended after the last `<<<SUMMARY>>>`
 * delimiter. Falls back to treating the whole input as content (with an
 * empty summary) when the delimiter is absent or the input isn't a string,
 * so older/unmodified agent output degrades gracefully instead of crashing.
 */
export function splitStageSummary(raw) {
    if (typeof raw !== 'string') {
        return { content: raw, summary: '' };
    }

    const idx = raw.lastIndexOf(SUMMARY_DELIMITER);
    if (idx === -1) {
        return { content: raw, summary: '' };
    }

    return {
        content: raw.slice(0, idx).trim(),
        summary: raw.slice(idx + SUMMARY_DELIMITER.length).trim(),
    };
}

/**
 * Print a blank line followed by `[label] summary: <summary>`. No-op when
 * summary is empty so stages that return no summary don't print a broken line.
 */
export function printStageSummary(label, summary) {
    if (!summary) return;
    console.log();
    console.log(`[${label}] summary: ${summary}`);
}
