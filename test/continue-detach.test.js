import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContinueDetached } from '../main.js';
import { readJob, writeJob, listJobs, jobPaths } from '../lib/jobs.js';

/**
 * Contract this file pins down for `orch continue <slug> <task...> --detach`
 * (`.spec/continue.md` decision 9 / CLI table `--detach` row / Testing
 * section "Jobs / headless": "`--detach` continue is listable/statusable
 * under the same slug; `orch logs` follows the continue"). Round 1 of this
 * task covered foreground continue and the eligibility/pipeline contracts
 * (`lib/continue.js`, `runContinuePipeline`) but left the detach lifecycle
 * completely uncovered; this file closes that gap the same way
 * `test/headless.test.js`'s `runDetached` block covers the plain command's
 * detach-parent path — see that file's header comment for the sibling
 * contract this one deliberately mirrors.
 *
 * `runContinueDetached(slug, prompt, options)` — net-new `main.js` export,
 * the detach-PARENT path for `orch continue`. Does not exist yet as of this
 * round; this describes the contract the next implementation round must
 * satisfy. Unlike `runDetached` (which allocates a brand-new slug via
 * `allocateJob`), this reopens the *existing* `slug` in place — no new
 * `.orch/<slug>/` directory, no new branch/worktree.
 *
 * `options`: `agent`, `maxRounds` (default 5), `verbose`, `cwd` (default
 * `process.cwd()`), `spawn` (default `node:child_process`'s `spawn`), `exit`
 * (default `process.exit`), plus injectable `validateContinue`, `reopenJob`,
 * `snapshotPriorOutcome` (default the real `lib/continue.js`/`lib/jobs.js`
 * implementations) so no real git/agent process is needed in tests.
 *
 * Behavior:
 * - Runs the same eligibility gate as foreground continue
 *   (`validateContinue(cwd, slug, { task: prompt })`): an ineligible slug
 *   (unknown, non-terminal state, no worktree, missing worktree dir, role
 *   refusal, empty task) prints `Error: <message>` to stderr, calls
 *   `exit(1)`, spawns no child, and leaves `run.json` completely untouched —
 *   the failure must be visible synchronously to the invoking terminal, not
 *   discoverable only later via a background log.
 * - Checks the agent backend is on PATH before spawning (same as
 *   `runDetached`); missing binary -> `binaryMissingHint` on stderr, `exit(1)`,
 *   no spawn, no mutation.
 * - Reuses the *existing* `orch.log` at `jobPaths(cwd, slug).logPath`,
 *   opened in **append** mode (`fs.openSync(logPath, 'a')`) — prior
 *   iterations' log content is preserved, never truncated.
 * - Spawns a re-invocation of the CLI as
 *   `[__filename, 'continue', slug, prompt, '--agent', agent, '--max-rounds', String(maxRounds)]`
 *   (`--detach` stripped, exactly like `runDetached`'s existing re-invocation
 *   convention), `detached: true`, stdio wired to the reused log fd, and
 *   `env.ORCH_JOB_SLUG`/`env.ORCH_DETACHED` set so the re-invoked `continue`
 *   Commander action recognizes it is the already-reopened detached child
 *   and does not reopen (bump `continuation`) a second time. The
 *   "Commander continue — ORCH_JOB_SLUG already set" describe below pins
 *   that child-side skip with a real CLI subprocess (spawn-env alone is
 *   not enough: an action that always reopens would still set the env).
 * - Reopens the job itself, in the parent, via
 *   `reopenJob(cwd, slug, { task: prompt, agent, maxRounds, pid: child.pid, prior })`
 *   — `prior` from `snapshotPriorOutcome(cwd, slug, record)` — so the bumped
 *   `continuation`, reset `phase`/`stage`/`round`, `state: 'running'`, and
 *   the real child pid are all visible in `run.json` synchronously, before
 *   `runContinueDetached` returns. This is why the job is immediately
 *   listable/statusable: no race with the detached child actually starting.
 * - Prints `started <slug> (pid <pid>, continuation <n>)` and calls `exit(0)`.
 * - Never constructs an `AgentClass` or runs any pipeline stage itself —
 *   identical division of responsibility to `runDetached`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix = 'orch-continue-detach-') {
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

/** A fake spawn() result: enough surface for runContinueDetached to read
 * `.pid` and call `.unref()`, without starting a real process. */
