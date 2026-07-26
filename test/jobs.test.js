import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  jobPaths,
  writeJob,
  readJob,
  patchJob,
  listJobs,
  isPidAlive,
  reconcileJob,
  checkpointPause,
  requestPause,
  requestResume,
  stopJob,
  cleanJobs,
} from '../lib/jobs.js';
import { allocateJob } from '../lib/job-lifecycle.js';

/**
 * Contract this file pins down for lib/jobs.js (net-new module, see
 * .orch/swift-lagoon-49ea/task.md section 2 and research.md):
 *
 * - jobPaths(cwd, slug) -> { dir, runJsonPath, lockPath, logPath }, all
 *   absolute and rooted under `<cwd>/.orch/<slug>/`.
 * - writeJob(cwd, slug, record) -> atomic write (temp file + rename) of
 *   run.json; creates the job dir if missing.
 * - readJob(cwd, slug) -> parsed record, or `null` if run.json does not
 *   exist. Throws if run.json exists but is not valid JSON.
 * - patchJob(cwd, slug, patchFnOrObject) -> acquires `.run.lock` (exclusive
 *   create), retries briefly on contention, removes a stale lock (dead
 *   owner pid), re-reads the latest record, shallow-merges the patch
 *   (object, or a function `(current) => partialPatch`) over it, atomic
 *   writes, releases the lock, and returns the updated record.
 * - listJobs(cwd) -> every run.json record found under `.orch`, most-recent-first by
 *   `startedAt`, each passed through reconcileJob; dirs without run.json
 *   are skipped.
 * - isPidAlive(pid) -> boolean, via `process.kill(pid, 0)`.
 * - reconcileJob(cwd, slug, record) -> if state is running/pausing/paused
 *   and the pid is dead, atomically rewrites to crashed (finishedAt set,
 *   exitCode null) and returns the updated record; otherwise returns the
 *   record unchanged (including for the "starting" and terminal states).
 * - checkpointPause(cwd, slug, { pollIntervalMs }) -> async cooperative
 *   pause point: no-op if pauseRequested is falsy; otherwise patches to
 *   paused, polls run.json until pauseRequested clears, then patches back
 *   to running.
 * - requestPause(cwd, slug) / requestResume(cwd, slug) -> the pure
 *   operations behind `orch pause`/`orch resume`; idempotent in active
 *   states, throw on unknown slug or terminal state.
 * - stopJob(cwd, slug, { kill }) -> the pure operation behind `orch stop`:
 *   signals a live pid, or reconciles+reports a dead one to crashed.
 * - cleanJobs(cwd) -> removes every entry under `.orch/` and returns the
 *   deleted names (empty when `.orch` is missing or already empty).
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-jobs-'));
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

/** Spawns a real child process, waits for it to exit, and returns its
 * now-dead pid — the standard way this suite fabricates a "dead pid". */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return pid;
}

describe('jobPaths', () => {
  it('returns absolute paths rooted under <cwd>/.orch/<slug>/', () => {
    const tmpCwd = makeTmpCwd();
    const paths = jobPaths(tmpCwd, 'swift-lagoon-49ea');

    assert.equal(paths.dir, path.join(tmpCwd, '.orch', 'swift-lagoon-49ea'));
    assert.equal(paths.runJsonPath, path.join(paths.dir, 'run.json'));
    assert.equal(paths.lockPath, path.join(paths.dir, '.run.lock'));
    assert.equal(paths.logPath, path.join(paths.dir, 'orch.log'));
    for (const p of Object.values(paths)) {
      assert.ok(path.isAbsolute(p), `${p} should be absolute`);
    }
  });
});

