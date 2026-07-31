import path from 'node:path';
import { toolPath } from './tool-status.js';

/** @param {string} name */
function markerForName(name) {
    const key = String(name || '').toLowerCase();
    if (key === 'write') return '+';
    if (key === 'edit' || key === 'multiedit') return '~';
    if (key === 'delete') return '-';
    return null;
}

/**
 * Parse OpenCode `apply_patch` marker lines into file-trail entries.
 * @param {unknown} patchText
 * @returns {{ marker: string, path: string }[]}
 */
export function parseApplyPatchPaths(patchText) {
    if (typeof patchText !== 'string' || !patchText) return [];

    /** @type {{ marker: string, path: string }[]} */
    const entries = [];
    for (const line of patchText.split('\n')) {
        const add = line.match(/^\*\*\* Add File:\s*(.+?)\s*$/);
        if (add) {
            entries.push({ marker: '+', path: add[1] });
            continue;
        }
        const update = line.match(/^\*\*\* Update File:\s*(.+?)\s*$/);
        if (update) {
            entries.push({ marker: '~', path: update[1] });
            continue;
        }
        const del = line.match(/^\*\*\* Delete File:\s*(.+?)\s*$/);
        if (del) {
            entries.push({ marker: '-', path: del[1] });
            continue;
        }
        const move = line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
        if (move) {
            // Destination only; drop the preceding Update File source entry.
            if (entries.length > 0 && entries[entries.length - 1].marker === '~') {
                entries.pop();
            }
            entries.push({ marker: '~', path: move[1] });
        }
    }
    return entries;
}

/**
 * Collect Write/Edit/Delete completions into an ordered, deduped file list
 * for live sticky lines and stage-summary `Files (N)`.
 */
export class FileTracker {
    /** @param {{ cwd: string }} opts */
    constructor({ cwd }) {
        this.cwd = path.resolve(cwd);
        /** @type {Map<string, { name: string, marker: string, path: string|null }>} */
        this.pending = new Map();
        /** @type {{ marker: string, path: string }[]} */
        this.files = [];
        /** @type {Map<string, number>} */
        this.indexByPath = new Map();
    }

    /**
     * @param {{ name: string, args: Record<string, unknown>, phase: 'started'|'completed', callId: string }} event
     * @returns {{ marker: string, path: string, isNew: boolean }|null}
     */
    record({ name, args, phase, callId }) {
        if (phase === 'started') {
            const marker = markerForName(name);
            if (!marker) return null;
            this.pending.set(callId, {
                name,
                marker,
                path: toolPath(args),
            });
            return null;
        }

        if (phase !== 'completed') return null;

        const prior = this.pending.get(callId);
        this.pending.delete(callId);

        const toolName = name || prior?.name || '';
        const marker = markerForName(toolName) || prior?.marker || null;
        if (!marker) return null;

        const rawPath = toolPath(args) || prior?.path || null;
        if (!rawPath) return null;

        return this.#upsert(marker, rawPath);
    }

    /**
     * Record paths from a completed OpenCode `apply_patch` into the trail.
     * @param {unknown} patchText
     * @returns {{ marker: string, path: string, isNew: boolean }[]}
     */
    recordApplyPatch(patchText) {
        /** @type {{ marker: string, path: string, isNew: boolean }[]} */
        const out = [];
        for (const entry of parseApplyPatchPaths(patchText)) {
            const result = this.#upsert(entry.marker, entry.path);
            if (result) out.push(result);
        }
        return out;
    }

    /** @returns {{ marker: string, path: string }[]} */
    getFiles() {
        return this.files.map((f) => ({ marker: f.marker, path: f.path }));
    }

    /**
     * @param {string} marker
     * @param {string} rawPath
     * @returns {{ marker: string, path: string, isNew: boolean }}
     */
    #upsert(marker, rawPath) {
        const relPath = this.#toRelative(rawPath);
        const existingIdx = this.indexByPath.get(relPath);
        const isNew = existingIdx === undefined;

        if (isNew) {
            this.indexByPath.set(relPath, this.files.length);
            this.files.push({ marker, path: relPath });
        } else {
            this.files[existingIdx].marker = marker;
        }

        return { marker, path: relPath, isNew };
    }

    /** @param {string} filePath */
    #toRelative(filePath) {
        if (path.isAbsolute(filePath)) {
            return path.relative(this.cwd, filePath) || path.basename(filePath);
        }
        return filePath;
    }
}
