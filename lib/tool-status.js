/**
 * @typedef {'started'|'completed'} ToolPhase
 * @typedef {{ name: string, args: Record<string, unknown>, phase: ToolPhase, callId: string }} NormalizedToolEvent
 */

/** Format milliseconds as `{s}s` or `{m}m {s}s` (whole seconds, no leading 0m). */
export function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Truncate a string to `max` chars, appending an ellipsis if it was cut. */
export function truncate(s, max = 60) {
    const str = String(s ?? '');
    if (str.length <= max) return str;
    return `${str.slice(0, max)}…`;
}

/** Last path segment, for readable status lines. */
export function basename(p) {
    const str = String(p ?? '');
    if (!str) return str;
    const parts = str.split('/');
    return parts[parts.length - 1] || str;
}

/** Pick the first 1-2 short scalar args to preview for unknown tools, e.g. "path=foo". */
export function formatArgPreview(args = {}) {
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        if (parts.length >= 2) break;
        if (value == null) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            continue;
        }
        parts.push(`${key}=${truncate(String(value), 30)}`);
    }
    return parts.join(', ');
}

const CURSOR_TOOL_CALL_KEYS = {
    readToolCall: 'Read',
    writeToolCall: 'Write',
    editToolCall: 'Edit',
    deleteToolCall: 'Delete',
    grepToolCall: 'Grep',
    globToolCall: 'Glob',
    lsToolCall: 'Ls',
    shellToolCall: 'Shell',
};

/**
 * Normalize a Cursor stream event into a `NormalizedToolEvent`, or `null` if
 * the event isn't a `tool_call` event.
 * @param {object} event
 * @returns {NormalizedToolEvent|null}
 */
export function normalizeCursorToolEvent(event) {
    if (event?.type !== 'tool_call') return null;

    const phase = event.subtype === 'completed' ? 'completed' : 'started';
    const callId = event.call_id;
    const toolCall = event.tool_call ?? {};
    const keys = Object.keys(toolCall);
    const key = keys[0];

    if (!key) {
        return { name: 'tool', args: {}, phase, callId };
    }

    if (key === 'function') {
        const fn = toolCall.function ?? {};
        let args = {};
        if (typeof fn.arguments === 'string') {
            try {
                args = JSON.parse(fn.arguments);
            } catch {
                args = {};
            }
        } else if (fn.arguments && typeof fn.arguments === 'object') {
            args = fn.arguments;
        }
        return { name: fn.name ?? 'function', args, phase, callId };
    }

    const canonicalName = CURSOR_TOOL_CALL_KEYS[key] ?? key.replace(/ToolCall$/, '');
    const args = toolCall[key]?.args ?? {};
    return { name: canonicalName, args, phase, callId };
}

const CLAUDE_NAME_TO_FORMATTER_KEY = {
    Read: 'read',
    Write: 'write',
    Edit: 'edit',
    MultiEdit: 'edit',
    Bash: 'shell',
    Grep: 'grep',
    Glob: 'glob',
    WebSearch: 'websearch',
    Task: 'task',
};

/** Map a Claude PascalCase tool name to its shared formatter key. */
export function claudeToolFormatterKey(name) {
    return CLAUDE_NAME_TO_FORMATTER_KEY[name] ?? String(name ?? '').toLowerCase();
}

/**
 * Normalize a Claude stream event into zero or more `NormalizedToolEvent`s.
 * @param {object} event
 * @returns {NormalizedToolEvent[]}
 */
export function normalizeClaudeToolEvent(event) {
    if (event?.type === 'assistant') {
        const content = event.message?.content;
        if (!Array.isArray(content)) return [];
        return content
            .filter((block) => block.type === 'tool_use')
            .map((block) => ({
                name: claudeToolFormatterKey(block.name),
                args: block.input ?? {},
                phase: 'started',
                callId: block.id,
            }));
    }

    if (event?.type === 'user') {
        const content = event.message?.content;
        if (!Array.isArray(content)) return [];
        return content
            .filter((block) => block.type === 'tool_result')
            .map((block) => ({
                name: '',
                args: {},
                phase: 'completed',
                callId: block.tool_use_id,
            }));
    }

    return [];
}

const AGN_TOOL_NAME_TO_FORMATTER_KEY = {
    read_file: 'read',
    write_file: 'write',
    patch: 'edit',
    shell: 'shell',
};

/**
 * Normalize an agn stream event into a `NormalizedToolEvent`, or `null` if
 * the event isn't a well-formed `tool_call` `started`/`completed` event.
 * @param {object} event
 * @returns {NormalizedToolEvent|null}
 */