describe('writeJob / readJob', () => {
  it('round-trips a record through an atomic write (no leftover temp files)', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord();

    writeJob(tmpCwd, record.slug, record);

    const read = readJob(tmpCwd, record.slug);
    assert.deepEqual(read, record);

    const { dir } = jobPaths(tmpCwd, record.slug);
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, ['run.json']);
  });

  it('creates the job directory if it does not already exist', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'brand-new-0001' });

    assert.equal(fs.existsSync(jobPaths(tmpCwd, record.slug).dir), false);
    writeJob(tmpCwd, record.slug, record);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, record.slug).dir), true);
  });

  it('readJob returns null when run.json is missing', () => {
    const tmpCwd = makeTmpCwd();
    assert.equal(readJob(tmpCwd, 'never-created-0000'), null);
  });

  it('readJob throws on malformed JSON rather than silently returning null', () => {
    const tmpCwd = makeTmpCwd();
    const { dir, runJsonPath } = jobPaths(tmpCwd, 'broken-record-0000');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(runJsonPath, '{ not valid json');

    assert.throws(() => readJob(tmpCwd, 'broken-record-0000'));
  });

  it('a second writeJob overwrites the first without leaving stray temp files', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord();
    writeJob(tmpCwd, record.slug, record);
    writeJob(tmpCwd, record.slug, { ...record, state: 'done' });

    assert.equal(readJob(tmpCwd, record.slug).state, 'done');
    const { dir } = jobPaths(tmpCwd, record.slug);
    assert.deepEqual(fs.readdirSync(dir), ['run.json']);
  });
});

describe('listJobs', () => {
  it('returns records most-recent-first by startedAt, skipping dirs without run.json', () => {
    const tmpCwd = makeTmpCwd();

    const older = baseRecord({ slug: 'calm-otter-aaaa', startedAt: '2026-01-01T00:00:00.000Z', state: 'done', finishedAt: '2026-01-01T00:05:00.000Z', exitCode: 0 });
    const newer = baseRecord({ slug: 'bright-pine-bbbb', startedAt: '2026-01-02T00:00:00.000Z', state: 'done', finishedAt: '2026-01-02T00:05:00.000Z', exitCode: 0 });
    writeJob(tmpCwd, older.slug, older);
    writeJob(tmpCwd, newer.slug, newer);

    // A pre-existing foreground-run artifact dir with no run.json at all
    // (the shape every .orch/<slug>/ directory has today, per research.md).
    fs.mkdirSync(path.join(tmpCwd, '.orch', 'no-run-json-cccc'), { recursive: true });
    fs.writeFileSync(path.join(tmpCwd, '.orch', 'no-run-json-cccc', 'status.md'), '# Status\n');

    const jobs = listJobs(tmpCwd);

    assert.deepEqual(jobs.map((j) => j.slug), ['bright-pine-bbbb', 'calm-otter-aaaa']);
  });

  it('returns an empty array when .orch does not exist or has no job dirs', () => {
    const tmpCwd = makeTmpCwd();
    assert.deepEqual(listJobs(tmpCwd), []);
  });

  it('runs every record through reconcileJob (dead-pid running job surfaces as crashed)', async () => {
    const tmpCwd = makeTmpCwd();
    const pid = await deadPid();
    const record = baseRecord({ slug: 'dead-pid-0000', state: 'running', pid });
    writeJob(tmpCwd, record.slug, record);

    const [job] = listJobs(tmpCwd);
    assert.equal(job.state, 'crashed');
    assert.equal(job.exitCode, null);
    assert.ok(job.finishedAt);

    // The reconciliation must be persisted to disk, not just returned.
    assert.equal(readJob(tmpCwd, record.slug).state, 'crashed');
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  it('returns false for a pid that has already exited', async () => {
    const pid = await deadPid();
    assert.equal(isPidAlive(pid), false);
  });

  it('returns false rather than throwing for a nonsense pid', () => {
    assert.equal(isPidAlive(-1), false);
  });
});

describe('reconcileJob', () => {
  it('leaves a live running job unchanged', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'live-one-0000', state: 'running', pid: process.pid });
    writeJob(tmpCwd, record.slug, record);

    const result = reconcileJob(tmpCwd, record.slug, record);

    assert.deepEqual(result, record);
    assert.deepEqual(readJob(tmpCwd, record.slug), record);
  });

  for (const state of ['running', 'pausing', 'paused']) {
    it(`rewrites a dead-pid ${state} job to crashed on disk (finishedAt set, exitCode null)`, async () => {
      const tmpCwd = makeTmpCwd();
      const pid = await deadPid();
      const record = baseRecord({ slug: `dead-${state}-0000`, state, pid });
      writeJob(tmpCwd, record.slug, record);

      const result = reconcileJob(tmpCwd, record.slug, record);

      assert.equal(result.state, 'crashed');
      assert.equal(result.exitCode, null);
      assert.ok(result.finishedAt);
      assert.notEqual(result.finishedAt, null);

      const onDisk = readJob(tmpCwd, record.slug);
      assert.equal(onDisk.state, 'crashed');
      assert.equal(onDisk.exitCode, null);
      assert.ok(onDisk.finishedAt);
    });
  }

  for (const state of ['done', 'failed', 'stopped', 'crashed']) {
    it(`leaves a terminal "${state}" job alone even with a dead pid`, async () => {
      const tmpCwd = makeTmpCwd();
      const pid = await deadPid();
      const record = baseRecord({
        slug: `terminal-${state}-0000`,
        state,
        pid,
        finishedAt: new Date().toISOString(),
        exitCode: state === 'done' ? 0 : 1,
      });
      writeJob(tmpCwd, record.slug, record);

      const result = reconcileJob(tmpCwd, record.slug, record);

      assert.deepEqual(result, record);
      assert.deepEqual(readJob(tmpCwd, record.slug), record);
    });
  }

  it('leaves a "starting" job alone even with a dead pid (not yet an active/live state)', async () => {
    const tmpCwd = makeTmpCwd();
    const pid = await deadPid();
    const record = baseRecord({ slug: 'still-starting-0000', state: 'starting', pid: null });
    writeJob(tmpCwd, record.slug, record);

    const result = reconcileJob(tmpCwd, record.slug, record);

    assert.deepEqual(result, record);
  });
});

