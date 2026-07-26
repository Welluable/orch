import path from 'node:path';

/** @param {string} name */
function markerForName(name) {
    const key = String(name || '').toLowerCase();
    if (key === 'write') return '+';
    if (key === 'edit' || key === 'multiedit') return '~';
    if (key === 'delete') return '-';
    return null;
}

/** @param {Record<string, unknown>|null|undefined} args */
function extractPath(args) {
    if (!args || typeof args !== 'object') return null;
    const p = args.path ?? args.file_path;
    return typeof p === 'string' && p ? p : null;
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
                path: extractPath(args),
            });
            return null;
        }

        if (phase !== 'completed') return null;

        const prior = this.pending.get(callId);
        this.pending.delete(callId);

        const toolName = name || prior?.name || '';
        const marker = markerForName(toolName) || prior?.marker || null;
        if (!marker) return null;

        const rawPath = extractPath(args) || prior?.path || null;
        if (!rawPath) return null;

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

    /** @returns {{ marker: string, path: string }[]} */
    getFiles() {
        return this.files.map((f) => ({ marker: f.marker, path: f.path }));
    }

    /** @param {string} filePath */
    #toRelative(filePath) {
        if (path.isAbsolute(filePath)) {
            return path.relative(this.cwd, filePath) || path.basename(filePath);
        }
        return filePath;
    }
}
