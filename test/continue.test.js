import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJob, readJob, requestResume } from '../lib/jobs.js';
import { formatStatus } from '../main.js';
import {
  validateContinue,
  snapshotPriorOutcome,
  buildPriorOutcomeText,
} from '../lib/continue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

/**
 * Contract this file pins down for `orch continue` per `.spec/continue.md`
 * (decisions 1–18, "Eligibility and validation", "Job record", and
 * "Prior-outcome injection") and `.orch/sunny-oasis-a761/task.md` sections
 * 2, 4, 5, 8. None of `lib/continue.js`, the `orch continue` Commander
 * subcommand, or `formatStatus`'s `lastOutcome` block exist yet as of this
 * test-writing round — this describes the contract the next implementation
 * round must satisfy.
 *
 * ## lib/continue.js
 *
 * - `validateContinue(cwd, slug, { task, ask, quick })` — the pure
 *   eligibility check behind `orch continue`, mirroring the shape of
 *   `requestPause`/`requestResume`/`stopJob` in lib/jobs.js: reads + (via
 *   `reconcileJob`) reconciles the record, then throws a plain `Error` (no
 *   "Error: " prefix — the CLI action adds that, exactly like `pause`/
 *   `resume`/`stop`'s existing `console.error(`Error: ${err.message}`)`
 *   wrapping) whose `.message` is one of the exact strings below, or
 *   returns the reconciled record on success. Never mutates `run.json`.
 *   Check order (first failure wins):
 *     1. unknown slug            -> `unknown run <slug>`
 *     2. `--ask` passed          -> mentions `--ask`
 *     3. `--quick` passed        -> mentions `--quick`
 *     4. empty/whitespace task   -> `task cannot be empty`
 *     5. non-terminal state      -> `cannot continue <slug> while state is
 *                                    <state>; use orch resume / orch stop`
 *     6. role: coordinator       -> `cannot continue coordinator <slug>;
 *                                    continue each failed worker slug, then
 *                                    orch --integrate <slug>`
 *     7. role: integration       -> `cannot continue integration <slug>;
 *                                    use orch --integrate <parent-slug>`
 *                                    (parent-slug = record.parent)
 *     8. missing worktree/branch -> `<slug> has no worktree; continue only
 *                                    applies to complex runs` (this is also
 *                                    what a skipped/never-started worker
 *                                    hits, since it never got a worktree)
 *     9. worktree dir missing on disk -> `worktree missing at <path>;
 *                                    cannot continue <slug>`
 *   `role` missing/null and `role: "worker"` are otherwise treated the same
 *   as an ordinary complex slug.
 *
 * - `snapshotPriorOutcome(cwd, slug, record)` — returns `record.lastOutcome`
 *   verbatim when present; otherwise synthesizes a fallback object with
 *   `state`/`phase`/`stage`/`round`/`exitCode`/`finishedAt`/`task` copied
 *   from `record` and a best-effort `summary` (empty string when nothing
 *   can be recovered, e.g. no status.md). Never throws.
 *
 * - `buildPriorOutcomeText(prior, { slug, continuation, worktreePath,
 *   branch, parentSlug, workerId })` — pure string builder for the
 *   `[Prior run outcome]`...`[/Prior run outcome]` block injected into
 *   research/planner prompts (spec "Prior-outcome injection"). Includes
 *   `- Fan-out parent:` / `- Worker id:` lines only when `parentSlug` /
 *   `workerId` are given (worker continues).
 *
 * ## `orch continue <slug> <task...>` CLI
 *
 * - Options: `-v/--verbose`, `--agent`, `--max-rounds`, `--detach`,
 *   `--dry-run`; `--ask`/`--quick` are accepted (so a clear custom error
 *   prints) but always rejected.
 * - `--dry-run` on an eligible slug: exit 0, prints something, and leaves
 *   `run.json` completely unchanged (no `state: "running"`, no
 *   `continuation` bump).
 * - Any eligibility failure: non-zero exit, message on stderr, `run.json`
 *   unchanged.
 *
 * ## `formatStatus` lastOutcome block
 *
 * - When `record.lastOutcome` is truthy, `formatStatus` prints a block with
 *   the outcome's phase/stage/round/summary/error (guarded the same way as
 *   the existing `parent:` line) — silent when absent, matching every
 *   pre-existing terminal record that predates this feature.
 * - When `record.continuation > 1`, prints `continuation: N` (spec "Job
 *   record" / task §2). Silent when absent or `1` (original run).
 *
 * ## `orch resume` never starts a continue (decision 2 / Testing section:
 * "`orch resume` still does not start a continue")
 *
 * `requestResume`/`orch resume` are untouched by this feature: resume only
 * ever unpauses a live `paused`/`pausing` job (existing behavior, see
 * `test/jobs.test.js`'s pre-existing `requestResume` coverage). It must
 * never reopen a terminal job, bump `continuation`/`continuations[]`, or
 * spawn a `runContinuePipeline`. The describe block below re-asserts this
 * specifically in continue's presence (byte-for-byte `run.json` equality
 * before/after a refused resume) so a future change that makes `resume`
 * "helpfully" fall through to continue on a terminal slug — collapsing the
 * two verbs decision 2 explicitly keeps separate — gets caught here.
 */

