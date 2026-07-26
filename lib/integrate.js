import { execFileSync as nodeExecFileSync } from 'node:child_process';

function defaultExecFile(command, args, options = {}) {
    return nodeExecFileSync(command, args, { encoding: 'utf8', ...options });
}

function parseLines(output) {
    return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Sequentially merges `candidates` (in order) into `cwd` via `git merge
 * --no-ff`, skipping branches already present in `merged`. Stops advancing on
 * the first conflict, leaving the tree conflicted for the caller to repair or
 * abort. Returns the per-branch results accumulated so far.
 */
export function mergeBranches({ cwd, candidates, merged = [], overlappingFiles = [], execFile = defaultExecFile }) {
    const results = [];
    for (const branch of candidates) {
        if (merged.includes(branch)) {
            results.push({ branch, status: 'skipped' });
            continue;
        }

        try {
            const output = execFile('git', ['-C', cwd, 'merge', '--no-ff', branch]);
            results.push({ branch, status: 'merged', output });
        } catch (err) {
            results.push({ branch, status: 'conflict', output: err.stderr || err.message });
            break;
        }
    }
    return results;
}

/** Runs `git merge --abort` in `cwd`. */
export function abortMerge({ cwd, execFile = defaultExecFile }) {
    return execFile('git', ['-C', cwd, 'merge', '--abort']);
}

/** Runs `git diff --name-only --diff-filter=U` in `cwd`; returns the parsed path array. */
export function conflictedFiles({ cwd, execFile = defaultExecFile }) {
    const output = execFile('git', ['-C', cwd, 'diff', '--name-only', '--diff-filter=U']);
    return parseLines(output);
}

/** True if `git diff` in `cwd` still shows an unresolved `<<<<<<<` marker. */
export function hasConflictMarkers({ cwd, execFile = defaultExecFile }) {
    const output = execFile('git', ['-C', cwd, 'diff']);
    return output.includes('<<<<<<<');
}