function fakeSpawn(pid) {
  return mock.fn(() => ({ pid, unref: () => {} }));
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

/** Seeds a terminal, worktree-backed record eligible for continue, with a
 * real directory on disk at `worktree` (mirrors test/continue.test.js's
 * `seedEligibleJob`, duplicated here per this suite's per-file convention). */
function seedEligibleContinueJob(cwd, overrides = {}) {
  const slug = overrides.slug ?? 'quirky-oasis-906b';
  const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
  fs.mkdirSync(worktreePath, { recursive: true });
  const record = baseRecord({
    slug,
    state: 'done',
    phase: 'code-loop',
    stage: 'test-runner',
    round: 3,
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    branch: `orch/${slug}`,
    worktree: worktreePath,
    lastOutcome: {
      state: 'done',
      phase: 'code-loop',
      stage: 'test-runner',
      round: 3,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      task: 'do the thing',
      summary: 'all good',
      error: null,
    },
    ...overrides,
  });
  writeJob(cwd, slug, record);
  return { slug, worktreePath, record };
}

describe('runContinueDetached — reopen + spawn wiring', () => {
  it('reopens the existing job in place (continuation bumped, phase/stage/round reset, state:"running") rather than allocating a new slug', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const spawnMock = fakeSpawn(54321);
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'fix the failure and finish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: spawnMock,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    // Still exactly one job directory — no new slug allocated.
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.orch')), [slug]);

    const record = readJob(cwd, slug);
    assert.equal(record.state, 'running');
    assert.equal(record.task, 'fix the failure and finish');
    assert.equal(record.phase, 'research');
    assert.equal(record.stage, null);
    assert.equal(record.round, null);
    assert.equal(record.finishedAt, null);
    assert.equal(record.exitCode, null);
    assert.equal(record.continuation, 2);
    assert.equal(record.pid, 54321);
  });

  it('reopens a "failed" job the same way (issue #11: --detach continue is no longer done-only)', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd, {
      state: 'failed',
      exitCode: 1,
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
    const spawnMock = fakeSpawn(54325);
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'fix the failure and finish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: spawnMock,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(spawnMock.mock.calls.length, 1);
    const record = readJob(cwd, slug);
    assert.equal(record.state, 'running');
    assert.equal(record.continuation, 2);
    assert.equal(record.pid, 54325);
    assert.equal(exitMock.mock.calls.some((c) => c.arguments[0] === 1), false);
  });

  it('spawns a re-invocation of `continue <slug> <task>` with --detach stripped and ORCH_JOB_SLUG/ORCH_DETACHED set', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const spawnMock = fakeSpawn(54322);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: spawnMock,
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(spawnMock.mock.calls.length, 1);
    const [command, args, spawnOptions] = spawnMock.mock.calls[0].arguments;
    assert.equal(command, process.execPath);
    assert.ok(args.includes('continue'));
    assert.ok(args.includes(slug));
    assert.ok(args.includes('follow-up polish'));
    assert.ok(!args.includes('--detach'), 'the re-invoked child must not receive --detach (it would spawn a grandchild)');

    assert.equal(spawnOptions.detached, true);
    assert.equal(spawnOptions.env.ORCH_DETACHED, '1');
    assert.equal(spawnOptions.env.ORCH_JOB_SLUG, slug);
  });

  it('forwards --skip-test-loop on the child argv when set, and omits it otherwise', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const spawnWith = fakeSpawn(54326);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        skipTestLoop: true,
        spawn: spawnWith,
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }
    const [, withArgs] = spawnWith.mock.calls[0].arguments;
    assert.ok(withArgs.includes('--skip-test-loop'));
    assert.equal(readJob(cwd, slug).skipTestLoop, true);

    const { slug: slug2 } = seedEligibleContinueJob(cwd, { slug: 'continue-noskip-0001' });
    const spawnWithout = fakeSpawn(54327);
    const logSpy2 = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug2, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: spawnWithout,
        exit: mock.fn(),
      });
    } finally {
      logSpy2.mock.restore();
    }
    const [, withoutArgs] = spawnWithout.mock.calls[0].arguments;
    assert.ok(!withoutArgs.includes('--skip-test-loop'));
    assert.equal('skipTestLoop' in readJob(cwd, slug2), false);
  });

  it('reuses the existing orch.log path in append mode — prior content survives', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const { logPath } = jobPaths(cwd, slug);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'prior iteration output\n');

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: fakeSpawn(54323),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(fs.readFileSync(logPath, 'utf8'), 'prior iteration output\n');
  });

  it('prints "started" mentioning the same slug (not a freshly generated one) and calls exit(0)', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        spawn: fakeSpawn(54324),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    const printed = logSpy.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
    assert.match(printed, new RegExp(`started ${slug} \\(pid 54324`));
    assert.equal(exitMock.mock.calls.length, 1);
    assert.equal(exitMock.mock.calls[0].arguments[0], 0);
  });

  it('refuses an ineligible slug synchronously: no spawn, run.json completely untouched, exit(1)', async () => {
    const cwd = makeTmpCwd();
    const { slug, record: before } = seedEligibleContinueJob(cwd, { state: 'running', pid: process.pid, lastOutcome: null, finishedAt: null, exitCode: null });
    const spawnMock = fakeSpawn(1);
    const exitMock = mock.fn();
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      await runContinueDetached(slug, 'keep going', {
        agent: 'claude',
        cwd,
        spawn: spawnMock,
        exit: exitMock,
      });
    } finally {
      errorSpy.mock.restore();
    }

    assert.equal(spawnMock.mock.calls.length, 0, 'an ineligible continue must never spawn a background child');
    assert.deepEqual(readJob(cwd, slug), before, 'run.json must be byte-for-byte unchanged on refusal');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] === 1));
    const printed = errorSpy.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
    assert.match(printed, /use orch resume \/ orch stop/);
  });

  it('never constructs an AgentClass or runs any pipeline stage itself', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        cwd,
        spawn: fakeSpawn(1),
        exit: mock.fn(),
      });
      // As with runDetached's equivalent test: no assertion target beyond
      // "did not throw" — runContinueDetached takes no AgentClass option at
      // all, so an accidental real pipeline invocation would throw/hang
      // trying to spawn a real agent CLI, which the try/finally would surface.
      assert.ok(true);
    } finally {
      logSpy.mock.restore();
    }
  });
});