export function normalizeAgnToolEvent(event) {
    if (event?.type !== 'tool_call') return null;
    if (event.subtype !== 'started' && event.subtype !== 'completed') return null;
    if (typeof event.call_id !== 'string' || event.call_id === '') return null;

    const canonicalName = AGN_TOOL_NAME_TO_FORMATTER_KEY[event.name] ?? event.name;
    return {
        name: canonicalName,
        args: event.subtype === 'started' ? (event.input ?? {}) : {},
        phase: event.subtype,
        callId: event.call_id,
    };
}

/**
 * Format a single normalized tool event as a human-readable status line.
 * @param {{ name: string, args?: Record<string, unknown> }} tool
 * @param {{ maxLen?: number }} [options]
 */
export function formatToolStatus({ name, args = {} }, { maxLen = 60 } = {}) {
    const n = String(name ?? 'tool');
    const key = n.toLowerCase();

    switch (key) {
        case 'grep':
            return `Searching: ${truncate(args.pattern ?? args.query ?? 'codebase', maxLen)}…`;
        case 'glob':
            return `Finding: ${truncate(args.glob_pattern ?? args.pattern ?? 'files', maxLen)}…`;
        case 'read':
            return `Reading ${truncate(basename(args.path ?? args.file_path ?? 'file'), maxLen)}…`;
        case 'write':
            return `Writing ${truncate(basename(args.path ?? args.file_path ?? 'file'), maxLen)}…`;
        case 'edit':
            return `Editing ${truncate(basename(args.path ?? args.file_path ?? 'file'), maxLen)}…`;
        case 'delete':
            return `Deleting ${truncate(basename(args.path ?? args.file_path ?? 'file'), maxLen)}…`;
        case 'shell':
        case 'bash':
            return `Running: ${truncate(args.command ?? '', maxLen)}…`;
        case 'ls':
            return `Listing ${truncate(args.path ?? args.target_directory ?? '.', maxLen)}…`;
        case 'websearch':
            return `Searching web: ${truncate(args.search_term ?? args.query ?? '', maxLen)}…`;
        case 'task':
            return `Running subagent: ${truncate(args.description ?? args.prompt ?? 'task', maxLen)}…`;
        default: {
            const preview = formatArgPreview(args);
            return preview ? `Running ${n}(${preview})…` : `Running ${n}…`;
        }
    }
}

/**
 * Format a single completed tool event as a past-tense history line, with an
 * optional `done in {elapsed}` suffix once the call ran a second or longer.
 * @param {{ name: string, args?: Record<string, unknown> }} tool
 * @param {{ durationMs?: number }} [options]
 */
export function formatToolHistory({ name, args = {} }, { durationMs = 0 } = {}) {
    const n = String(name ?? 'tool');
    const key = n.toLowerCase();
    const suffix = durationMs >= 1000 ? ` done in ${formatElapsed(durationMs)}` : '';

    switch (key) {
        case 'grep':
            return `Searched: ${args.pattern ?? args.query ?? 'codebase'}${suffix}`;
        case 'glob':
            return `Found: ${args.glob_pattern ?? args.pattern ?? 'files'}${suffix}`;
        case 'read':
            return `Read ${basename(args.path ?? args.file_path ?? 'file')}${suffix}`;
        case 'write':
            return `Wrote ${basename(args.path ?? args.file_path ?? 'file')}${suffix}`;
        case 'edit':
            return `Edited ${basename(args.path ?? args.file_path ?? 'file')}${suffix}`;
        case 'delete':
            return `Deleted ${basename(args.path ?? args.file_path ?? 'file')}${suffix}`;
        case 'shell':
        case 'bash':
            return `Running: ${args.command ?? ''}${suffix}`;
        case 'ls':
            return `Listed ${args.path ?? args.target_directory ?? '.'}${suffix}`;
        case 'websearch':
            return `Searched web: ${args.search_term ?? args.query ?? ''}${suffix}`;
        case 'task':
            return `Ran subagent: ${args.description ?? args.prompt ?? 'task'}${suffix}`;
        default: {
            const preview = formatArgPreview(args);
            return preview ? `Ran ${n}(${preview})${suffix}` : `Ran ${n}${suffix}`;
        }
    }
}

/**
 * Join up to 3 active tools into one spinner line, capped at 120 chars.
 * @param {Map<string, { name: string, args: Record<string, unknown> }>} activeTools
 */
export function formatActiveTools(activeTools) {
    const entries = [...activeTools.values()];
    const maxShown = 3;
    const shown = entries.slice(0, maxShown).map((t) => formatToolStatus(t, { maxLen: 40 }));
    const extra = entries.length - maxShown;
    let text = shown.join(' · ');
    if (extra > 0) text += ` · +${extra} more`;
    return truncate(text, 120);
}
