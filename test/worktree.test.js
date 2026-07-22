import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree } from '../lib/worktree.js';

/**
 * Fake `execFile` for argument-level unit tests. `handlers` maps a predicate
 * over the git subcommand args to either a stdout string or a thrown error.
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

const isShowToplevel = (args) => args.includes('--show-toplevel');
const isWorktreeAdd = (args) => args.includes('worktree') && args.includes('add');

describe('createWorktree (injected execFile, argument-level)', () => {
  it('resolves repo root and derives worktreePath/branch from cwd and slug', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isShowToplevel, stdout: '/repo/root\n' },
      { match: isWorktreeAdd, stdout: '' },
    ]);

    const result = createWorktree({ cwd: '/repo/root/sub', slug: 'calm-otter-7f3a', execFile });

    assert.deepEqual(result, {
      repoRoot: '/repo/root',
      worktreePath: '/repo/root-calm-otter-7f3a',
      branch: 'orch/calm-otter-7f3a',
    });
  });

  it('invokes git via an executable plus argument arrays, not a shell string', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isShowToplevel, stdout: '/repo/root\n' },
      { match: isWorktreeAdd, stdout: '' },
    ]);

    createWorktree({ cwd: '/repo/root', slug: 'calm-otter-7f3a', execFile });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'git');
    assert.deepEqual(calls[0].args, ['-C', '/repo/root', 'rev-parse', '--show-toplevel']);
    assert.equal(calls[1].command, 'git');
    assert.deepEqual(calls[1].args, [
      '-C',
      '/repo/root',
      'worktree',
      'add',
      '-b',
      'orch/calm-otter-7f3a',
      '/repo/root-calm-otter-7f3a',
    ]);
    // No argument should ever be a pre-joined shell command string.
    calls.forEach((call) => {
      call.args.forEach((arg) => assert.equal(typeof arg, 'string'));
    });
  });

  it('rejects a non-git cwd by propagating the rev-parse failure', () => {
    const gitError = Object.assign(new Error('git failed'), {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    const { execFile } = makeFakeExecFile([{ match: isShowToplevel, error: gitError }]);

    assert.throws(
      () => createWorktree({ cwd: '/not/a/repo', slug: 'calm-otter-7f3a', execFile }),
      /not a git repository/,
    );
  });

  it('refuses to overwrite an existing filesystem path and never invokes worktree add', () => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worktree-unit-'));
    const existingWorktreePath = path.join(tmpParent, 'root-dup-dup-0000');
    fs.mkdirSync(existingWorktreePath);

    const { execFile, calls } = makeFakeExecFile([
      { match: isShowToplevel, stdout: `${path.join(tmpParent, 'root')}\n` },
      { match: isWorktreeAdd, stdout: '' },
    ]);

    assert.throws(() =>
      createWorktree({ cwd: path.join(tmpParent, 'root'), slug: 'dup-dup-0000', execFile }),
    );

    assert.equal(calls.filter((c) => isWorktreeAdd(c.args)).length, 0);

    fs.rmSync(tmpParent, { recursive: true, force: true });
  });

  it('propagates git worktree-add errors without deleting or repairing anything', () => {
    const worktreeError = Object.assign(new Error('git failed'), {
      stderr: 'fatal: a branch named \'orch/calm-otter-7f3a\' already exists',
    });
    const { execFile } = makeFakeExecFile([
      { match: isShowToplevel, stdout: '/repo/root\n' },
      { match: isWorktreeAdd, error: worktreeError },
    ]);

    assert.throws(
      () => createWorktree({ cwd: '/repo/root', slug: 'calm-otter-7f3a', execFile }),
      /already exists/,
    );
  });
});

describe('createWorktree (real temporary git repo, integration)', () => {
  function initTmpRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worktree-repo-'));
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

  it('creates a real sibling worktree and orch/<slug> branch with the default execFile', () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const result = createWorktree({ cwd: repoDir, slug: 'test-abcd' });

      assert.equal(fs.realpathSync(result.repoRoot), fs.realpathSync(repoDir));
      assert.equal(result.branch, 'orch/test-abcd');
      assert.equal(
        fs.realpathSync(result.worktreePath),
        fs.realpathSync(path.join(parent, 'repo-test-abcd')),
      );
      assert.ok(fs.existsSync(result.worktreePath));
      assert.ok(fs.statSync(result.worktreePath).isDirectory());

      const branchList = execFileSync('git', ['branch', '--list', 'orch/test-abcd'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      assert.match(branchList, /orch\/test-abcd/);

      execFileSync('git', ['worktree', 'remove', '--force', result.worktreePath], { cwd: repoDir });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a cwd that is not inside any git repository', () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-worktree-nongit-'));
    try {
      assert.throws(() => createWorktree({ cwd: plainDir, slug: 'no-git-0000' }));
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('rejects when the derived worktree path already exists on disk', () => {
    const { parent, repoDir } = initTmpRepo();
    const slug = 'dup-real-0000';
    const expectedPath = path.join(parent, 'repo-dup-real-0000');
    fs.mkdirSync(expectedPath);
    try {
      assert.throws(() => createWorktree({ cwd: repoDir, slug }));
      // Must not have registered a worktree at that path.
      const list = execFileSync('git', ['worktree', 'list'], { cwd: repoDir, encoding: 'utf8' });
      assert.doesNotMatch(list, /repo-dup-real-0000/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
