import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, removeWorktree } from '../lib/worktree.js';

/**
 * Contract this file pins down for `removeWorktree` (net-new export of
 * lib/worktree.js, see `.orch/brave-island-c989/task.md`). Kept separate
 * from test/worktree.test.js so the missing export does not fail
 * createWorktree coverage at module-load time.
 *
 * `removeWorktree({ repoRoot, worktreePath, branch, execFile })`:
 * - When `worktreePath` exists on disk, runs
 *   `git -C <repoRoot> worktree remove --force <worktreePath>` via the
 *   injectable `execFile` (same argv style as `createWorktree`).
 * - When `worktreePath` does not exist, skips the worktree-remove git
 *   invocation (no throw).
 * - When `branch` is a non-empty string, best-effort
 *   `git -C <repoRoot> branch -D <branch>` afterward; branch-delete
 *   failures must not throw (already-gone / checked-out elsewhere).
 * - When `branch` is null/undefined/empty, skips branch deletion.
 * - Returns `{ worktreePath, branch, removed: boolean }` where `removed`
 *   is true iff the force worktree-remove command was attempted.
 */

function makeFakeExecFile(handlers) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    for (const { match, stdout, error } of handlers) {
      if (match(args)) {
        if (error) throw error;
        return stdout ?? '';
      }
    }
    throw new Error(`unhandled fake execFile call: ${command} ${args.join(' ')}`);
  };
  return { execFile, calls };
}

const isWorktreeRemove = (args) =>
  args.includes('worktree') && args.includes('remove') && args.includes('--force');
const isBranchDelete = (args) => args.includes('branch') && args.includes('-D');

describe('removeWorktree (injected execFile, argument-level)', () => {
  it('force-removes an existing worktree path then deletes the branch', () => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-remove-unit-'));
    const worktreePath = path.join(tmpParent, 'repo-calm-otter-7f3a');
    fs.mkdirSync(worktreePath);
    const { execFile, calls } = makeFakeExecFile([
      { match: isWorktreeRemove, stdout: '' },
      { match: isBranchDelete, stdout: '' },
    ]);

    try {
      const result = removeWorktree({
        repoRoot: path.join(tmpParent, 'repo'),
        worktreePath,
        branch: 'orch/calm-otter-7f3a',
        execFile,
      });

      assert.deepEqual(result, {
        worktreePath,
        branch: 'orch/calm-otter-7f3a',
        removed: true,
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].command, 'git');
      assert.deepEqual(calls[0].args, [
        '-C',
        path.join(tmpParent, 'repo'),
        'worktree',
        'remove',
        '--force',
        worktreePath,
      ]);
      assert.deepEqual(calls[1].args, [
        '-C',
        path.join(tmpParent, 'repo'),
        'branch',
        '-D',
        'orch/calm-otter-7f3a',
      ]);
    } finally {
      fs.rmSync(tmpParent, { recursive: true, force: true });
    }
  });

  it('skips worktree remove when the path is absent, still best-effort deletes branch', () => {
    const missingPath = path.join(os.tmpdir(), 'orch-wt-missing-nope-0000');
    const { execFile, calls } = makeFakeExecFile([
      { match: isBranchDelete, stdout: '' },
    ]);

    const result = removeWorktree({
      repoRoot: '/repo/root',
      worktreePath: missingPath,
      branch: 'orch/nope-0000',
      execFile,
    });

    assert.equal(result.removed, false);
    assert.equal(calls.filter((c) => isWorktreeRemove(c.args)).length, 0);
    assert.equal(calls.filter((c) => isBranchDelete(c.args)).length, 1);
  });

  it('skips branch deletion when branch is null', () => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-remove-nobranch-'));
    const worktreePath = path.join(tmpParent, 'repo-x');
    fs.mkdirSync(worktreePath);
    const { execFile, calls } = makeFakeExecFile([
      { match: isWorktreeRemove, stdout: '' },
    ]);

    try {
      removeWorktree({
        repoRoot: path.join(tmpParent, 'repo'),
        worktreePath,
        branch: null,
        execFile,
      });
      assert.equal(calls.filter((c) => isBranchDelete(c.args)).length, 0);
      assert.equal(calls.filter((c) => isWorktreeRemove(c.args)).length, 1);
    } finally {
      fs.rmSync(tmpParent, { recursive: true, force: true });
    }
  });

  it('swallows branch -D failures without throwing', () => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-remove-branchfail-'));
    const worktreePath = path.join(tmpParent, 'repo-y');
    fs.mkdirSync(worktreePath);
    const branchError = Object.assign(new Error('git failed'), {
      stderr: "error: branch 'orch/y' not found",
    });
    const { execFile } = makeFakeExecFile([
      { match: isWorktreeRemove, stdout: '' },
      { match: isBranchDelete, error: branchError },
    ]);

    try {
      assert.doesNotThrow(() =>
        removeWorktree({
          repoRoot: path.join(tmpParent, 'repo'),
          worktreePath,
          branch: 'orch/y',
          execFile,
        }),
      );
    } finally {
      fs.rmSync(tmpParent, { recursive: true, force: true });
    }
  });

  it('propagates worktree remove failures', () => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wt-remove-fail-'));
    const worktreePath = path.join(tmpParent, 'repo-z');
    fs.mkdirSync(worktreePath);
    const removeError = Object.assign(new Error('git failed'), {
      stderr: 'fatal: something went wrong',
    });
    const { execFile } = makeFakeExecFile([
      { match: isWorktreeRemove, error: removeError },
    ]);

    try {
      assert.throws(
        () =>
          removeWorktree({
            repoRoot: path.join(tmpParent, 'repo'),
            worktreePath,
            branch: 'orch/z',
            execFile,
          }),
        /something went wrong|git failed/,
      );
    } finally {
      fs.rmSync(tmpParent, { recursive: true, force: true });
    }
  });
});

describe('removeWorktree (real temporary git repo, integration)', () => {
  function initTmpRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worktree-remove-repo-'));
    const repoDir = path.join(parent, 'repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    return { parent, repoDir };
  }

  it('removes a real worktree and deletes the orch/<slug> branch', () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const created = createWorktree({ cwd: repoDir, slug: 'rm-test-abcd' });
      assert.ok(fs.existsSync(created.worktreePath));

      const result = removeWorktree({
        repoRoot: created.repoRoot,
        worktreePath: created.worktreePath,
        branch: created.branch,
      });

      assert.equal(result.removed, true);
      assert.equal(fs.existsSync(created.worktreePath), false);

      const branchList = execFileSync('git', ['branch', '--list', 'orch/rm-test-abcd'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      assert.equal(branchList.trim(), '');

      const list = execFileSync('git', ['worktree', 'list'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      assert.doesNotMatch(list, /rm-test-abcd/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
