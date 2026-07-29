import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  exitCodeForSignal,
  shutdown,
  trackLiveChild,
  resetShutdownState,
  setJobSlug,
} from '../lib/agent.js';
import { readJob, writeJob } from '../lib/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(path.join(__dirname, '../lib/agent.js'), 'utf8');

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('exitCodeForSignal', () => {
  it('maps SIGINT / SIGTERM / SIGHUP to conventional shell statuses', () => {
    assert.equal(exitCodeForSignal('SIGINT'), 130);
    assert.equal(exitCodeForSignal('SIGTERM'), 143);
    assert.equal(exitCodeForSignal('SIGHUP'), 129);
  });
});

describe('ora discardStdin', () => {
  it('passes discardStdin: false so Ctrl+C delivers a real SIGINT', () => {
    assert.match(agentSrc, /discardStdin:\s*false/);
  });
});

describe('shutdown reaps detached children', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  afterEach(() => {
    resetShutdownState();
  });

  for (const { signal, code } of [
    { signal: 'SIGINT', code: 130 },
    { signal: 'SIGTERM', code: 143 },
    { signal: 'SIGHUP', code: 129 },
  ]) {
    it(`kills a detached stub child and exits ${code} on ${signal}`, async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      assert.ok(child.pid, 'stub child should have a pid');
      assert.equal(pidAlive(child.pid), true);

      let exitedWith;
      const exited = new Promise((resolve) => {
        shutdown(signal, {
          exit: (exitCode) => {
            exitedWith = exitCode;
            resolve();
          },
        });
      });

      await exited;
      assert.equal(exitedWith, code);
      await waitFor(() => !pidAlive(child.pid));
      assert.equal(pidAlive(child.pid), false);
    });
  }
});

/**
 * Contract pinned down here (task.md section 3, extended by the "make job
 * records universal" task): when a job is active, shutdown() must
 * synchronously patch that job's run.json to `state: "stopped"`,
 * `exitCode: exitCodeForSignal(signal)`, and `finishedAt: <now>` — via
 * lib/jobs.js's patchJob, so it stays lock-safe against a concurrent
 * `orch pause`/`resume`/`status` write — guarded by the same `shuttingDown`
 * idempotency latch, before/while children are reaped. shutdown() accepts an
 * injectable `jobCwd` (defaulting to `process.cwd()`, matching how the real
 * detached child's cwd equals the job's `.orch/<slug>` root) so tests don't
 * need to `process.chdir()`.
 *
 * "Active job" now resolves from two sources, because job records are no
 * longer detached-only: `process.env.ORCH_JOB_SLUG` (set on the detached
 * child's own env, a separate process from its parent) OR the in-process
 * active slug set via the exported `setJobSlug(slug)` (set by main.js for a
 * foreground/non-detached invocation, which never spawns a separate process
 * to carry an env var). `process.env.ORCH_JOB_SLUG` takes precedence when
 * both are set. `resetShutdownState()` clears the in-process slug back to
 * unset, alongside its existing latch/child-set resets, so tests don't leak
 * state into each other.
 */
