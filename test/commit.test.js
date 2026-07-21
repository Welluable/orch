import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitWorktree } from '../lib/commit.js';

/**
 * Fake `execFile` for argument-level unit tests. `handlers` maps a predicate
 * over the git subcommand args to either a stdout string or a thrown error.
 * Every call (matched or not) is recorded into `calls` so tests can assert on
 * call order and on the absence of unwanted invocations (e.g. `--no-verify`,
 * `reset`, `clean`).
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

const isStatus = (args) => args.includes('status') && args.includes('--porcelain');
const isAdd = (args) => args.includes('add') && args.includes('-A');
const isCommit = (args) => args.includes('commit') && args.includes('-m');
const isRevParse = (args) => args.includes('rev-parse') && args.includes('HEAD');
const isNoVerify = (args) => args.includes('--no-verify');
const isResetOrClean = (args) => args.includes('reset') || args.includes('clean');

describe('commitWorktree (injected execFile, argument-level)', () => {
  it('clean tree: skips add/commit and returns committed: false', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isStatus, stdout: '' },
    ]);

    const result = commitWorktree({
      worktreePath: '/repo/root-slug',
      branch: 'orch/slug',
      message: 'orch: slug do the thing',
      execFile,
    });

    assert.deepEqual(result, { committed: false, sha: null, branch: 'orch/slug' });
    assert.equal(calls.length, 1);
    assert.ok(isStatus(calls[0].args));
    assert.equal(calls.filter((c) => isAdd(c.args)).length, 0);
    assert.equal(calls.filter((c) => isCommit(c.args)).length, 0);
    assert.equal(calls.filter((c) => isRevParse(c.args)).length, 0);
  });

  it('clean tree: status output with only whitespace also counts as clean', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isStatus, stdout: '\n  \n' },
    ]);

    const result = commitWorktree({
      worktreePath: '/repo/root-slug',
      branch: 'orch/slug',
      message: 'orch: slug do the thing',
      execFile,
    });

    assert.deepEqual(result, { committed: false, sha: null, branch: 'orch/slug' });
    assert.equal(calls.filter((c) => isAdd(c.args)).length, 0);
  });

  it('dirty tree: stages, commits, and returns the trimmed HEAD sha, in call order', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isStatus, stdout: ' M lib/foo.js\n' },
      { match: isAdd, stdout: '' },
      { match: isCommit, stdout: '' },
      { match: isRevParse, stdout: 'deadbeefcafebabe0000000000000000000000\n' },
    ]);

    const result = commitWorktree({
      worktreePath: '/repo/root-slug',
      branch: 'orch/slug',
      message: 'orch: slug do the thing',
      execFile,
    });

    assert.deepEqual(result, {
      committed: true,
      sha: 'deadbeefcafebabe0000000000000000000000',
      branch: 'orch/slug',
    });

    assert.equal(calls.length, 4);
    assert.equal(calls[0].command, 'git');
    assert.deepEqual(calls[0].args, ['-C', '/repo/root-slug', 'status', '--porcelain']);
    assert.deepEqual(calls[1].args, ['-C', '/repo/root-slug', 'add', '-A']);
    assert.deepEqual(calls[2].args, ['-C', '/repo/root-slug', 'commit', '-m', 'orch: slug do the thing']);
    assert.deepEqual(calls[3].args, ['-C', '/repo/root-slug', 'rev-parse', 'HEAD']);

    // No argument should ever be a pre-joined shell command string.
    calls.forEach((call) => {
      assert.equal(call.command, 'git');
      call.args.forEach((arg) => assert.equal(typeof arg, 'string'));
    });

    // Never bypass hooks, and never attempt destructive recovery.
    assert.equal(calls.filter((c) => isNoVerify(c.args)).length, 0);
    assert.equal(calls.filter((c) => isResetOrClean(c.args)).length, 0);
  });

  it('commit/hook failure: propagates the error with stderr, no --no-verify retry, no reset/clean', () => {
    const commitError = Object.assign(new Error('git failed'), {
      stderr: 'hook declined: lint errors found',
    });
    const { execFile, calls } = makeFakeExecFile([
      { match: isStatus, stdout: ' M lib/foo.js\n' },
      { match: isAdd, stdout: '' },
      { match: isCommit, error: commitError },
    ]);

    assert.throws(
      () => commitWorktree({
        worktreePath: '/repo/root-slug',
        branch: 'orch/slug',
        message: 'orch: slug do the thing',
        execFile,
      }),
      /hook declined: lint errors found/,
    );

    assert.equal(calls.filter((c) => isRevParse(c.args)).length, 0);
    assert.equal(calls.filter((c) => isNoVerify(c.args)).length, 0);
    assert.equal(calls.filter((c) => isResetOrClean(c.args)).length, 0);
  });

  it('defaults execFile to a wrapper the caller can omit (no throw for missing execFile)', () => {
    // Sanity check that execFile is optional at the call site by supplying an
    // explicit fake rather than exercising the real default here (the real
    // default is covered by the integration block below).
    const { execFile } = makeFakeExecFile([{ match: isStatus, stdout: '' }]);
    assert.doesNotThrow(() => commitWorktree({
      worktreePath: '/repo/root-slug',
      branch: 'orch/slug',
      message: 'orch: slug do the thing',
      execFile,
    }));
  });
});

describe('commitWorktree (real temporary git repo, integration)', () => {
  function initTmpRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-commit-repo-'));
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

  it('stages and commits a real dirty tree with the default execFile', () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello again\n');
      fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'new\n');

      const message = 'orch: test-abcd do the thing';
      const result = commitWorktree({
        worktreePath: repoDir,
        branch: 'orch/test-abcd',
        message,
      });

      assert.equal(result.committed, true);
      assert.equal(result.branch, 'orch/test-abcd');

      const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      assert.equal(result.sha, expectedSha);

      const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoDir, encoding: 'utf8' }).trim();
      assert.equal(subject, message);

      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
      assert.equal(status.trim(), '');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reports committed: false and creates no commit on a clean tree', () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const before = execFileSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf8' });

      const result = commitWorktree({
        worktreePath: repoDir,
        branch: 'orch/test-abcd',
        message: 'orch: test-abcd do the thing',
      });

      assert.deepEqual(result, { committed: false, sha: null, branch: 'orch/test-abcd' });

      const after = execFileSync('git', ['log', '--oneline'], { cwd: repoDir, encoding: 'utf8' });
      assert.equal(after, before);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
