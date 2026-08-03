import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { jobPaths, writeJob, readJob, deleteJob } from '../lib/jobs.js';

/**
 * Contract this file pins down for `deleteJob` (net-new export of
 * lib/jobs.js, see `.orch/brave-island-c989/task.md`). Kept in its own
 * file (rather than appended to test/jobs.test.js) so this not-yet-
 * implemented export doesn't fail every pre-existing test in that file
 * at module-load time.
 *
 * `deleteJob(cwd, slug, opts?)` — pure op behind `orch jobs delete <slug>`:
 * - Leaf-only: removes only the named slug's `.orch/<slug>/` directory.
 *   Does not cascade to parent/children; other job dirs stay untouched.
 * - Missing: when `readJob` returns null, returns
 *   `{ status: 'missing', slug }` and does not throw.
 * - Blocked: when this slug is in `liveSlugsBlockingClean` (active live
 *   state `running`/`pausing`/`paused` with an alive pid), returns
 *   `{ status: 'blocked', slug }` without deleting anything or calling
 *   the worktree helper. Dead-pid "live" states may still be deleted.
 * - Deleted: otherwise force-removes any associated worktree (see below),
 *   then `fs.rmSync` of `jobPaths(cwd, slug).dir` (recursive), and returns
 *   `{ status: 'deleted', slug, worktreeRemoved: boolean }`.
 * - Worktree removal: if `record.worktree` is a non-empty string, call
 *   `opts.removeWorktree` (default: `lib/worktree.js` `removeWorktree`)
 *   with `{ repoRoot, worktreePath: record.worktree, branch:
 *   record.branch ?? \`orch/${slug}\`, execFile: opts.execFile }`.
 *   When `record.worktree` is null/absent, resolve the createWorktree
 *   sibling path `<dirname(cwd)>/<basename(cwd)>-<slug>` (same formula as
 *   createWorktree when repoRoot === cwd); if that path exists on disk,
 *   call the helper with it and branch `record.branch ?? \`orch/${slug}\``.
 *   Implementers must not skip force-cleanup solely because worktree is
 *   null — the on-disk sibling is enough to require removeWorktree.
 *   `worktreeRemoved` is true iff the helper was invoked.
 * - `opts.removeWorktree` / `opts.execFile` are injectable for tests.
 * - Does not change bulk `cleanJobs` behavior.
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-jobs-delete-'));
}

function baseRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    slug: 'stub-stub-0000',
    task: 'do the thing',
    agent: 'claude',
    maxRounds: 5,
    cwd: '/tmp/wherever',
    pauseRequested: false,
    branch: null,
    worktree: null,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    logPath: '/tmp/wherever/.orch/stub-stub-0000/orch.log',
    pid: process.pid,
    state: 'running',
    phase: 'test-loop',
    stage: 'test-writer',
    round: 1,
    ...overrides,
  };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return pid;
}

describe('deleteJob', () => {
  it('returns missing when the slug has no run.json', () => {
    const tmpCwd = makeTmpCwd();
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, 'nobody-here-0000', { removeWorktree });

    assert.deepEqual(result, { status: 'missing', slug: 'nobody-here-0000' });
    assert.equal(removeWorktree.mock.calls.length, 0);
    assert.equal(readJob(tmpCwd, 'nobody-here-0000'), null);
  });

  it('deletes a finished job dir and leaves sibling jobs alone', () => {
    const tmpCwd = makeTmpCwd();
    writeJob(tmpCwd, 'keep-me-0001', baseRecord({
      slug: 'keep-me-0001',
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    }));
    writeJob(tmpCwd, 'drop-me-0002', baseRecord({
      slug: 'drop-me-0002',
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    }));
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, 'drop-me-0002', { removeWorktree });

    assert.deepEqual(result, {
      status: 'deleted',
      slug: 'drop-me-0002',
      worktreeRemoved: false,
    });
    assert.equal(removeWorktree.mock.calls.length, 0);
    assert.equal(readJob(tmpCwd, 'drop-me-0002'), null);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, 'drop-me-0002').dir), false);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, 'keep-me-0001').runJsonPath), true);
  });

  it('does not cascade: deleting a parent leaves child job dirs', () => {
    const tmpCwd = makeTmpCwd();
    writeJob(tmpCwd, 'parent-job-0000', baseRecord({
      slug: 'parent-job-0000',
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    }));
    writeJob(tmpCwd, 'child-job-0001', baseRecord({
      slug: 'child-job-0001',
      parent: 'parent-job-0000',
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    }));

    const result = deleteJob(tmpCwd, 'parent-job-0000', { removeWorktree: mock.fn() });

    assert.equal(result.status, 'deleted');
    assert.equal(readJob(tmpCwd, 'parent-job-0000'), null);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, 'child-job-0001').runJsonPath), true);
  });

  for (const state of ['running', 'pausing', 'paused']) {
    it(`returns blocked when a ${state} job has an alive pid (dir untouched)`, () => {
      const tmpCwd = makeTmpCwd();
      const liveSlug = `live-${state}-0000`;
      writeJob(tmpCwd, liveSlug, baseRecord({
        slug: liveSlug,
        state,
        pid: process.pid,
      }));
      const removeWorktree = mock.fn();

      const result = deleteJob(tmpCwd, liveSlug, { removeWorktree });

      assert.deepEqual(result, { status: 'blocked', slug: liveSlug });
      assert.equal(removeWorktree.mock.calls.length, 0);
      assert.equal(fs.existsSync(jobPaths(tmpCwd, liveSlug).runJsonPath), true);
    });
  }

  it('still deletes when a live-state job has a dead pid', async () => {
    const tmpCwd = makeTmpCwd();
    const pid = await deadPid();
    writeJob(tmpCwd, 'dead-running-0000', baseRecord({
      slug: 'dead-running-0000',
      state: 'running',
      pid,
    }));

    const result = deleteJob(tmpCwd, 'dead-running-0000', { removeWorktree: mock.fn() });

    assert.equal(result.status, 'deleted');
    assert.equal(readJob(tmpCwd, 'dead-running-0000'), null);
  });

  it('invokes removeWorktree when record.worktree is set, then removes the job dir', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'with-wt-0000';
    const worktreePath = path.join(os.tmpdir(), `orch-fake-wt-${slug}`);
    writeJob(tmpCwd, slug, baseRecord({
      slug,
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      worktree: worktreePath,
      branch: `orch/${slug}`,
      cwd: tmpCwd,
    }));
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, slug, { removeWorktree });

    assert.deepEqual(result, {
      status: 'deleted',
      slug,
      worktreeRemoved: true,
    });
    assert.equal(removeWorktree.mock.calls.length, 1);
    const [args] = removeWorktree.mock.calls[0].arguments;
    assert.equal(args.worktreePath, worktreePath);
    assert.equal(args.branch, `orch/${slug}`);
    assert.equal(readJob(tmpCwd, slug), null);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, slug).dir), false);
  });

  it('defaults branch to orch/<slug> when record.worktree is set but record.branch is null', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'wt-nobranch-0000';
    const worktreePath = path.join(os.tmpdir(), `orch-fake-wt-${slug}`);
    writeJob(tmpCwd, slug, baseRecord({
      slug,
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      worktree: worktreePath,
      branch: null,
      cwd: tmpCwd,
    }));
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, slug, { removeWorktree });

    assert.equal(result.status, 'deleted');
    assert.equal(result.worktreeRemoved, true);
    assert.equal(removeWorktree.mock.calls.length, 1);
    const [args] = removeWorktree.mock.calls[0].arguments;
    assert.equal(args.worktreePath, worktreePath);
    assert.equal(args.branch, `orch/${slug}`);
  });

  it('invokes removeWorktree when worktree is null/absent but createWorktree sibling path exists', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'orphan-sib-0000';
    // createWorktree sibling when repoRoot === cwd: <parent>/<basename(cwd)>-<slug>
    const siblingPath = path.join(path.dirname(tmpCwd), `${path.basename(tmpCwd)}-${slug}`);
    fs.mkdirSync(siblingPath);
    writeJob(tmpCwd, slug, baseRecord({
      slug,
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      worktree: null,
      branch: null,
      cwd: tmpCwd,
    }));
    const removeWorktree = mock.fn();

    try {
      const result = deleteJob(tmpCwd, slug, { removeWorktree });

      assert.deepEqual(result, {
        status: 'deleted',
        slug,
        worktreeRemoved: true,
      });
      assert.equal(removeWorktree.mock.calls.length, 1);
      const [args] = removeWorktree.mock.calls[0].arguments;
      assert.equal(args.worktreePath, siblingPath);
      assert.equal(args.branch, `orch/${slug}`);
      assert.equal(readJob(tmpCwd, slug), null);
      assert.equal(fs.existsSync(jobPaths(tmpCwd, slug).dir), false);
    } finally {
      fs.rmSync(siblingPath, { recursive: true, force: true });
    }
  });

  it('invokes removeWorktree for sibling path when worktree field is absent (not just null)', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'absent-sib-0000';
    const siblingPath = path.join(path.dirname(tmpCwd), `${path.basename(tmpCwd)}-${slug}`);
    fs.mkdirSync(siblingPath);
    const record = baseRecord({
      slug,
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      branch: null,
      cwd: tmpCwd,
    });
    delete record.worktree;
    writeJob(tmpCwd, slug, record);
    const removeWorktree = mock.fn();

    try {
      const result = deleteJob(tmpCwd, slug, { removeWorktree });

      assert.equal(result.status, 'deleted');
      assert.equal(result.worktreeRemoved, true);
      assert.equal(removeWorktree.mock.calls.length, 1);
      const [args] = removeWorktree.mock.calls[0].arguments;
      assert.equal(args.worktreePath, siblingPath);
      assert.equal(args.branch, `orch/${slug}`);
    } finally {
      fs.rmSync(siblingPath, { recursive: true, force: true });
    }
  });

  it('does not call removeWorktree when worktree is null and no sibling path exists', () => {
    const tmpCwd = makeTmpCwd();
    writeJob(tmpCwd, 'no-wt-0000', baseRecord({
      slug: 'no-wt-0000',
      state: 'done',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      worktree: null,
      branch: null,
      cwd: tmpCwd,
    }));
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, 'no-wt-0000', { removeWorktree });

    assert.deepEqual(result, {
      status: 'deleted',
      slug: 'no-wt-0000',
      worktreeRemoved: false,
    });
    assert.equal(removeWorktree.mock.calls.length, 0);
  });

  it('does not call removeWorktree when blocked, even if worktree is set', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'live-wt-0000';
    writeJob(tmpCwd, slug, baseRecord({
      slug,
      state: 'running',
      pid: process.pid,
      worktree: `/tmp/wherever-${slug}`,
      branch: `orch/${slug}`,
    }));
    const removeWorktree = mock.fn();

    const result = deleteJob(tmpCwd, slug, { removeWorktree });

    assert.equal(result.status, 'blocked');
    assert.equal(removeWorktree.mock.calls.length, 0);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, slug).runJsonPath), true);
  });
});