describe('orch continue --detach — lifecycle: listable / statusable / followable via orch logs', () => {
  it('after runContinueDetached returns, the job is immediately listable (listJobs), statusable (readJob shows bumped continuation), and its log remains followable via a real, unmocked `orch logs` subprocess', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);
    const { logPath } = jobPaths(cwd, slug);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'prior run output\n');

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinueDetached(slug, 'follow-up polish', {
        agent: 'claude',
        maxRounds: 5,
        cwd,
        // Use a live pid so listJobs' reconcileJob does not rewrite running→crashed
        // (fake numeric pids are always dead; that would make the running assertion vacuous).
        spawn: fakeSpawn(process.pid),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    // Listable: still exactly one row, under the same slug, now live again.
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].slug, slug);
    assert.equal(jobs[0].state, 'running');
    assert.equal(jobs[0].continuation, 2);

    // Statusable: a real, unmocked `orch status <slug>` subprocess succeeds
    // and reflects the reopened state.
    const statusResult = await runCli(['status', slug], { cwd });
    assert.equal(statusResult.code, 0);
    assert.match(statusResult.stdout, new RegExp(slug));

    // Followable: a real, unmocked `orch logs <slug>` subprocess still works
    // and shows the prior iteration's content, because the log was reused
    // (appended), not replaced.
    const logsResult = await runCli(['logs', slug], { cwd });
    assert.equal(logsResult.code, 0);
    assert.match(logsResult.stdout, /prior run output/);
  });
});

/**
 * The spawn-env assertion above only proves the parent *sets* ORCH_JOB_SLUG.
 * Task §6 / research also require the Commander `continue` action itself to
 * skip `reopenJob` (no second `continuation` bump) when that env is already
 * set — otherwise a detached continue double-bumps (2→3) the moment the
 * child starts. Mirrors test/headless.test.js's "allocate before PATH
 * check" pattern: empty PATH makes the child fail after the reopen
 * decision, so we can observe whether reopen ran without needing a full
 * agent pipeline.
 */
describe('Commander continue — ORCH_JOB_SLUG already set (detached child path)', () => {
  it('does not reopen / bump continuation when ORCH_JOB_SLUG is already set (child must not double-reopen)', async () => {
    const cwd = makeTmpCwd();
    const { slug, record: before } = seedEligibleContinueJob(cwd);
    assert.equal(before.continuation, undefined);

    const { code, stderr } = await runCli(
      ['continue', slug, 'follow-up polish', '--agent', 'claude'],
      {
        cwd,
        env: {
          ...process.env,
          ORCH_JOB_SLUG: slug,
          ORCH_DETACHED: '1',
          // Force the agent binary check / first spawn to fail so this test
          // does not need a real pipeline — reopen (if wrongly called) still
          // happens before that failure, same ordering as allocate-before-
          // PATH for plain foreground runs.
          PATH: '/nonexistent-empty-path-for-tests',
        },
      },
    );
    assert.equal(code, 1);
    assert.match(
      stderr,
      /claude not found/i,
      'must reach the agent PATH check (not die as unknown-command); otherwise a missing continue subcommand would vacuous-pass the no-reopen assertion',
    );

    const after = readJob(cwd, slug);
    assert.equal(
      after.continuation,
      undefined,
      'detached child with ORCH_JOB_SLUG set must not call reopenJob (continuation would become 2)',
    );
    assert.equal(after.continuations, undefined);
    // Still terminal — parent owns the reopen; child only runs the pipeline.
    assert.equal(after.state, before.state);
  });

  it('without ORCH_JOB_SLUG, foreground continue still reopens before the agent PATH check fails', async () => {
    const cwd = makeTmpCwd();
    const { slug } = seedEligibleContinueJob(cwd);

    // Drop inherited orch job env so this CLI child is truly "foreground"
    // (spread of process.env alone would keep ORCH_JOB_SLUG when npm test
    // runs under an orch worker and vacuous-pass the sibling skip-reopen case).
    const env = { ...process.env, PATH: '/nonexistent-empty-path-for-tests' };
    delete env.ORCH_JOB_SLUG;
    delete env.ORCH_DETACHED;

    const { code, stderr } = await runCli(
      ['continue', slug, 'follow-up polish', '--agent', 'claude'],
      { cwd, env },
    );
    assert.equal(code, 1);
    assert.match(stderr, /claude not found/i);

    const after = readJob(cwd, slug);
    assert.equal(
      after.continuation,
      2,
      'foreground continue (no ORCH_JOB_SLUG) must reopen before failing the agent PATH check — otherwise the child-skip test above is vacuous',
    );
    assert.equal(after.state, 'running');
  });
});
