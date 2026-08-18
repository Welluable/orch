import { execFileSync as nodeExecFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
 * Creates a persistent sibling git worktree for a run: resolves the repo
 * root from `cwd`, derives `<repoRoot>-<slug>` and `${branchPrefix}/${slug}`
 * (`branchPrefix` defaults to `'orch'`), and creates both the branch and the
 * worktree via argument-array git invocations. `execFile` is injectable and
 * defaults to a `child_process.execFileSync` wrapper.
 */
export function createWorktree({ cwd, slug, execFile = defaultExecFile, base, branchPrefix = 'orch' }) {
    const repoRoot = runGit(execFile, ['-C', cwd, 'rev-parse', '--show-toplevel']).trim();

    const worktreePath = `${path.join(path.dirname(repoRoot), path.basename(repoRoot))}-${slug}`;
    const branch = `${branchPrefix}/${slug}`;

    if (fs.existsSync(worktreePath)) {
        throw new Error(`createWorktree: refusing to overwrite existing path ${worktreePath}`);
    }

    const args = ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath];
    if (base) args.push(base);
    runGit(execFile, args);

    return { repoRoot, worktreePath, branch };
}
