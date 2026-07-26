import { execFileSync as nodeExecFileSync } from 'node:child_process';

function defaultExecFile(command, args, options = {}) {
    return nodeExecFileSync(command, args, { encoding: 'utf8', ...options });
}

function runGit(execFile, args) {
    try {
        return execFile('git', args);
    } catch (err) {
        const detail = err.stderr || err.message;
        throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
}

/**
 * Commits all changes in a run's worktree as a single, deterministic commit
 * owned by orch (never the agent). Skips committing when the tree is clean
 * so no empty commit is created. Does not bypass hooks (`--no-verify`) and
 * does not attempt destructive recovery (`reset`/`clean`) on failure;
 * `execFile` is injectable and defaults to a `child_process.execFileSync`
 * wrapper.
 */
export function commitWorktree({ worktreePath, branch, message, execFile = defaultExecFile }) {
    const status = runGit(execFile, ['-C', worktreePath, 'status', '--porcelain']);
    if (status.trim() === '') {
        return { committed: false, sha: null, branch };
    }

    runGit(execFile, ['-C', worktreePath, 'add', '-A']);
    runGit(execFile, ['-C', worktreePath, 'commit', '-m', message]);
    const sha = runGit(execFile, ['-C', worktreePath, 'rev-parse', 'HEAD']).trim();

    return { committed: true, sha, branch };
}

/**
 * Stage the dirty worktree (so untracked files show as `A`) and return
 * cached name-status + shortstat vs worktree `HEAD`. Returns null when clean
 * or when git cannot run against the path (display-only rollup must not abort
 * the pipeline on stub/missing worktrees).
 *
 * @param {{ worktreePath: string, execFile?: Function }} opts
 * @returns {{ files: { status: string, path: string }[], shortstat: string }|null}
 */
export function collectWorktreeChanges({ worktreePath, execFile = defaultExecFile }) {
    try {
        const status = runGit(execFile, ['-C', worktreePath, 'status', '--porcelain']);
        if (status.trim() === '') {
            return null;
        }

        runGit(execFile, ['-C', worktreePath, 'add', '-A']);
        const nameStatus = runGit(execFile, [
            '-C', worktreePath, 'diff', '--cached', '--name-status', 'HEAD',
        ]);
        const shortstatRaw = runGit(execFile, [
            '-C', worktreePath, 'diff', '--cached', '--shortstat', 'HEAD',
        ]);

        const files = nameStatus
            .split('\n')
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .map((line) => {
                const tab = line.indexOf('\t');
                if (tab === -1) return { status: line.trim(), path: '' };
                return {
                    status: line.slice(0, tab).trim(),
                    path: line.slice(tab + 1),
                };
            });

        return { files, shortstat: shortstatRaw.trim() };
    } catch {
        return null;
    }
}

/**
 * Print the titled `files changed` rollup block. No-op for null/empty.
 *
 * @param {{ files: { status: string, path: string }[], shortstat: string }|null|undefined} changes
 * @param {{ log?: (line: string) => void }} [opts]
 */
export function printFilesChanged(changes, { log = console.log } = {}) {
    if (!changes || !Array.isArray(changes.files) || changes.files.length === 0) {
        return;
    }

    const title = ' files changed ';
    const rule = '─'.repeat(title.length);

    log('');
    log(rule);
    log(title);
    log(rule);
    for (const { status, path: filePath } of changes.files) {
        log(`  ${status}  ${filePath}`);
    }
    if (changes.shortstat) {
        log(`  ${changes.shortstat}`);
    }
    log('');
}