function makeTmpCwd(prefix = 'orch-continue-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function baseRecord(overrides = {}) {
  const slug = overrides.slug ?? 'stub-stub-0000';
  const now = overrides.startedAt ?? new Date().toISOString();
  return {
    slug,
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
    logPath: `/tmp/wherever/.orch/${slug}/orch.log`,
    pid: process.pid,
    state: 'running',
    phase: null,
    stage: null,
    round: null,
    parent: null,
    role: null,
    workerId: null,
    ...overrides,
  };
}

/** Seeds a terminal, worktree-backed record whose worktree dir really
 * exists on disk (the common "eligible" shape). */
function seedEligibleJob(cwd, overrides = {}) {
  const slug = overrides.slug ?? 'quirky-oasis-906b';
  // Only fabricate + create a default worktree dir when the caller didn't
  // explicitly pass one (including `null`/a deliberately-missing path) —
  // tests that need "no worktree" or "worktree missing on disk" supply
  // their own `worktree` value and must not have a directory created for it.
  const worktreeSpecified = Object.prototype.hasOwnProperty.call(overrides, 'worktree');
  const worktreePath = worktreeSpecified
    ? overrides.worktree
    : path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
  if (!worktreeSpecified) {
    fs.mkdirSync(worktreePath, { recursive: true });
  }
  const record = baseRecord({
    slug,
    state: 'failed',
    phase: 'code-loop',
    stage: 'test-runner',
    round: 3,
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    branch: `orch/${slug}`,
    worktree: worktreePath,
    lastOutcome: {
      state: 'failed',
      phase: 'code-loop',
      stage: 'test-runner',
      round: 3,
      exitCode: 1,
      finishedAt: new Date().toISOString(),
      task: 'do the thing',
      summary: 'tests failed on round 3',
      error: 'test-runner failed; stopping before commit',
    },
    ...overrides,
  });
  writeJob(cwd, slug, record);
  return { slug, worktreePath, record };
}