describe('patchJob', () => {
  it('merges the patched fields without clobbering the rest of the record', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'merge-me-0000' });
    writeJob(tmpCwd, record.slug, record);

    const updated = patchJob(tmpCwd, record.slug, { phase: 'code-loop', stage: 'code-writer' });

    assert.equal(updated.phase, 'code-loop');
    assert.equal(updated.stage, 'code-writer');
    // Untouched fields survive.
    assert.equal(updated.task, record.task);
    assert.equal(updated.agent, record.agent);
    assert.equal(updated.pid, record.pid);
    assert.deepEqual(readJob(tmpCwd, record.slug), updated);
  });

  it('accepts a function that receives the latest record and returns a partial patch', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'fn-patch-0000', round: 1 });
    writeJob(tmpCwd, record.slug, record);

    const updated = patchJob(tmpCwd, record.slug, (current) => ({ round: current.round + 1 }));

    assert.equal(updated.round, 2);
  });

  it('releases the lock file after a successful patch', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'lock-release-0000' });
    writeJob(tmpCwd, record.slug, record);

    patchJob(tmpCwd, record.slug, { state: 'paused' });

    assert.equal(fs.existsSync(jobPaths(tmpCwd, record.slug).lockPath), false);
  });

  it('removes a stale lock (owner pid dead) instead of hanging, then proceeds', async () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'stale-lock-0000' });
    writeJob(tmpCwd, record.slug, record);

    const { dir, lockPath } = jobPaths(tmpCwd, record.slug);
    fs.mkdirSync(dir, { recursive: true });
    const staleOwnerPid = await deadPid();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: staleOwnerPid }));

    const updated = patchJob(tmpCwd, record.slug, { state: 'stopped', exitCode: 143 });

    assert.equal(updated.state, 'stopped');
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('creates the job directory and run.json if patching a job that was never writeJob-ed', () => {
    const tmpCwd = makeTmpCwd();
    const updated = patchJob(tmpCwd, 'never-written-0000', { state: 'starting' });
    assert.equal(updated.state, 'starting');
    assert.deepEqual(readJob(tmpCwd, 'never-written-0000'), updated);
  });

  it('serializes concurrent patches from two real processes without losing any increment', async () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'concurrent-0000', counter: 0 });
    writeJob(tmpCwd, record.slug, record);

    const jobsPath = path.join(new URL('../lib/jobs.js', import.meta.url).pathname);
    const incrementerScript = `
      import { patchJob } from ${JSON.stringify(`file://${jobsPath}`)};
      for (let i = 0; i < 25; i += 1) {
        patchJob(${JSON.stringify(tmpCwd)}, ${JSON.stringify(record.slug)}, (current) => ({ counter: (current.counter || 0) + 1 }));
      }
    `;

    const runIncrementer = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', incrementerScript]);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`incrementer exited ${code}: ${stderr}`))));
    });

    await Promise.all([runIncrementer(), runIncrementer()]);

    assert.equal(readJob(tmpCwd, record.slug).counter, 50);
  });
});

describe('checkpointPause', () => {
  it('returns immediately without touching state when pauseRequested is falsy', async () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'no-pause-0000', pauseRequested: false, state: 'running' });
    writeJob(tmpCwd, record.slug, record);

    await checkpointPause(tmpCwd, record.slug, { pollIntervalMs: 10 });

    assert.equal(readJob(tmpCwd, record.slug).state, 'running');
  });

  it('transitions to paused, waits for pauseRequested to clear, then returns to running', async () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'pause-then-resume-0000', pauseRequested: true, state: 'pausing' });
    writeJob(tmpCwd, record.slug, record);

    let sawPaused = false;
    const poll = setInterval(() => {
      const current = readJob(tmpCwd, record.slug);
      if (current.state === 'paused') {
        sawPaused = true;
        clearInterval(poll);
        patchJob(tmpCwd, record.slug, { pauseRequested: false });
      }
    }, 10);

    try {
      await checkpointPause(tmpCwd, record.slug, { pollIntervalMs: 10 });
    } finally {
      clearInterval(poll);
    }

    assert.equal(sawPaused, true);
    assert.equal(readJob(tmpCwd, record.slug).state, 'running');
  });

  it('cancelling the request before the checkpoint runs skips the wait entirely', async () => {
    const tmpCwd = makeTmpCwd();
    // Simulates: `orch pause` set pauseRequested/pausing, then `orch resume`
    // cleared it again, all before the pipeline ever reached the checkpoint.
    const record = baseRecord({ slug: 'cancelled-before-checkpoint-0000', pauseRequested: false, state: 'running' });
    writeJob(tmpCwd, record.slug, record);

    const start = Date.now();
    await checkpointPause(tmpCwd, record.slug, { pollIntervalMs: 5000 });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `expected an immediate return, took ${elapsed}ms`);
    assert.equal(readJob(tmpCwd, record.slug).state, 'running');
  });
});

describe('requestPause / requestResume', () => {
  it('requestPause sets pauseRequested and state:"pausing" from running', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'pause-cmd-0000', state: 'running', pauseRequested: false });
    writeJob(tmpCwd, record.slug, record);

    const updated = requestPause(tmpCwd, record.slug);

    assert.equal(updated.pauseRequested, true);
    assert.equal(updated.state, 'pausing');
  });

  for (const state of ['pausing', 'paused']) {
    it(`requestPause on an already-${state} job is a no-op success`, () => {
      const tmpCwd = makeTmpCwd();
      const record = baseRecord({ slug: `pause-noop-${state}`, state, pauseRequested: true });
      writeJob(tmpCwd, record.slug, record);

      const updated = requestPause(tmpCwd, record.slug);

      assert.equal(updated.state, state);
      assert.equal(updated.pauseRequested, true);
    });
  }

  for (const state of ['done', 'failed', 'stopped', 'crashed']) {
    it(`requestPause rejects a terminal "${state}" job`, () => {
      const tmpCwd = makeTmpCwd();
      const record = baseRecord({ slug: `pause-terminal-${state}`, state, finishedAt: new Date().toISOString() });
      writeJob(tmpCwd, record.slug, record);

      assert.throws(() => requestPause(tmpCwd, record.slug));
    });
  }

  it('requestPause rejects an unknown slug', () => {
    const tmpCwd = makeTmpCwd();
    assert.throws(() => requestPause(tmpCwd, 'does-not-exist-0000'));
  });

  it('requestResume clears pauseRequested and sets state:"running" from paused', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'resume-cmd-0000', state: 'paused', pauseRequested: true });
    writeJob(tmpCwd, record.slug, record);

    const updated = requestResume(tmpCwd, record.slug);

    assert.equal(updated.pauseRequested, false);
    assert.equal(updated.state, 'running');
  });

  it('requestResume from pausing cancels the request before the checkpoint observes it', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'resume-cancels-0000', state: 'pausing', pauseRequested: true });
    writeJob(tmpCwd, record.slug, record);

    const updated = requestResume(tmpCwd, record.slug);

    assert.equal(updated.pauseRequested, false);
    assert.equal(updated.state, 'running');
  });

  it('requestResume on an already-running job is a no-op success', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'resume-noop-0000', state: 'running', pauseRequested: false });
    writeJob(tmpCwd, record.slug, record);

    const updated = requestResume(tmpCwd, record.slug);

    assert.equal(updated.state, 'running');
    assert.equal(updated.pauseRequested, false);
  });

  for (const state of ['done', 'failed', 'stopped', 'crashed']) {
    it(`requestResume rejects a terminal "${state}" job`, () => {
      const tmpCwd = makeTmpCwd();
      const record = baseRecord({ slug: `resume-terminal-${state}`, state, finishedAt: new Date().toISOString() });
      writeJob(tmpCwd, record.slug, record);

      assert.throws(() => requestResume(tmpCwd, record.slug));
    });
  }

  it('requestResume rejects an unknown slug', () => {
    const tmpCwd = makeTmpCwd();
    assert.throws(() => requestResume(tmpCwd, 'does-not-exist-0000'));
  });
});

describe('stopJob', () => {
  it('signals a live pid with SIGTERM and reports it as signaled, without itself writing "stopped"', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'stop-live-0000', state: 'running', pid: process.pid });
    writeJob(tmpCwd, record.slug, record);

    const killCalls = [];
    const result = stopJob(tmpCwd, record.slug, { kill: (pid, signal) => killCalls.push({ pid, signal }) });

    assert.deepEqual(killCalls, [{ pid: process.pid, signal: 'SIGTERM' }]);
    assert.equal(result.action, 'signaled');
    // The transition to "stopped" is the live child's own responsibility
    // (via lib/agent.js's shutdown()), asynchronously — stopJob must not
    // pre-emptively rewrite state itself.
    assert.equal(readJob(tmpCwd, record.slug).state, 'running');
  });

  it('reports a dead pid as crashed (via the same reconcile path) rather than throwing', async () => {
    const tmpCwd = makeTmpCwd();
    const pid = await deadPid();
    const record = baseRecord({ slug: 'stop-dead-0000', state: 'running', pid });
    writeJob(tmpCwd, record.slug, record);

    const killCalls = [];
    const result = stopJob(tmpCwd, record.slug, { kill: (p, s) => killCalls.push({ pid: p, signal: s }) });

    assert.equal(killCalls.length, 0);
    assert.equal(result.action, 'crashed');
    assert.equal(readJob(tmpCwd, record.slug).state, 'crashed');
  });

  it('actively rewrites a dead pid found in "pausing" or "paused" state to crashed', async () => {
    const tmpCwd = makeTmpCwd();
    for (const state of ['pausing', 'paused']) {
      const pid = await deadPid();
      const record = baseRecord({ slug: `stop-dead-${state}`, state, pid, pauseRequested: true });
      writeJob(tmpCwd, record.slug, record);

      const result = stopJob(tmpCwd, record.slug, { kill: () => {} });

      assert.equal(result.action, 'crashed');
      assert.equal(readJob(tmpCwd, record.slug).state, 'crashed');
    }
  });

  it('rejects an unknown slug', () => {
    const tmpCwd = makeTmpCwd();
    assert.throws(() => stopJob(tmpCwd, 'does-not-exist-0000', { kill: () => {} }));
  });

  it('reports an already-stopped/terminal job without signaling or reconciling', () => {
    const tmpCwd = makeTmpCwd();
    const record = baseRecord({ slug: 'stop-already-done-0000', state: 'done', pid: process.pid, exitCode: 0, finishedAt: new Date().toISOString() });
    writeJob(tmpCwd, record.slug, record);

    const killCalls = [];
    const result = stopJob(tmpCwd, record.slug, { kill: (p, s) => killCalls.push({ pid: p, signal: s }) });

    assert.deepEqual(killCalls, []);
    assert.equal(result.action, 'already-terminal');
    assert.equal(readJob(tmpCwd, record.slug).state, 'done');
  });
});

describe('cleanJobs', () => {
  it('returns an empty array when .orch does not exist', () => {
    const tmpCwd = makeTmpCwd();
    assert.deepEqual(cleanJobs(tmpCwd), []);
  });

  it('deletes every entry under .orch and returns the removed names', () => {
    const tmpCwd = makeTmpCwd();
    writeJob(tmpCwd, 'alpha-job-0001', baseRecord({ slug: 'alpha-job-0001', state: 'done', finishedAt: new Date().toISOString(), exitCode: 0 }));
    writeJob(tmpCwd, 'beta-job-0002', baseRecord({ slug: 'beta-job-0002', state: 'done', finishedAt: new Date().toISOString(), exitCode: 0 }));
    fs.mkdirSync(path.join(tmpCwd, '.orch', 'legacy-dir-0003'), { recursive: true });
    fs.writeFileSync(path.join(tmpCwd, '.orch', 'legacy-dir-0003', 'status.md'), '# Status\n');

    const removed = cleanJobs(tmpCwd).sort();

    assert.deepEqual(removed, ['alpha-job-0001', 'beta-job-0002', 'legacy-dir-0003']);
    assert.deepEqual(fs.readdirSync(path.join(tmpCwd, '.orch')), []);
    assert.equal(readJob(tmpCwd, 'alpha-job-0001'), null);
  });

  it('is a no-op success when .orch is already empty', () => {
    const tmpCwd = makeTmpCwd();
    fs.mkdirSync(path.join(tmpCwd, '.orch'), { recursive: true });
    assert.deepEqual(cleanJobs(tmpCwd), []);
  });
});

/**
 * Contract this section pins down for the net-new shared job-allocation
 * helper (`lib/job-lifecycle.js`, see task "make job records universal"):
 *
 * - `allocateJob({ cwd, prompt, agent, maxRounds, state, pid, generateSlug,
 *   createRunContext, writeJob })` generates a slug (via the injectable
 *   `generateSlug`, defaulting to `lib/slug.js`'s `generateSlug`), creates the
 *   run directory via the injectable `createRunContext` (defaulting to
 *   `lib/run-context.js`'s `createRunContext`, called as
 *   `createRunContext({ cwd, slug })`), and writes an initial `run.json` via
 *   the injectable `writeJob` (defaulting to this module's `writeJob`).
 * - It returns `{ slug, runContext, record }`: the generated slug, the
 *   `createRunContext` return value verbatim, and the exact record written to
 *   `run.json`.
 * - The written record always has `pauseRequested: false`, `branch: null`,
 *   `worktree: null`, `phase: null`, `stage: null`, `round: null`,
 *   `finishedAt: null`, `exitCode: null`, a fresh `startedAt`, and
 *   `logPath: jobPaths(cwd, slug).logPath` — this is what lets `--ask`/
 *   `--quick` records (which have no worktree/branch/rounds concept) degrade
 *   gracefully: callers simply omit `maxRounds` (defaults to `null`) rather
 *   than the helper needing ask/quick-specific branches.
 * - `state` defaults to `"starting"` (the detached-parent case, where a
 *   separate child process still has to start) but callers pass `"running"`
 *   for foreground/non-detached invocations (ask, quick, and the plain
 *   pipeline), since there is no separate process to wait on. `pid` defaults
 *   to `null` (detached parent doesn't know the child pid yet) but foreground
 *   callers pass `process.pid`.
 * - This is the one implementation `runDetached` (main.js) and the
 *   Commander action's non-detached branch both call — not two diverging
 *   inline copies of the same eager-allocate-then-writeJob logic.
 * - Fan-out phase 2 (see .spec/fanout-2-child-paths.md section 1 and
 *   .spec/fanout.md's "Child job records") extends the accepted options with
 *   optional `parent = null`, `role = null`, `workerId = null`, merged
 *   verbatim into the written record as additive keys — every existing
 *   caller (plain pipeline, `--ask`, `--quick`, `runDetached`) keeps omitting
 *   them and gets `null` for all three, so a normal job's `run.json` still
 *   reads as a normal (non-fan-out) job.
 */
describe('allocateJob (shared job-allocation helper, lib/job-lifecycle.js)', () => {
  it('generates a slug, creates the run directory, and writes an initial run.json in the given state', () => {
    const tmpCwd = makeTmpCwd();
    const { slug, runContext, record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'do something',
      agent: 'claude',
      maxRounds: 5,
      state: 'starting',
    });

    assert.match(slug, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    assert.equal(fs.existsSync(jobPaths(tmpCwd, slug).dir), true);
    assert.equal(runContext.slug, slug);

    const onDisk = readJob(tmpCwd, slug);
    assert.deepEqual(onDisk, record);
    assert.equal(onDisk.task, 'do something');
    assert.equal(onDisk.agent, 'claude');
    assert.equal(onDisk.maxRounds, 5);
    assert.equal(onDisk.state, 'starting');
    assert.equal(onDisk.pid, null);
    assert.equal(onDisk.branch, null);
    assert.equal(onDisk.worktree, null);
    assert.equal(onDisk.phase, null);
    assert.equal(onDisk.stage, null);
    assert.equal(onDisk.round, null);
    assert.equal(onDisk.finishedAt, null);
    assert.equal(onDisk.exitCode, null);
    assert.equal(onDisk.logPath, jobPaths(tmpCwd, slug).logPath);
    assert.ok(onDisk.startedAt);
  });

  it('accepts state:"running" and an explicit pid — for foreground (non-detached) runs with no separate child to wait on', () => {
    const tmpCwd = makeTmpCwd();
    const { record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'where is the CLI entrypoint?',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
    });

    assert.equal(record.state, 'running');
    assert.equal(record.pid, process.pid);
  });

  it('defaults maxRounds to null for runs with no writer/critic loop concept (--ask / --quick)', () => {
    const tmpCwd = makeTmpCwd();
    const { record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'fix the typo',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
    });

    assert.equal(record.maxRounds, null);
    assert.equal(record.branch, null);
    assert.equal(record.worktree, null);
    assert.equal(record.phase, null);
    assert.equal(record.stage, null);
    assert.equal(record.round, null);
  });

  it('calls the injected generateSlug/createRunContext/writeJob (all overridable for tests)', () => {
    const tmpCwd = makeTmpCwd();
    const generateSlugMock = mock.fn(() => 'stub-stub-1234');
    const createRunContextCalls = [];
    const createRunContextMock = mock.fn((opts) => {
      createRunContextCalls.push(opts);
      return { slug: opts.slug, artifactDir: path.join(tmpCwd, '.orch', opts.slug) };
    });
    const writeJobCalls = [];
    const writeJobMock = mock.fn((cwd, slug, record) => writeJobCalls.push({ cwd, slug, record }));

    const { slug, runContext } = allocateJob({
      cwd: tmpCwd,
      prompt: 'p',
      agent: 'claude',
      state: 'starting',
      generateSlug: generateSlugMock,
      createRunContext: createRunContextMock,
      writeJob: writeJobMock,
    });

    assert.equal(slug, 'stub-stub-1234');
    assert.equal(generateSlugMock.mock.calls.length, 1);
    assert.deepEqual(createRunContextCalls, [{ cwd: tmpCwd, slug: 'stub-stub-1234' }]);
    assert.equal(writeJobCalls.length, 1);
    assert.equal(writeJobCalls[0].cwd, tmpCwd);
    assert.equal(writeJobCalls[0].slug, 'stub-stub-1234');
    assert.equal(runContext.artifactDir, path.join(tmpCwd, '.orch', 'stub-stub-1234'));
    // Real writeJob was never called — nothing landed on disk.
    assert.equal(fs.existsSync(jobPaths(tmpCwd, 'stub-stub-1234').runJsonPath), false);
  });

  it('returns the createRunContext result verbatim as runContext', () => {
    const tmpCwd = makeTmpCwd();
    const { slug, runContext } = allocateJob({
      cwd: tmpCwd,
      prompt: 'p',
      agent: 'claude',
      state: 'starting',
    });

    assert.equal(runContext.slug, slug);
    assert.equal(runContext.artifactDir, jobPaths(tmpCwd, slug).dir);
    assert.equal(runContext.researchPath, path.join(runContext.artifactDir, 'research.md'));
    assert.equal(runContext.taskPath, path.join(runContext.artifactDir, 'task.md'));
    assert.equal(runContext.statusPath, path.join(runContext.artifactDir, 'status.md'));
  });

  it('defaults parent/role/workerId to null when omitted (existing non-fanout callers unaffected)', () => {
    const tmpCwd = makeTmpCwd();
    const { record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'do something',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
    });

    assert.equal(record.parent, null);
    assert.equal(record.role, null);
    assert.equal(record.workerId, null);

    const onDisk = readJob(tmpCwd, record.slug);
    assert.equal(onDisk.parent, null);
    assert.equal(onDisk.role, null);
    assert.equal(onDisk.workerId, null);
  });

  it('round-trips parent/role/workerId into run.json when passed (worker job)', () => {
    const tmpCwd = makeTmpCwd();
    const { slug, record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'implement invoice endpoints',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '02-invoices',
    });

    assert.equal(record.parent, 'wise-pine-e904');
    assert.equal(record.role, 'worker');
    assert.equal(record.workerId, '02-invoices');

    const onDisk = readJob(tmpCwd, slug);
    assert.equal(onDisk.parent, 'wise-pine-e904');
    assert.equal(onDisk.role, 'worker');
    assert.equal(onDisk.workerId, '02-invoices');
  });

  it('round-trips parent/role into run.json with workerId left null (integration job)', () => {
    const tmpCwd = makeTmpCwd();
    const { slug, record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'integrate worker branches',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: 'wise-pine-e904',
      role: 'integration',
    });

    assert.equal(record.parent, 'wise-pine-e904');
    assert.equal(record.role, 'integration');
    assert.equal(record.workerId, null);

    const onDisk = readJob(tmpCwd, slug);
    assert.equal(onDisk.parent, 'wise-pine-e904');
    assert.equal(onDisk.role, 'integration');
    assert.equal(onDisk.workerId, null);
  });

  it('does not disturb any other default field when parent/role/workerId are passed', () => {
    const tmpCwd = makeTmpCwd();
    const { record } = allocateJob({
      cwd: tmpCwd,
      prompt: 'do something',
      agent: 'claude',
      maxRounds: 5,
      state: 'starting',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '01-scaffold',
    });

    assert.equal(record.pauseRequested, false);
    assert.equal(record.branch, null);
    assert.equal(record.worktree, null);
    assert.equal(record.phase, null);
    assert.equal(record.stage, null);
    assert.equal(record.round, null);
    assert.equal(record.finishedAt, null);
    assert.equal(record.exitCode, null);
    assert.equal(record.maxRounds, 5);
  });
});
