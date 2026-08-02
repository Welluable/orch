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

function runGh(execFile, args, options = {}) {
    try {
        return execFile('gh', args, options);
    } catch (err) {
        const detail = err.stderr || err.message;
        throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
    }
}

/**
 * Resolve the remote's default branch name (no `origin/` prefix).
 * Retries once via `git remote set-head origin --auto` when the symbolic-ref
 * is missing.
 *
 * @param {{ cwd: string, execFile?: Function }} opts
 * @returns {string}
 */
export function resolveBaseBranch({ cwd, execFile = defaultExecFile }) {
    const readHead = () =>
        runGit(execFile, ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
            .trim()
            .replace(/^origin\//, '');

    try {
        return readHead();
    } catch {
        try {
            runGit(execFile, ['-C', cwd, 'remote', 'set-head', 'origin', '--auto']);
        } catch (err) {
            throw new Error(
                `Unable to resolve origin/HEAD (default branch): ${err.message}`,
            );
        }
        try {
            return readHead();
        } catch (err) {
            throw new Error(
                `Unable to resolve origin/HEAD after set-head --auto (symbolic-ref still missing): ${err.message}`,
            );
        }
    }
}

/**
 * @param {{ cwd: string, remote: string, base: string, execFile?: Function }} opts
 */
export function fetchBase({ cwd, remote, base, execFile = defaultExecFile }) {
    runGit(execFile, ['-C', cwd, 'fetch', remote, base]);
}

/**
 * @param {{ worktreePath: string, remote: string, branch: string, execFile?: Function }} opts
 */
export function pushBranch({ worktreePath, remote, branch, execFile = defaultExecFile }) {
    runGit(execFile, ['-C', worktreePath, 'push', '-u', remote, branch]);
}

/**
 * @param {{ worktreePath: string, branch: string, execFile?: Function }} opts
 * @returns {{ url: string, number: number }|null}
 */
export function findOpenPullRequest({ worktreePath, branch, execFile = defaultExecFile }) {
    const stdout = runGh(
        execFile,
        ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url,number'],
        { cwd: worktreePath },
    );
    const list = JSON.parse(String(stdout || '[]').trim() || '[]');
    if (!Array.isArray(list) || list.length === 0) return null;
    return { url: list[0].url, number: list[0].number };
}

/**
 * @param {{
 *   worktreePath: string,
 *   base: string,
 *   branch: string,
 *   title: string,
 *   bodyPath: string,
 *   execFile?: Function,
 * }} opts
 * @returns {{ url: string, number: number }}
 */
export function createPullRequest({
    worktreePath,
    base,
    branch,
    title,
    bodyPath,
    execFile = defaultExecFile,
}) {
    const stdout = runGh(
        execFile,
        [
            'pr', 'create',
            '--base', base,
            '--head', branch,
            '--title', title,
            '--body-file', bodyPath,
        ],
        { cwd: worktreePath },
    );
    const url = String(stdout).trim().split('\n').filter(Boolean).pop();
    const match = url?.match(/\/pull\/(\d+)/);
    if (!url || !match) {
        throw new Error(`gh pr create failed: could not parse PR URL from output: ${stdout}`);
    }
    return { url, number: Number(match[1]) };
}

/**
 * Push the branch, reuse an existing open PR when present, otherwise create one.
 * Step helpers are injectable for pipeline tests.
 *
 * @param {{
 *   worktreePath: string,
 *   remote: string,
 *   branch: string,
 *   base: string,
 *   title: string,
 *   bodyPath: string,
 *   execFile?: Function,
 *   pushBranch?: Function,
 *   findOpenPullRequest?: Function,
 *   createPullRequest?: Function,
 * }} opts
 * @returns {{ url: string, number: number, reused?: boolean }}
 */
export function publish({
    worktreePath,
    remote,
    branch,
    base,
    title,
    bodyPath,
    execFile = defaultExecFile,
    pushBranch: pushBranchFn = pushBranch,
    findOpenPullRequest: findOpenPullRequestFn = findOpenPullRequest,
    createPullRequest: createPullRequestFn = createPullRequest,
}) {
    pushBranchFn({ worktreePath, remote, branch, execFile });

    const existing = findOpenPullRequestFn({ worktreePath, branch, execFile });
    if (existing) {
        return { url: existing.url, number: existing.number, reused: true };
    }

    return createPullRequestFn({
        worktreePath,
        base,
        branch,
        title,
        bodyPath,
        execFile,
    });
}