describe('validateContinue — eligibility gate', () => {
  it('throws "unknown run <slug>" for a slug with no run.json', () => {
    const cwd = makeTmpCwd();
    assert.throws(
      () => validateContinue(cwd, 'nobody-here-0000', { task: 'do it' }),
      /^unknown run nobody-here-0000$/,
    );
  });

  it('rejects --ask', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd);
    assert.throws(() => validateContinue(cwd, slug, { task: 'x', ask: true }), /--ask/);
  });

  it('rejects --quick', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd);
    assert.throws(() => validateContinue(cwd, slug, { task: 'x', quick: true }), /--quick/);
  });

  it('rejects an empty (or whitespace-only) task', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd);
    assert.throws(() => validateContinue(cwd, slug, { task: '' }), /task cannot be empty/);
    assert.throws(() => validateContinue(cwd, slug, { task: '   ' }), /task cannot be empty/);
  });

  for (const state of ['running', 'pausing', 'paused']) {
    it(`refuses a non-terminal state (${state}) with a resume/stop hint`, () => {
      const cwd = makeTmpCwd();
      const { slug } = seedEligibleJob(cwd, { state, lastOutcome: null, finishedAt: null, exitCode: null });
      assert.throws(
        () => validateContinue(cwd, slug, { task: 'keep going' }),
        new RegExp(`cannot continue ${slug} while state is ${state}; use orch resume / orch stop`),
      );
    });
  }

  for (const state of ['done', 'failed', 'stopped', 'crashed']) {
    it(`accepts terminal state "${state}" with a worktree present on disk`, () => {
      const cwd = makeTmpCwd();
      const { slug, record } = seedEligibleJob(cwd, { state });
      const result = validateContinue(cwd, slug, { task: 'keep going' });
      assert.equal(result.slug, slug);
      assert.equal(result.state, state);
      // Read-only: nothing mutated by validation.
      assert.deepEqual(readJob(cwd, slug), record);
    });
  }

  it('refuses when record.worktree/record.branch are unset (e.g. --ask or triage->quick-fix runs)', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, { worktree: null, branch: null });
    assert.throws(
      () => validateContinue(cwd, slug, { task: 'keep going' }),
      new RegExp(`${slug} has no worktree; continue only applies to complex runs`),
    );
  });

  it('refuses when the worktree directory no longer exists on disk, without recreating it', () => {
    const cwd = makeTmpCwd();
    const missingPath = path.join(os.tmpdir(), 'orch-continue-missing-worktree-does-not-exist');
    const { slug } = seedEligibleJob(cwd, { worktree: missingPath });
    assert.throws(
      () => validateContinue(cwd, slug, { task: 'keep going' }),
      new RegExp(`worktree missing at ${missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; cannot continue ${slug}`),
    );
    assert.equal(fs.existsSync(missingPath), false);
  });

  it('refuses role:"coordinator" pointing at worker-continue + --integrate', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, { role: 'coordinator' });
    assert.throws(
      () => validateContinue(cwd, slug, { task: 'keep going' }),
      new RegExp(`cannot continue coordinator ${slug}; continue each failed worker slug, then orch --integrate ${slug}`),
    );
  });

  it('refuses role:"integration" pointing at --integrate <parent>', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, { role: 'integration', parent: 'wise-pine-e904' });
    assert.throws(
      () => validateContinue(cwd, slug, { task: 'keep going' }),
      /cannot continue integration .*; use orch --integrate wise-pine-e904/,
    );
  });

  it('accepts role:"worker" the same as an ordinary complex slug', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, { role: 'worker', parent: 'wise-pine-e904', workerId: '02-invoices' });
    const result = validateContinue(cwd, slug, { task: 'fix the failing invoice tests' });
    assert.equal(result.role, 'worker');
  });

  it('treats a worker that never got a worktree (e.g. its parent skipped it) as the no-worktree case', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, {
      role: 'worker',
      parent: 'wise-pine-e904',
      workerId: '03-skipped',
      worktree: null,
      branch: null,
      state: 'crashed',
    });
    assert.throws(
      () => validateContinue(cwd, slug, { task: 'do it anyway' }),
      new RegExp(`${slug} has no worktree; continue only applies to complex runs`),
    );
  });

  it('reconciles a dead-pid "running" record to crashed first, then treats it as eligible', async () => {
    const cwd = makeTmpCwd();
    const { spawn: nodeSpawn } = await import('node:child_process');
    const child = nodeSpawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid;
    await new Promise((resolve) => child.on('close', resolve));

    const { slug } = seedEligibleJob(cwd, { state: 'running', pid: deadPid, finishedAt: null, exitCode: null, lastOutcome: null });
    const result = validateContinue(cwd, slug, { task: 'keep going' });
    assert.equal(result.state, 'crashed');
    assert.equal(readJob(cwd, slug).state, 'crashed');
  });
});

