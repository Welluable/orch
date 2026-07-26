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
 * Split a one-paragraph summary into sentence-sized bullet lines. Splits at
 * a `.`/`!`/`?` only when it's followed by whitespace and then a capital
 * letter or digit, so periods inside filenames/versions (e.g. "status.md")
 * don't cause a false split.
 */
function splitSummaryIntoBullets(summary) {
    const normalized = summary.replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    return normalized
        .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
}

/**
 * Print a titled, bulleted block for a stage's summary paragraph, e.g.:
 *
 *   ──────────
 *    triage
 *   ──────────
 *     • Sentence one.
 *     • Sentence two.
 *   Files (2)
 *     ~ lib/agent.js
 *     + lib/file-tracker.js
 *
 * Prints when prose or files are nonempty; both empty → no-op.
 *
 * @param {string} label
 * @param {string} summary
 * @param {{ marker: string, path: string }[]=} files
 */
export function printStageSummary(label, summary, files) {
    const hasSummary = Boolean(summary);
    const hasFiles = Array.isArray(files) && files.length > 0;
    if (!hasSummary && !hasFiles) return;

    const title = ` ${label} `;
    const rule = '─'.repeat(title.length);

    console.log();
    console.log(rule);
    console.log(title);
    console.log(rule);
    if (hasSummary) {
        for (const bullet of splitSummaryIntoBullets(summary)) {
            console.log(`  • ${bullet}`);
        }
    }
    if (hasFiles) {
        console.log(`  Files (${files.length})`);
        for (const { marker, path: filePath } of files) {
            console.log(`    ${marker} ${filePath}`);
        }
    }
    console.log();
}