describe('shutdown persists job state when ORCH_JOB_SLUG is set', () => {
  function makeTmpCwd() {
    return mkdtempSync(path.join(os.tmpdir(), 'orch-shutdown-job-'));
  }

  function baseRecord(overrides = {}) {
    const now = new Date().toISOString();
    return {
      slug: 'shutdown-record-0000',
      task: 'do something',
      agent: 'claude',
      maxRounds: 5,
      cwd: '/tmp/wherever',
      pauseRequested: false,
      branch: null,
      worktree: null,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      logPath: '/tmp/wherever/.orch/shutdown-record-0000/orch.log',
      pid: process.pid,
      state: 'running',
      phase: 'code-loop',
      stage: 'code-writer',
      round: 1,
      ...overrides,
    };
  }

  let originalJobSlug;

  beforeEach(() => {
    resetShutdownState();
    originalJobSlug = process.env.ORCH_JOB_SLUG;
  });

  afterEach(() => {
    resetShutdownState();
    if (originalJobSlug === undefined) delete process.env.ORCH_JOB_SLUG;
    else process.env.ORCH_JOB_SLUG = originalJobSlug;
  });

  it('patches run.json to state:"stopped" with the signal-mapped exitCode and a finishedAt timestamp', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      const record = baseRecord();
      writeJob(tmpCwd, record.slug, record);
      process.env.ORCH_JOB_SLUG = record.slug;

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      let exitedWith;
      await new Promise((resolve) => {
        shutdown('SIGTERM', {
          exit: (exitCode) => { exitedWith = exitCode; resolve(); },
          jobCwd: tmpCwd,
        });
      });

      assert.equal(exitedWith, 143);
      const updated = readJob(tmpCwd, record.slug);
      assert.equal(updated.state, 'stopped');
      assert.equal(updated.exitCode, 143);
      assert.ok(updated.finishedAt);
      // Unrelated fields survive the patch (merge, not overwrite).
      assert.equal(updated.task, record.task);
      assert.equal(updated.phase, record.phase);

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  /**
   * lastOutcome capture on shutdown()'s "stopped" write (task.md section 1's
   * "stopped" state — this is the actual production call site for a plain,
   * non-fan-out `orch run`/`orch --worker` job's Ctrl+C/SIGTERM/SIGHUP
   * handling; the coordinator has its own separate "stopped" write, covered
   * in test/fanout-coordinator.test.js). Because shutdown() patches via
   * `patchJob`'s current-record-aware form, `lastOutcome.phase`/`stage`/
   * `round`/`task` should mirror whatever the job's own live fields already
   * were the moment shutdown() ran — here, `baseRecord()`'s
   * phase:"code-loop"/stage:"code-writer"/round:1. No caught error or loop
   * summary are available at signal time, so `summary` falls back to `''`
   * and `error` stays null/omitted — same best-effort rule as
   * `reconcileJob`'s crashed lastOutcome (test/jobs.test.js).
   */
  it('also writes a lastOutcome object on the "stopped" write, mirroring the record\'s live phase/stage/round/task', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      const record = baseRecord({ slug: 'shutdown-lastoutcome-0000' });
      writeJob(tmpCwd, record.slug, record);
      process.env.ORCH_JOB_SLUG = record.slug;

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      await new Promise((resolve) => {
        shutdown('SIGINT', {
          exit: () => resolve(),
          jobCwd: tmpCwd,
        });
      });

      const updated = readJob(tmpCwd, record.slug);
      assert.equal(updated.state, 'stopped');
      assert.ok(updated.lastOutcome, 'expected a lastOutcome object on the stopped record');
      assert.equal(updated.lastOutcome.state, 'stopped');
      assert.equal(updated.lastOutcome.exitCode, updated.exitCode);
      assert.equal(updated.lastOutcome.finishedAt, updated.finishedAt);
      assert.equal(updated.lastOutcome.task, record.task);
      assert.equal(updated.lastOutcome.phase, record.phase);
      assert.equal(updated.lastOutcome.stage, record.stage);
      assert.equal(updated.lastOutcome.round, record.round);
      assert.equal(updated.lastOutcome.summary, '');
      assert.ok(updated.lastOutcome.error == null, 'error should be omitted/null — no caught error at shutdown time');

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('overwrites a "paused" job to "stopped" on shutdown (stop while paused wakes no stage, just records stopped)', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      const record = baseRecord({ slug: 'shutdown-paused-0000', state: 'paused', pauseRequested: true });
      writeJob(tmpCwd, record.slug, record);
      process.env.ORCH_JOB_SLUG = record.slug;

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      let exitedWith;
      await new Promise((resolve) => {
        shutdown('SIGINT', {
          exit: (exitCode) => { exitedWith = exitCode; resolve(); },
          jobCwd: tmpCwd,
        });
      });

      assert.equal(exitedWith, 130);
      const updated = readJob(tmpCwd, record.slug);
      assert.equal(updated.state, 'stopped');
      assert.equal(updated.exitCode, 130);
      assert.ok(updated.finishedAt);

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('does not touch any run.json when no job is active — neither ORCH_JOB_SLUG nor the in-process slug is set', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      delete process.env.ORCH_JOB_SLUG;

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      let exitedWith;
      await new Promise((resolve) => {
        shutdown('SIGTERM', {
          exit: (exitCode) => { exitedWith = exitCode; resolve(); },
          jobCwd: tmpCwd,
        });
      });

      assert.equal(exitedWith, 143);
      // No active job means no job to patch — the `.orch` dir shouldn't even exist.
      assert.equal(existsSync(path.join(tmpCwd, '.orch')), false);

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('persists job state via the in-process active slug when ORCH_JOB_SLUG is unset — this is what makes Ctrl+C during a foreground (non-detached) run also record "stopped"', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      delete process.env.ORCH_JOB_SLUG;
      const record = baseRecord({ slug: 'shutdown-foreground-0000' });
      writeJob(tmpCwd, record.slug, record);
      setJobSlug(record.slug);

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      let exitedWith;
      await new Promise((resolve) => {
        shutdown('SIGINT', {
          exit: (exitCode) => { exitedWith = exitCode; resolve(); },
          jobCwd: tmpCwd,
        });
      });

      assert.equal(exitedWith, 130);
      const updated = readJob(tmpCwd, record.slug);
      assert.equal(updated.state, 'stopped');
      assert.equal(updated.exitCode, 130);
      assert.ok(updated.finishedAt);

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('prefers process.env.ORCH_JOB_SLUG over the in-process slug when both happen to be set', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      const envRecord = baseRecord({ slug: 'shutdown-env-wins-0000' });
      const inProcessRecord = baseRecord({ slug: 'shutdown-inprocess-loses-0000' });
      writeJob(tmpCwd, envRecord.slug, envRecord);
      writeJob(tmpCwd, inProcessRecord.slug, inProcessRecord);
      process.env.ORCH_JOB_SLUG = envRecord.slug;
      setJobSlug(inProcessRecord.slug);

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      await new Promise((resolve) => {
        shutdown('SIGTERM', { exit: () => resolve(), jobCwd: tmpCwd });
      });

      assert.equal(readJob(tmpCwd, envRecord.slug).state, 'stopped');
      assert.equal(readJob(tmpCwd, inProcessRecord.slug).state, 'running');

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('resetShutdownState() clears the in-process active slug, so a later shutdown() with no slug re-set touches nothing', async () => {
    const tmpCwd = makeTmpCwd();
    try {
      delete process.env.ORCH_JOB_SLUG;
      const record = baseRecord({ slug: 'shutdown-cleared-0000' });
      writeJob(tmpCwd, record.slug, record);
      setJobSlug(record.slug);

      resetShutdownState();

      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      trackLiveChild(child);

      await new Promise((resolve) => {
        shutdown('SIGTERM', { exit: () => resolve(), jobCwd: tmpCwd });
      });

      assert.equal(readJob(tmpCwd, record.slug).state, 'running');

      await waitFor(() => !pidAlive(child.pid));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