describe('snapshotPriorOutcome', () => {
  it('returns record.lastOutcome verbatim when present', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedEligibleJob(cwd);
    const prior = snapshotPriorOutcome(cwd, slug, record);
    assert.deepEqual(prior, record.lastOutcome);
  });

  it('synthesizes a fallback from terminal fields for a legacy record with no lastOutcome', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedEligibleJob(cwd, { lastOutcome: null });
    const prior = snapshotPriorOutcome(cwd, slug, record);

    assert.equal(prior.state, record.state);
    assert.equal(prior.phase, record.phase);
    assert.equal(prior.stage, record.stage);
    assert.equal(prior.round, record.round);
    assert.equal(prior.exitCode, record.exitCode);
    assert.equal(prior.finishedAt, record.finishedAt);
    assert.equal(prior.task, record.task);
    assert.equal(typeof prior.summary, 'string');
  });

  it('does not throw and yields an empty-string summary when there is no status.md to scrape', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedEligibleJob(cwd, { lastOutcome: null });
    // No status.md written for this slug at all.
    const prior = snapshotPriorOutcome(cwd, slug, record);
    assert.equal(prior.summary, '');
  });

  it('still emits a usable snapshot when the prior terminal state was "done" (not failure-only)', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedEligibleJob(cwd, {
      state: 'done',
      exitCode: 0,
      lastOutcome: {
        state: 'done',
        phase: 'commit',
        stage: 'commit',
        round: null,
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        task: 'do the thing',
        summary: 'suite green',
        error: null,
      },
    });
    const prior = snapshotPriorOutcome(cwd, slug, record);
    assert.equal(prior.state, 'done');
    assert.equal(prior.error, null);
  });
});

describe('buildPriorOutcomeText', () => {
  const prior = {
    state: 'failed',
    phase: 'code-loop',
    stage: 'test-runner',
    round: 3,
    task: 'do the thing',
    summary: 'tests failed on round 3',
    error: 'test-runner failed; stopping before commit',
  };

  it('wraps the block in [Prior run outcome] / [/Prior run outcome] markers', () => {
    const text = buildPriorOutcomeText(prior, {
      slug: 'quirky-oasis-906b',
      continuation: 2,
      worktreePath: '/tmp/orch-quirky-oasis-906b',
      branch: 'orch/quirky-oasis-906b',
    });
    assert.match(text, /^\[Prior run outcome\]/);
    assert.match(text, /\[\/Prior run outcome\]\s*$/);
  });

  it('includes prior state/phase/stage/round/task/summary/error and the worktree path', () => {
    const text = buildPriorOutcomeText(prior, {
      slug: 'quirky-oasis-906b',
      continuation: 2,
      worktreePath: '/tmp/orch-quirky-oasis-906b',
      branch: 'orch/quirky-oasis-906b',
    });
    assert.match(text, /Prior state: failed/);
    assert.match(text, /Prior phase: code-loop/);
    assert.match(text, /Prior stage: test-runner/);
    assert.match(text, /Prior round: 3/);
    assert.match(text, /Prior task: do the thing/);
    assert.match(text, /Summary: tests failed on round 3/);
    assert.match(text, /Error: test-runner failed; stopping before commit/);
    assert.match(text, /\/tmp\/orch-quirky-oasis-906b/);
    assert.match(text, /orch\/quirky-oasis-906b/);
  });

  it('renders "(none recorded)" for missing summary/error rather than "undefined" or "null"', () => {
    const text = buildPriorOutcomeText(
      { state: 'done', phase: 'commit', stage: 'commit', round: null, task: 'do the thing', summary: '', error: null },
      { slug: 'quirky-oasis-906b', continuation: 2, worktreePath: '/tmp/wt', branch: 'orch/quirky-oasis-906b' },
    );
    assert.match(text, /Summary: \(none recorded\)/);
    assert.match(text, /Error: \(none recorded\)/);
    assert.equal(text.includes('undefined'), false);
  });

  it('includes Fan-out parent / Worker id lines only when parentSlug/workerId are given', () => {
    const withoutWorker = buildPriorOutcomeText(prior, {
      slug: 'quirky-oasis-906b', continuation: 2, worktreePath: '/tmp/wt', branch: 'orch/quirky-oasis-906b',
    });
    assert.equal(withoutWorker.includes('Fan-out parent:'), false);
    assert.equal(withoutWorker.includes('Worker id:'), false);

    const withWorker = buildPriorOutcomeText(prior, {
      slug: 'merry-elk-r4b1',
      continuation: 2,
      worktreePath: '/tmp/wt',
      branch: 'orch/merry-elk-r4b1',
      parentSlug: 'wise-pine-e904',
      workerId: '02-invoices',
    });
    assert.match(withWorker, /Fan-out parent: wise-pine-e904/);
    assert.match(withWorker, /Worker id: 02-invoices/);
  });
});

