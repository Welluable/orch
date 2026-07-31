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
 * Safety-net summary for the printed stage box when the agent omitted
 * `<<<SUMMARY>>>`. Never invents a delimiter into forwarded content — callers
 * pass only the resolved string to `printStageSummary`.
 *
 * @param {string} label
 * @param {string} summary
 * @param {unknown} content
 * @returns {string}
 */
export function resolveStageSummary(label, summary, content) {
    if (typeof summary === 'string' && summary.trim()) return summary;

    if (typeof content !== 'string') return '';
    const trimmed = content.trim();
    if (!trimmed) return '';

    const [first] = splitSummaryIntoBullets(trimmed);
    if (!first) return `${label} completed`;

    if (first.length <= 160) return first;
    return `${first.slice(0, 160).trimEnd()}`;
}

const FILES_NOTES_HEADER_RE = /^\s*files\s*:?\s*$/i;

/**
 * Pull an optional trailing `Files:` block (one `<path>: <one-line note>`
 * per line) off the end of a stage summary, so writer agents can attach a
 * short description to each file they touched. Returns the prose with that
 * block removed plus a `path -> note` map; when no `Files:` line is present
 * the summary passes through unchanged and the map is empty.
 */
function extractFileNotes(summary) {
    const lines = summary.split('\n');
    const headerIdx = lines.findIndex((line) => FILES_NOTES_HEADER_RE.test(line));
    if (headerIdx === -1) return { prose: summary, notes: new Map() };

    const notes = new Map();
    for (const line of lines.slice(headerIdx + 1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        if (sep === -1) continue;
        const notePath = trimmed.slice(0, sep).trim();
        const note = trimmed.slice(sep + 1).trim();
        if (notePath && note) notes.set(notePath, note);
    }

    return { prose: lines.slice(0, headerIdx).join('\n').trim(), notes };
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
 *     ~ lib/agent.js - wired the tracker into onToolEvent
 *     + lib/file-tracker.js - added the ordered/deduped file collector
 *
 * A trailing `Files:` block in `summary` (one `<path>: <note>` per line)
 * supplies the per-file note; a file with no matching note prints as before
 * (marker + path only). Prints when prose or files are nonempty; both
 * empty → no-op.
 *
 * @param {string} label
 * @param {string} summary
 * @param {{ marker: string, path: string }[]=} files
 */
export function printStageSummary(label, summary, files) {
    const { prose, notes } = extractFileNotes(summary || '');
    const hasSummary = Boolean(prose);
    const hasFiles = Array.isArray(files) && files.length > 0;
    if (!hasSummary && !hasFiles) return;

    const title = ` ${label} `;
    const rule = '─'.repeat(title.length);

    console.log();
    console.log(rule);
    console.log(title);
    console.log(rule);
    if (hasSummary) {
        for (const bullet of splitSummaryIntoBullets(prose)) {
            console.log(`  • ${bullet}`);
        }
    }
    if (hasFiles) {
        console.log(`  Files (${files.length})`);
        for (const { marker, path: filePath } of files) {
            const note = notes.get(filePath);
            console.log(`    ${marker} ${filePath}${note ? ` - ${note}` : ''}`);
        }
    }
    console.log();
}
