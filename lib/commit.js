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