describe('orch continue — CLI eligibility wiring', () => {
  it('exits non-zero with "unknown run" for an unknown slug', async () => {
    const cwd = makeTmpCwd();
    const { code, stderr } = await runCli(['continue', 'nobody-here-0000', 'do it'], { cwd });
    assert.notEqual(code, 0);
    assert.match(stderr, /Error: unknown run nobody-here-0000/);
  });

  it('refuses a "running" job, pointing at resume/stop', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd, { state: 'running', pid: process.pid, lastOutcome: null, finishedAt: null, exitCode: null });
    const { code, stderr } = await runCli(['continue', slug, 'keep going'], { cwd });
    assert.notEqual(code, 0);
    assert.match(stderr, /use orch resume \/ orch stop/);
  });

  it('rejects --ask and --quick with a clear error', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleJob(cwd);
    const askResult = await runCli(['continue', slug, 'keep going', '--ask'], { cwd });
    assert.notEqual(askResult.code, 0);
    assert.match(askResult.stderr, /--ask/);

    const quickResult = await runCli(['continue', slug, 'keep going', '--quick'], { cwd });
    assert.notEqual(quickResult.code, 0);
    assert.match(quickResult.stderr, /--quick/);
  });

  it('--dry-run on an eligible slug exits 0 and leaves run.json completely unchanged', async () => {
    const cwd = makeTmpCwd();
    const { slug, record: before } = seedEligibleJob(cwd);
    const { code } = await runCli(['continue', slug, 'keep going', '--dry-run', '--agent', 'claude'], { cwd });
    assert.equal(code, 0);
    assert.deepEqual(readJob(cwd, slug), before);
  });

  it('refuses role:"coordinator" and role:"integration" via the CLI with role-specific hints', async () => {
    const cwd = makeTmpCwd();
    const { slug: coordSlug } = seedEligibleJob(cwd, { slug: 'wise-pine-e904', role: 'coordinator' });
    const coordResult = await runCli(['continue', coordSlug, 'keep going'], { cwd });
    assert.notEqual(coordResult.code, 0);
    assert.match(coordResult.stderr, /orch --integrate wise-pine-e904/);

    const { slug: integSlug } = seedEligibleJob(cwd, { slug: 'tidy-heron-m2p9', role: 'integration', parent: 'wise-pine-e904' });
    const integResult = await runCli(['continue', integSlug, 'keep going'], { cwd });
    assert.notEqual(integResult.code, 0);
    assert.match(integResult.stderr, /orch --integrate wise-pine-e904/);
  });

  it('--help distinguishes "orch resume" from "orch continue"', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /orch continue/);
  });
});

