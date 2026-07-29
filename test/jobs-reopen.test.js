import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJob, readJob, reopenJob } from '../lib/jobs.js';

/**
 * Contract this file pins down for `reopenJob` (net-new export of
 * lib/jobs.js, see `.spec/continue.md` decision 12 / "Continue reopen" and
 * `.orch/sunny-oasis-a761/task.md` section 3). `reopenJob` does not exist
 * yet as of this test-writing round — this describes the contract the next
 * implementation round must satisfy. Kept in its own file (rather than
 * appended to test/jobs.test.js) so this net-new, not-yet-implemented export
 * doesn't fail every pre-existing, already-passing test in that file at
 * module-load time.
 *
 * `reopenJob(cwd, slug, { task, agent, maxRounds, pid, prior, startedAt })`:
 * - Distinct from `allocateJob`'s create-path: it patches an *existing*
 *   record in place rather than allocating a new slug/directory.
 * - `prior` is the already-computed prior-outcome snapshot (from
 *   `lib/continue.js`'s `snapshotPriorOutcome`, covering both the
 *   `record.lastOutcome`-present case and the legacy-fallback case) — the
 *   caller computes it; `reopenJob` itself does no fallback synthesis.
 * - Throws `reopenJob: unknown job <slug>` when there is no existing
 *   `run.json` for `slug` (mirrors `requestPause`/`stopJob`'s unknown-job
 *   errors) — it does not create a new record.
 * - Patches (via the same lock + atomic-write `patchJob` primitive):
 *   `task`, `state: 'running'`, `phase: 'research'`, `stage: null`,
 *   `round: null`, `pid`, `startedAt`, `finishedAt: null`, `exitCode: null`,
 *   `pauseRequested: false`, `agent`, `maxRounds`, `lastOutcome: null`.
 * - `continuation`: absent/`1` on the pre-reopen record becomes `2`; a
 *   record already at `continuation: 2` becomes `3`, etc.
 * - `continuations`: append-only. Pushes `{ n: continuation, task,
 *   startedAt, prior }` onto whatever was already there (`[]` if absent).
 *   Prior entries are never rewritten.
 * - Leaves `slug`, `worktree`, `branch`, and `cwd` untouched.
 * - Returns the updated record (same return contract as `patchJob`).
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-jobs-reopen-'));
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

function terminalRecord(overrides = {}) {
  const slug = overrides.slug ?? 'reopen-stub-0000';
  return baseRecord({
    slug,
    state: 'failed',
    phase: 'code-loop',
    stage: 'test-runner',
    round: 3,
    finishedAt: '2026-07-27T10:00:00.000Z',
    exitCode: 1,
    branch: `orch/${slug}`,
    worktree: `/tmp/wherever-${slug}`,
    pauseRequested: false,
    lastOutcome: {
      state: 'failed',
      phase: 'code-loop',
      stage: 'test-runner',
      round: 3,
      exitCode: 1,
      finishedAt: '2026-07-27T10:00:00.000Z',
      task: 'do the thing',
      summary: 'tests failed',
      error: 'test-runner failed; stopping before commit',
    },
    ...overrides,
  });
}

describe('reopenJob', () => {
  it('throws on an unknown slug rather than creating a new record', () => {
    const tmpCwd = makeTmpCwd();
    assert.throws(
      () => reopenJob(tmpCwd, 'nobody-here-0000', { task: 'new task', agent: 'claude', maxRounds: 5, pid: process.pid, prior: null }),
      /reopenJob: unknown job nobody-here-0000/,
    );
    assert.equal(readJob(tmpCwd, 'nobody-here-0000'), null);
  });

  it('reopens a terminal record to running/research with live fields cleared and continuation bumped to 2', () => {
    const tmpCwd = makeTmpCwd();
    const record = terminalRecord();
    writeJob(tmpCwd, record.slug, record);

    const startedAt = '2026-07-27T11:00:00.000Z';
    const updated = reopenJob(tmpCwd, record.slug, {
      task: 'fix the failure and finish',
      agent: 'claude',
      maxRounds: 5,
      pid: 99999,
      prior: record.lastOutcome,
      startedAt,
    });

    assert.equal(updated.task, 'fix the failure and finish');
    assert.equal(updated.state, 'running');
    assert.equal(updated.phase, 'research');
    assert.equal(updated.stage, null);
    assert.equal(updated.round, null);
    assert.equal(updated.pid, 99999);
    assert.equal(updated.startedAt, startedAt);
    assert.equal(updated.finishedAt, null);
    assert.equal(updated.exitCode, null);
    assert.equal(updated.pauseRequested, false);
    assert.equal(updated.agent, 'claude');
    assert.equal(updated.maxRounds, 5);
    assert.equal(updated.lastOutcome, null);
    assert.equal(updated.continuation, 2);

    // Unchanged identity fields.
    assert.equal(updated.slug, record.slug);
    assert.equal(updated.branch, record.branch);
    assert.equal(updated.worktree, record.worktree);

    const onDisk = readJob(tmpCwd, record.slug);
    assert.equal(onDisk.state, 'running');
    assert.equal(onDisk.continuation, 2);
  });

  it('treats a record with no continuation field as continuation:1, so the first reopen produces continuation:2', () => {
    const tmpCwd = makeTmpCwd();
    const record = terminalRecord({ slug: 'reopen-nocontinuation-0000' });
    assert.equal(record.continuation, undefined);
    writeJob(tmpCwd, record.slug, record);

    const updated = reopenJob(tmpCwd, record.slug, {
      task: 'follow-up',
      agent: 'claude',
      maxRounds: 5,
      pid: process.pid,
      prior: record.lastOutcome,
    });

    assert.equal(updated.continuation, 2);
  });

  it('increments continuation again on a second reopen (2 -> 3)', () => {
    const tmpCwd = makeTmpCwd();
    const record = terminalRecord({
      slug: 'reopen-twice-0000',
      continuation: 2,
      continuations: [
        { n: 2, task: 'first follow-up', startedAt: '2026-07-27T11:00:00.000Z', prior: { state: 'failed' } },
      ],
    });
    writeJob(tmpCwd, record.slug, record);

    const updated = reopenJob(tmpCwd, record.slug, {
      task: 'second follow-up',
      agent: 'claude',
      maxRounds: 5,
      pid: process.pid,
      prior: record.lastOutcome,
      startedAt: '2026-07-27T12:00:00.000Z',
    });

    assert.equal(updated.continuation, 3);
    assert.equal(updated.continuations.length, 2);
    assert.deepEqual(updated.continuations[0], record.continuations[0]);
    assert.equal(updated.continuations[1].n, 3);
    assert.equal(updated.continuations[1].task, 'second follow-up');
  });

  it('appends a continuations[] entry carrying the given prior snapshot, without disturbing earlier entries', () => {
    const tmpCwd = makeTmpCwd();
    const record = terminalRecord();
    writeJob(tmpCwd, record.slug, record);
    const prior = record.lastOutcome;

    const startedAt = '2026-07-27T11:00:00.000Z';
    const updated = reopenJob(tmpCwd, record.slug, {
      task: 'fix the failure and finish',
      agent: 'claude',
      maxRounds: 5,
      pid: process.pid,
      prior,
      startedAt,
    });

    assert.equal(updated.continuations.length, 1);
    assert.deepEqual(updated.continuations[0], {
      n: 2,
      task: 'fix the failure and finish',
      startedAt,
      prior,
    });
  });

  it('accepts a null prior (e.g. a caller that could not synthesize one) without throwing', () => {
    const tmpCwd = makeTmpCwd();
    const record = terminalRecord({ slug: 'reopen-nullprior-0000', lastOutcome: null });
    writeJob(tmpCwd, record.slug, record);

    const updated = reopenJob(tmpCwd, record.slug, {
      task: 'follow-up',
      agent: 'claude',
      maxRounds: 5,
      pid: process.pid,
      prior: null,
    });

    assert.equal(updated.continuations[0].prior, null);
  });
});