describe('formatStatus — lastOutcome block', () => {
  it('is silent when record.lastOutcome is absent (every pre-existing terminal record)', () => {
    const cwd = makeTmpCwd();
    const record = baseRecord({ slug: 'no-outcome-0000', state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
    writeJob(cwd, record.slug, record);
    const out = formatStatus(cwd, record);
    assert.equal(out.toLowerCase().includes('lastoutcome'), false);
  });

  it('prints phase/stage/round/summary/error when record.lastOutcome is present', () => {
    const cwd = makeTmpCwd();
    const record = baseRecord({
      slug: 'has-outcome-0000',
      state: 'failed',
      exitCode: 1,
      finishedAt: new Date().toISOString(),
      lastOutcome: {
        state: 'failed',
        phase: 'code-loop',
        stage: 'test-runner',
        round: 3,
        exitCode: 1,
        finishedAt: new Date().toISOString(),
        task: 'do the thing',
        summary: 'tests failed on round 3',
        error: 'test-runner failed; stopping before commit',
      },
    });
    writeJob(cwd, record.slug, record);
    const out = formatStatus(cwd, record);

    assert.match(out, /code-loop/);
    assert.match(out, /test-runner/);
    assert.match(out, /\b3\b/);
    assert.match(out, /tests failed on round 3/);
    assert.match(out, /test-runner failed; stopping before commit/);
  });

  it('prints "continuation: N" when record.continuation > 1, and stays silent for absent/1', () => {
    const cwd = makeTmpCwd();

    const original = baseRecord({
      slug: 'continuation-absent-0000',
      state: 'done',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    writeJob(cwd, original.slug, original);
    assert.equal(formatStatus(cwd, original).includes('continuation:'), false);

    const first = baseRecord({
      slug: 'continuation-one-0000',
      state: 'done',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      continuation: 1,
    });
    writeJob(cwd, first.slug, first);
    assert.equal(formatStatus(cwd, first).includes('continuation:'), false);

    const continued = baseRecord({
      slug: 'continuation-two-0000',
      state: 'failed',
      exitCode: 1,
      finishedAt: new Date().toISOString(),
      continuation: 2,
      lastOutcome: {
        state: 'failed',
        phase: 'code-loop',
        stage: 'test-runner',
        round: 1,
        exitCode: 1,
        finishedAt: new Date().toISOString(),
        task: 'do the thing',
        summary: 'still failing',
        error: 'boom',
      },
    });
    writeJob(cwd, continued.slug, continued);
    assert.match(formatStatus(cwd, continued), /continuation:\s*2/);

    const third = { ...continued, slug: 'continuation-three-0000', continuation: 3 };
    writeJob(cwd, third.slug, third);
    assert.match(formatStatus(cwd, third), /continuation:\s*3/);
  });
});

describe('orch resume — never starts a continue', () => {
  for (const state of ['done', 'failed', 'stopped', 'crashed']) {
    it(`requestResume still rejects a terminal "${state}" job and leaves run.json byte-for-byte unchanged (no reopen, no continuation bump)`, () => {
      const cwd = makeTmpCwd();
      const { slug, record: before } = seedEligibleJob(cwd, { state });
      assert.throws(() => requestResume(cwd, slug), /terminal state/);
      assert.deepEqual(readJob(cwd, slug), before);
      assert.equal(readJob(cwd, slug).continuation, undefined);
    });

    it(`CLI: "orch resume" on a terminal "${state}" job exits non-zero and does not reopen/continue it`, async () => {
      const cwd = makeTmpCwd();
      const { slug, record: before } = seedEligibleJob(cwd, { state });
      const { code, stderr } = await runCli(['resume', slug], { cwd });
      assert.notEqual(code, 0);
      assert.match(stderr, /terminal state/);
      assert.deepEqual(readJob(cwd, slug), before, 'a refused resume must not touch run.json at all, let alone reopen it');
    });
  }

  it('CLI: resuming a genuinely paused job still works exactly as before, and never touches continuation/continuations', async () => {
    const cwd = makeTmpCwd();
    const slug = 'paused-before-continue-existed-0000';
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    writeJob(cwd, slug, baseRecord({
      slug,
      state: 'paused',
      pauseRequested: true,
      branch: `orch/${slug}`,
      worktree: worktreePath,
    }));

    const { code, stdout } = await runCli(['resume', slug], { cwd });
    assert.equal(code, 0);
    assert.match(stdout, /resumed/);

    const record = readJob(cwd, slug);
    assert.equal(record.state, 'running');
    assert.equal(record.pauseRequested, false);
    // Resume is a pure unpause: it must never introduce continue's bookkeeping.
    assert.equal(record.continuation, undefined);
    assert.equal(record.continuations, undefined);
    assert.equal(record.phase, null);
    assert.equal(record.lastOutcome, undefined);
  });
});
