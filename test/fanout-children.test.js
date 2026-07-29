import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerPipeline, runIntegratePipeline } from '../main.js';
import { readFanout, writeFanout } from '../lib/fanout.js';
import { readJob } from '../lib/jobs.js';
import { allocateJob } from '../lib/job-lifecycle.js';

/**
 * Contract this file pins down for the fan-out phase 2 child entrypoints
 * (see .spec/fanout-2-child-paths.md sections 2, 4, 5, 6, 7 and
 * .spec/fanout.md's "Run shapes" / "The integration session"). Neither
 * `--worker`/`--integrate` nor `runWorkerPipeline`/`runIntegratePipeline`
 * exist yet in main.js as of this test-writing round — these tests describe
 * the contract the next implementation round must satisfy.
 *
 * `runWorkerPipeline(prompt, options)` — the `--worker <parent>:<workerId>`
 * driver, exported from main.js the same way `runPipeline`/`runDetached`
 * are, for in-process testing with injected collaborators:
 * - `prompt` is the subtask text with the worker envelope already appended
 *   (built by the CLI wiring via `buildWorkerEnvelope`; the driver itself
 *   does not build the envelope).
 * - `options`: `agent`, `maxRounds` (default 5), `verbose`, `AgentClass`,
 *   `cwd` (repo root, default `process.cwd()`), `parentSlug`, `workerId`,
 *   `base` (the git ref/sha to branch the worker's worktree from — the
 *   fanout doc's recorded base), plus the same injectable seams
 *   `runPipeline` already has (`createRunContext`, `createWorktree`,
 *   `commitWorktree`, `collectWorktreeChanges`, `patchJob`,
 *   `checkpointPause`, `pausePollIntervalMs`, `jobSlug`, `jobCwd` — jobSlug
 *   falls back to `process.env.ORCH_JOB_SLUG` exactly like `runPipeline`),
 *   plus new `patchWorker`/`recordChangedFiles` (default the real
 *   `lib/fanout.js` implementations) and `execFile` (forwarded to
 *   `recordChangedFiles`).
 * - Stage order, skipping triage entirely: research → planner → worktree
 *   (`createWorktree({ cwd, slug: runContext.slug, base })`) → test loop
 *   (test-writer ⇄ test-critic) → code loop (code-writer ⇄ test-runner,
 *   writer-first) → commit. Reuses the exact `agents/*AgentArgs` builders and
 *   job-patch/checkpoint/status-file conventions `runPipeline` already
 *   established.
 * - On a successful commit: calls `patchWorker(cwd, parentSlug, workerId, {
 *   state: 'done', sha: commitResult.sha, changedFiles })` where
 *   `changedFiles` comes from `recordChangedFiles({ repoRoot, base, branch,
 *   execFile })`, and patches its own `run.json` to `state:'done'`.
 * - On any stage throwing: calls `patchWorker(cwd, parentSlug, workerId, {
 *   state: 'failed' })`, patches its own `run.json` to `state:'failed'`
 *   (mirroring `runPipeline`'s catch block), then `process.exit(1)` (tests
 *   mock `process.exit`, matching the existing convention throughout
 *   test/main.test.js / test/headless.test.js since `runPipeline`'s failure
 *   path is not given an injectable `exit`).
 *
 * `runIntegratePipeline(options)` — the `--integrate <parent>` driver,
 * exported the same way:
 * - `options`: `agent`, `maxRounds` (default 5), `verbose`, `AgentClass`,
 *   `cwd` (repo root), `parentSlug`, the same job-record seams as above
 *   (`patchJob`, `checkpointPause`, `pausePollIntervalMs`, `jobSlug`,
 *   `jobCwd`), `createWorktree`/`commitWorktree`, `readFanout`/
 *   `patchIntegration` (default real `lib/fanout.js`), `mergeBranches`/
 *   `abortMerge`/`conflictedFiles`/`hasConflictMarkers` (default real
 *   `lib/integrate.js`), and `execFile` (forwarded to all of the above, and
 *   used directly for the worktree-reuse branch check
 *   (`git rev-parse --abbrev-ref HEAD`) and for completing a repaired merge
 *   commit (`git commit`, no `-m`, accepting the staged merge message)).
 * - Never invokes triage, research, planner, test-writer, or test-critic.
 * - Worktree: reused when `<cwd>-<parentSlug>` already exists on disk and is
 *   checked out on `orch/<parentSlug>` (no `reset`/`clean`); otherwise
 *   created via `createWorktree({ cwd, slug: parentSlug, base: fanout.base })`.
 * - Merges `fanout.integration.candidates` in the given order (no
 *   reordering), skipping branches already in `fanout.integration.merged`,
 *   via `mergeBranches`. On a clean merge, appends the branch to
 *   `integration.merged` via `patchIntegration`. On conflict: sets
 *   `integration.state:'repairing'`, gathers `conflictedFiles` and the
 *   `subtask`/`area` of workers whose `branch` matches the conflicted
 *   candidate, invokes the `integrator` agent exactly once, re-checks
 *   `hasConflictMarkers` — clears → completes the merge commit itself and
 *   records the branch merged; markers remain (or the agent failed) →
 *   `abortMerge` and records the branch in `integration.skipped`, continuing
 *   with the remaining candidates rather than aborting the whole run.
 * - After all candidates: a runner-first verify loop — `test-runner` first;
 *   `code-writer` only on failure, alternating up to `--max-rounds`; never
 *   `test-writer`/`test-critic`.
 * - On verify success: `commitWorktree({ worktreePath, branch:
 *   'orch/<parentSlug>', message: 'orch: <parentSlug> <first line of
 *   fanout.task>' })`, then `patchIntegration(cwd, parentSlug, {
 *   state:'done', sha, merged, skipped })`.
 * - On verify exhaustion: `patchIntegration(..., { state:'failed', merged,
 *   skipped })`, then `process.exit(1)`.
 * - Appends every step (worktree reuse/create, each merge result,
 *   conflict/repair attempts, verify-loop rounds, final commit) to
 *   `.orch/<jobSlug>/integration.md` as it happens.
 *
 * CLI wiring (main.js `.action()`):
 * - `--worker <parent>:<workerId>` and `--integrate <parent>` are both
 *   `Option.hideHelp()` — absent from `orch --help`.
 * - `--worker`/`--integrate` reject an unknown parent slug (missing
 *   `fanout.json`) or, for `--worker`, an unknown `workerId` within an
 *   otherwise-valid `fanout.json`, printing an error and exiting non-zero
 *   before any worktree is created.
 * - `--worker`/`--integrate` cannot be combined with `--ask`, `--quick`, or
 *   `--detach` (mirroring the existing `--detach` conflict-check style).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Fake `execFile` for argument-level tests, same pattern as test/fanout.test.js / test/worktree.test.js. */
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

function baseWorker(overrides = {}) {
  return {
    id: '01-scaffold',
    title: 'shared billing types and stubs',
    subtask: 'Create Invoice and Charge types and register billing routes.',
    area: 'src/billing/',
    owns: ['src/billing/types.ts'],
    dependsOn: [],
    scaffold: false,
    slug: null,
    branch: null,
    state: 'pending',
    sha: null,
    changedFiles: [],
    overlaps: [],
    ...overrides,
  };
}

function baseFanout(overrides = {}) {
  return {
    parentSlug: 'wise-pine-e904',
    task: 'implement the billing module',
    base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    maxWorkers: 4,
    maxConcurrency: null,
    concurrency: 2,
    state: 'running',
    workers: [
      baseWorker({ id: '01-scaffold', scaffold: true, branch: 'orch/rapid-fox-x7q2', state: 'done' }),
      baseWorker({
        id: '02-invoices',
        title: 'invoice endpoints',
        subtask: 'Implement create and list invoice endpoints.',
        area: 'src/billing/invoices/',
        owns: ['src/billing/invoices/'],
        dependsOn: ['01-scaffold'],
        branch: 'orch/merry-elk-r4b1',
        state: 'done',
      }),
      baseWorker({
        id: '03-charges',
        title: 'charge endpoints',
        subtask: 'Implement create and list charge endpoints.',
        area: 'src/billing/charges/',
        owns: ['src/billing/charges/'],
        dependsOn: ['01-scaffold'],
        branch: 'orch/wise-owl-k1a8',
        state: 'done',
      }),
    ],
    integration: {
      slug: null,
      pid: null,
      branch: null,
      worktree: null,
      candidates: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1', 'orch/wise-owl-k1a8'],
      merged: [],
      skipped: [],
      overlappingFiles: [],
      state: 'pending',
      sha: null,
    },
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/** Strip an optional ` k/N` round suffix from an agent spinner name. */
function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

/** Same mock-AgentClass-by-role pattern as test/main.test.js / test/headless.test.js. */
function createMockAgentClass(behaviors, { order } = {}) {
  const instances = [];
  const queues = Object.create(null);

  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
      instances.push(this);
      order?.push(agentRole(name));
    }

    async run() {
      const role = agentRole(this.name);
      const behavior = behaviors[this.name] ?? behaviors[role];
      if (Array.isArray(behavior)) {
        if (!(role in queues)) queues[role] = behavior.slice();
        if (queues[role].length > 0) return queues[role].shift();
        return behavior[behavior.length - 1] ?? { ok: true, result: '' };
      }
      return behavior ?? { ok: true, result: '' };
    }
  }

  MockAgent.instances = instances;
  return MockAgent;
}

const SUMMARY_DELIM = '<<<SUMMARY>>>';
function withSummary(content, summary) {
  return `${content}\n${SUMMARY_DELIM}\n${summary}`;
}

const PASS_CRITIC = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), 'critic ok') };
const PASS_RUNNER = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), 'runner ok') };
const FAIL_RUNNER = {
  ok: true,
  result: withSummary(JSON.stringify({ passed: false, summary: 'tests failed', failures: ['boom'] }), 'runner fail'),
};

/** Default stubs for a worker path that passes both loops in one round. */
function workerPassBehaviors(overrides = {}) {
  return {
    research: { ok: true, result: withSummary('research-output', 'research ok') },
    planner: { ok: true, result: withSummary('planner-output', 'planner ok') },
    'test-writer': { ok: true, result: withSummary('tests written', 'writer ok') },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: withSummary('implemented', 'code ok') },
    'test-runner': PASS_RUNNER,
    ...overrides,
  };
}

function fakeRunContext(cwd, slug) {
  const artifactDir = path.join(cwd, '.orch', slug);
  return {
    slug,
    artifactDir,
    researchPath: path.join(artifactDir, 'research.md'),
    taskPath: path.join(artifactDir, 'task.md'),
    statusPath: path.join(artifactDir, 'status.md'),
  };
}

function fakeWorktree(cwd, slug) {
  return {
    repoRoot: cwd,
    worktreePath: path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`),
    branch: `orch/${slug}`,
  };
}

function fakeCommitResult(branch, sha = 'deadbeefcafebabe0000000000000000000000') {
  return { committed: true, sha, branch };
}

describe('runWorkerPipeline (--worker driver)', () => {
  it('constructs research → planner → test-writer → test-critic → code-writer → test-runner, with no triage', async () => {
    const cwd = makeTmpCwd('orch-worker-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors());
    const createWorktreeMock = mock.fn(() => worktree);
    const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runWorkerPipeline('Implement create and list invoice endpoints.\n\nThis is one worker...', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        createRunContext: mock.fn(() => runContext),
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['research', 'planner', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
  });

  it('creates the worktree from the fanout doc\'s recorded base', async () => {
    const cwd = makeTmpCwd('orch-worker-base-');
    const doc = baseFanout({ base: 'deadfeed1234567890deadfeed1234567890dead' });
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors());
    const createWorktreeMock = mock.fn(() => worktree);

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runWorkerPipeline('subtask text', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        createRunContext: mock.fn(() => runContext),
        createWorktree: createWorktreeMock,
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(createWorktreeMock.mock.calls.length, 1);
    const [callArgs] = createWorktreeMock.mock.calls[0].arguments;
    assert.equal(callArgs.base, doc.base);
    assert.equal(callArgs.cwd, cwd);
  });

  it('on success, patches fanout.json.workers[].state to "done" with sha/changedFiles, and the worker\'s own run.json carries parent/role/workerId', async () => {
    const cwd = makeTmpCwd('orch-worker-success-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors());
    const sha = 'c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6';
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('diff'), stdout: 'src/billing/invoices/create.ts\nsrc/billing/invoices/list.ts\n' },
    ]);

    // Seed the worker's own run.json the way the CLI action's allocateJob call would.
    allocateJob({
      cwd,
      prompt: 'Implement create and list invoice endpoints.',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: doc.parentSlug,
      role: 'worker',
      workerId: '02-invoices',
      generateSlug: () => workerSlug,
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runWorkerPipeline('subtask text', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        execFile,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch, sha)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const updatedFanout = readFanout(cwd, doc.parentSlug);
    const patchedWorker = updatedFanout.workers.find((w) => w.id === '02-invoices');
    assert.equal(patchedWorker.state, 'done');
    assert.equal(patchedWorker.sha, sha);
    assert.deepEqual(patchedWorker.changedFiles, ['src/billing/invoices/create.ts', 'src/billing/invoices/list.ts']);

    const ownRecord = readJob(cwd, workerSlug);
    assert.equal(ownRecord.parent, doc.parentSlug);
    assert.equal(ownRecord.role, 'worker');
    assert.equal(ownRecord.workerId, '02-invoices');
    assert.equal(ownRecord.state, 'done');
  });

  it('on a thrown stage, patches fanout.json.workers[].state to "failed" and its own run.json to "failed", then exits non-zero', async () => {
    const cwd = makeTmpCwd('orch-worker-fail-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors({
      'test-runner': [FAIL_RUNNER, FAIL_RUNNER, FAIL_RUNNER, FAIL_RUNNER, FAIL_RUNNER],
    }));

    allocateJob({
      cwd,
      prompt: 'subtask',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: doc.parentSlug,
      role: 'worker',
      workerId: '02-invoices',
      generateSlug: () => workerSlug,
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runWorkerPipeline('subtask text', {
        agent: 'claude',
        maxRounds: 2,
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(exitSpy.mock.calls.some((c) => c.arguments[0] === 1));

    const updatedFanout = readFanout(cwd, doc.parentSlug);
    const patchedWorker = updatedFanout.workers.find((w) => w.id === '02-invoices');
    assert.equal(patchedWorker.state, 'failed');

    const ownRecord = readJob(cwd, workerSlug);
    assert.equal(ownRecord.state, 'failed');
  });
});

/**
 * Contract this section pins down for `lastOutcome` capture on
 * `runWorkerPipeline` (net-new field on every terminal `jobPatch`, see
 * `.spec/continue.md` "lastOutcome (written on every terminal transition)"
 * and `.orch/sunny-oasis-a761/task.md` section 1). It does not exist yet as
 * of this test-writing round. Same shape as the `runPipeline` lastOutcome
 * tests in test/main.test.js, but for the `--worker` driver: a worker's own
 * `run.json.lastOutcome` must be captured the same way an ordinary complex
 * run's is, independent of its `fanout.json` bookkeeping.
 */
describe('runWorkerPipeline lastOutcome capture on terminal states', () => {
  it('writes lastOutcome.state:"done" with the final code-loop verdict summary on a clean success', async () => {
    const cwd = makeTmpCwd('orch-worker-lastoutcome-done-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors());

    allocateJob({
      cwd,
      prompt: 'Implement create and list invoice endpoints.',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: doc.parentSlug,
      role: 'worker',
      workerId: '02-invoices',
      generateSlug: () => workerSlug,
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runWorkerPipeline('Implement create and list invoice endpoints.', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const record = readJob(cwd, workerSlug);
    assert.equal(record.state, 'done');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'done');
    assert.equal(record.lastOutcome.exitCode, 0);
    assert.equal(record.lastOutcome.task, 'Implement create and list invoice endpoints.');
    assert.equal(record.lastOutcome.summary, 'suite green');
    assert.ok(record.lastOutcome.error == null, 'error should be omitted/null on a clean done');
  });

  it('writes lastOutcome.state:"failed" with phase/stage and the thrown error message', async () => {
    const cwd = makeTmpCwd('orch-worker-lastoutcome-failed-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const runContext = fakeRunContext(cwd, workerSlug);
    const worktree = fakeWorktree(cwd, workerSlug);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors({
      'test-runner': { ok: false, result: 'test runner crashed' },
    }));

    allocateJob({
      cwd,
      prompt: 'subtask',
      agent: 'claude',
      state: 'running',
      pid: process.pid,
      parent: doc.parentSlug,
      role: 'worker',
      workerId: '02-invoices',
      generateSlug: () => workerSlug,
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runWorkerPipeline('subtask text', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        base: doc.base,
        jobSlug: workerSlug,
        jobCwd: cwd,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called after a failed code loop'); }),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    const record = readJob(cwd, workerSlug);
    assert.equal(record.state, 'failed');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'failed');
    assert.equal(record.lastOutcome.exitCode, 1);
    assert.equal(record.lastOutcome.phase, 'code-loop');
    assert.equal(record.lastOutcome.stage, 'test-runner');
    assert.equal(typeof record.lastOutcome.error, 'string');
  });
});

describe('runIntegratePipeline (--integrate driver)', () => {
  it('never constructs triage/research/planner/test-writer/test-critic; verifies runner-first when merges are already green', async () => {
    const cwd = makeTmpCwd('orch-integrate-green-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const integrationSlug = 'tidy-heron-m2p9';
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const { execFile, calls } = makeFakeExecFile([
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const MockAgentClass = createMockAgentClass({ 'test-runner': PASS_RUNNER });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: integrationSlug,
        jobCwd: cwd,
        execFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['test-runner'],
    );

    const integrationMdPath = path.join(cwd, '.orch', integrationSlug, 'integration.md');
    assert.ok(fs.existsSync(integrationMdPath), 'expected integration.md to be written');
    const integrationMd = fs.readFileSync(integrationMdPath, 'utf8');
    for (const branch of doc.integration.candidates) {
      assert.ok(integrationMd.includes(branch), `expected integration.md to mention ${branch}`);
    }

    const updatedFanout = readFanout(cwd, doc.parentSlug);
    assert.equal(updatedFanout.integration.state, 'done');
    assert.deepEqual(updatedFanout.integration.merged, doc.integration.candidates);
  });

  it('runner-first with a failing-then-passing suite alternates test-runner → code-writer → test-runner, capped by --max-rounds', async () => {
    const cwd = makeTmpCwd('orch-integrate-alternate-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const worktree = fakeWorktree(cwd, doc.parentSlug);
    const order = [];

    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const MockAgentClass = createMockAgentClass({
      'test-runner': [FAIL_RUNNER, PASS_RUNNER],
      'code-writer': { ok: true, result: withSummary('fixed it', 'code ok') },
    }, { order });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        maxRounds: 5,
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, ['test-runner', 'code-writer', 'test-runner']);
  });

  it('caps runner-first alternation at --max-rounds and records integration.state:"failed" when the suite never passes', async () => {
    const cwd = makeTmpCwd('orch-integrate-exhausted-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const MockAgentClass = createMockAgentClass({
      'test-runner': [FAIL_RUNNER, FAIL_RUNNER],
      'code-writer': { ok: true, result: withSummary('tried', 'code tried') },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        maxRounds: 2,
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(exitSpy.mock.calls.some((c) => c.arguments[0] === 1));
    const updatedFanout = readFanout(cwd, doc.parentSlug);
    assert.equal(updatedFanout.integration.state, 'failed');
  });

  it('reuses an existing worktree on orch/<parent> and skips branches already in integration.merged — no reset/clean, no git merge for already-merged branches', async () => {
    const cwd = makeTmpCwd('orch-integrate-reuse-');
    const doc = baseFanout({
      integration: {
        slug: null, pid: null, branch: `orch/wise-pine-e904`, worktree: `${cwd}-wise-pine-e904`,
        candidates: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1', 'orch/wise-owl-k1a8'],
        merged: ['orch/rapid-fox-x7q2'], skipped: [], overlappingFiles: [], state: 'merging', sha: null,
      },
    });
    writeFanout(cwd, doc.parentSlug, doc);

    const existingWorktreePath = `${cwd}-${doc.parentSlug}`;
    fs.mkdirSync(existingWorktreePath, { recursive: true });

    const { execFile, calls } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('--abbrev-ref'), stdout: `orch/${doc.parentSlug}\n` },
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const createWorktreeMock = mock.fn();
    const MockAgentClass = createMockAgentClass({ 'test-runner': PASS_RUNNER });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile,
        createWorktree: createWorktreeMock,
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(createWorktreeMock.mock.calls.length, 0, 'must not create a worktree when reusing');
    assert.ok(!calls.some((c) => c.args.includes('reset')), 'must never run git reset on reuse');
    assert.ok(!calls.some((c) => c.args.includes('clean')), 'must never run git clean on reuse');

    const mergeCalls = calls.filter((c) => c.args.includes('merge') && !c.args.includes('--abort'));
    assert.ok(
      !mergeCalls.some((c) => c.args.includes('orch/rapid-fox-x7q2')),
      'must not re-merge a branch already recorded as merged',
    );
    assert.ok(mergeCalls.some((c) => c.args.includes('orch/merry-elk-r4b1')));
    assert.ok(mergeCalls.some((c) => c.args.includes('orch/wise-owl-k1a8')));
  });

  it('on a conflicted merge, invokes the integrator agent exactly once with the conflicted paths; clears markers → completes the merge and records it merged', async () => {
    const cwd = makeTmpCwd('orch-integrate-conflict-resolved-');
    const doc = baseFanout({
      integration: {
        slug: null, pid: null, branch: null, worktree: null,
        candidates: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1'],
        merged: [], skipped: [], overlappingFiles: ['src/billing/index.ts'], state: 'pending', sha: null,
      },
      workers: [
        baseWorker({ id: '01-scaffold', scaffold: true, branch: 'orch/rapid-fox-x7q2', state: 'done' }),
        baseWorker({
          id: '02-invoices', title: 'invoice endpoints', subtask: 'Implement invoice endpoints.',
          area: 'src/billing/invoices/', branch: 'orch/merry-elk-r4b1', dependsOn: ['01-scaffold'], state: 'done',
        }),
      ],
    });
    writeFanout(cwd, doc.parentSlug, doc);
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    let markersCleared = false;
    const calls = [];
    const fakeExecFile = (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('merge') && args.includes('orch/rapid-fox-x7q2') && !args.includes('--abort')) {
        return 'Merge made by the ort strategy.';
      }
      if (args.includes('merge') && args.includes('orch/merry-elk-r4b1') && !args.includes('--abort')) {
        throw Object.assign(new Error('git merge failed'), { stderr: 'CONFLICT (content): Merge conflict in src/billing/index.ts' });
      }
      if (args.includes('diff') && args.includes('--diff-filter=U')) {
        return 'src/billing/index.ts\n';
      }
      if (args.includes('diff') && !args.includes('--name-only')) {
        return markersCleared ? '' : '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> orch/merry-elk-r4b1\n';
      }
      if (args.includes('commit') && !args.includes('-m')) {
        return '';
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) {
        return 'e5f6071e5f6071e5f6071e5f6071e5f6071e5f6\n';
      }
      throw new Error(`unhandled fake execFile call: ${command} ${args.join(' ')}`);
    };

    const MockAgentClass = createMockAgentClass({
      integrator: {
        ok: true,
        result: withSummary('resolved the conflict in src/billing/index.ts', 'integrator ok'),
      },
      'test-runner': PASS_RUNNER,
    });
    const originalRun = MockAgentClass.prototype.run;
    MockAgentClass.prototype.run = async function patchedRun(...args) {
      if (agentRole(this.name) === 'integrator') {
        markersCleared = true;
      }
      return originalRun.apply(this, args);
    };

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile: fakeExecFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const integratorCalls = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'integrator');
    assert.equal(integratorCalls.length, 1);
    assert.ok(
      integratorCalls[0].instructions.includes('src/billing/index.ts'),
      'expected the integrator to be invoked with the conflicted file path',
    );

    const updatedFanout = readFanout(cwd, doc.parentSlug);
    assert.deepEqual(updatedFanout.integration.merged.sort(), ['orch/merry-elk-r4b1', 'orch/rapid-fox-x7q2'].sort());
    assert.deepEqual(updatedFanout.integration.skipped, []);
  });

  it('when conflict markers remain after the integrator runs, aborts the merge, records the branch skipped, and still attempts remaining candidates', async () => {
    const cwd = makeTmpCwd('orch-integrate-conflict-unresolved-');
    const doc = baseFanout({
      integration: {
        slug: null, pid: null, branch: null, worktree: null,
        candidates: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1', 'orch/wise-owl-k1a8'],
        merged: [], skipped: [], overlappingFiles: ['src/billing/index.ts'], state: 'pending', sha: null,
      },
    });
    writeFanout(cwd, doc.parentSlug, doc);
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const abortCalls = [];
    const fakeExecFile = (command, args) => {
      if (args.includes('merge') && args.includes('--abort')) {
        abortCalls.push(args);
        return '';
      }
      if (args.includes('merge') && args.includes('orch/rapid-fox-x7q2')) return 'ok';
      if (args.includes('merge') && args.includes('orch/merry-elk-r4b1')) {
        throw Object.assign(new Error('git merge failed'), { stderr: 'CONFLICT (content): Merge conflict in src/billing/index.ts' });
      }
      if (args.includes('merge') && args.includes('orch/wise-owl-k1a8')) return 'ok';
      if (args.includes('diff') && args.includes('--diff-filter=U')) return 'src/billing/index.ts\n';
      if (args.includes('diff') && !args.includes('--name-only')) return '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> orch/merry-elk-r4b1\n';
      throw new Error(`unhandled fake execFile call: ${command} ${args.join(' ')}`);
    };

    const MockAgentClass = createMockAgentClass({
      integrator: { ok: true, result: withSummary('tried but could not fully resolve', 'integrator gave up') },
      'test-runner': PASS_RUNNER,
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile: fakeExecFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(abortCalls.length, 1);
    const updatedFanout = readFanout(cwd, doc.parentSlug);
    assert.deepEqual(updatedFanout.integration.skipped, ['orch/merry-elk-r4b1']);
    // Remaining candidate after the conflicted one is still attempted, not abandoned.
    assert.deepEqual(updatedFanout.integration.merged.sort(), ['orch/rapid-fox-x7q2', 'orch/wise-owl-k1a8'].sort());
  });

  it('passes the fixture\'s pre-ordered candidates straight through to mergeBranches without reordering', async () => {
    const cwd = makeTmpCwd('orch-integrate-order-');
    const doc = baseFanout({
      integration: {
        slug: null, pid: null, branch: null, worktree: null,
        candidates: ['orch/merry-elk-r4b1', 'orch/wise-owl-k1a8', 'orch/rapid-fox-x7q2'],
        merged: [], skipped: [], overlappingFiles: [], state: 'pending', sha: null,
      },
    });
    writeFanout(cwd, doc.parentSlug, doc);
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const mergedOrder = [];
    const fakeExecFile = (command, args) => {
      if (args.includes('merge') && !args.includes('--abort')) {
        const branch = args[args.length - 1];
        mergedOrder.push(branch);
        return 'ok';
      }
      throw new Error(`unhandled fake execFile call: ${command} ${args.join(' ')}`);
    };

    const MockAgentClass = createMockAgentClass({ 'test-runner': PASS_RUNNER });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: 'tidy-heron-m2p9',
        jobCwd: cwd,
        execFile: fakeExecFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(mergedOrder, ['orch/merry-elk-r4b1', 'orch/wise-owl-k1a8', 'orch/rapid-fox-x7q2']);
  });
});

/**
 * Contract this section pins down for `lastOutcome` capture on
 * `runIntegratePipeline` (the third of the four terminal-write call sites
 * named in `.orch/sunny-oasis-a761/task.md` section 1, alongside
 * `runPipeline`/`runWorkerPipeline` already covered above and the fan-out
 * coordinator driver covered in test/fanout-coordinator.test.js). Same shape
 * as the `runWorkerPipeline` lastOutcome tests above: the integration
 * session's own `run.json.lastOutcome` must be captured independent of its
 * `fanout.json` bookkeeping. `task` here is `fanout.task` (the parent's
 * original task), since `runIntegratePipeline` never receives its own
 * `prompt` option — it drives off the fanout doc.
 */
describe('runIntegratePipeline lastOutcome capture on terminal states', () => {
  it('writes lastOutcome.state:"done" with the final verify-loop verdict summary when merges are already green', async () => {
    const cwd = makeTmpCwd('orch-integrate-lastoutcome-done-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const integrationSlug = 'tidy-heron-m2p9';
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const MockAgentClass = createMockAgentClass({ 'test-runner': PASS_RUNNER });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: integrationSlug,
        jobCwd: cwd,
        execFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(`orch/${doc.parentSlug}`)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const record = readJob(cwd, integrationSlug);
    assert.equal(record.state, 'done');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'done');
    assert.equal(record.lastOutcome.exitCode, 0);
    assert.equal(record.lastOutcome.finishedAt, record.finishedAt);
    assert.equal(record.lastOutcome.phase, 'commit');
    assert.equal(record.lastOutcome.stage, 'commit');
    assert.equal(record.lastOutcome.task, doc.task);
    assert.equal(record.lastOutcome.summary, 'suite green');
    assert.ok(record.lastOutcome.error == null, 'error should be omitted/null on a clean done');
  });

  it('writes lastOutcome.state:"failed" with phase/stage/round and the thrown error message when the verify loop never goes green', async () => {
    const cwd = makeTmpCwd('orch-integrate-lastoutcome-failed-');
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const integrationSlug = 'tidy-heron-m2p9';
    const worktree = fakeWorktree(cwd, doc.parentSlug);

    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('merge') && !args.includes('--abort'), stdout: 'Merge made by the ort strategy.' },
    ]);

    const MockAgentClass = createMockAgentClass({
      'test-runner': [FAIL_RUNNER, FAIL_RUNNER],
      'code-writer': { ok: true, result: withSummary('tried', 'code tried') },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runIntegratePipeline({
        agent: 'claude',
        maxRounds: 2,
        AgentClass: MockAgentClass,
        cwd,
        parentSlug: doc.parentSlug,
        jobSlug: integrationSlug,
        jobCwd: cwd,
        execFile,
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called after an exhausted verify loop'); }),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(exitSpy.mock.calls.some((c) => c.arguments[0] === 1));
    const record = readJob(cwd, integrationSlug);
    assert.equal(record.state, 'failed');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'failed');
    assert.equal(record.lastOutcome.exitCode, 1);
    assert.equal(record.lastOutcome.phase, 'code-loop');
    assert.equal(record.lastOutcome.stage, 'test-runner');
    assert.equal(record.lastOutcome.round, 2);
    assert.equal(record.lastOutcome.task, doc.task);
    assert.equal(typeof record.lastOutcome.error, 'string');
    assert.match(record.lastOutcome.error, /code loop exhausted/);
  });
});

describe('--worker / --integrate CLI wiring', () => {
  function initTmpRepo() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fanout-cli-repo-'));
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

  it('does not mention --worker or --integrate in --help output', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /--worker\b/);
    assert.doesNotMatch(stdout, /--integrate\b/);
  });

  it('--worker with an unknown workerId in an existing parent exits non-zero and creates no worktree', async () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      const doc = baseFanout({ base });
      writeFanout(repoDir, doc.parentSlug, doc);

      const { code, stderr } = await runCli(
        ['do the worker task', '--worker', `${doc.parentSlug}:does-not-exist`, '--agent', 'claude'],
        { cwd: repoDir },
      );

      assert.notEqual(code, 0);
      assert.match(stderr, /does-not-exist|unknown worker|not found/i);
      assert.equal(fs.existsSync(path.join(parent, 'repo-does-not-exist')), false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('--worker with an unknown parent slug (missing fanout.json) exits non-zero', async () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const { code, stderr } = await runCli(
        ['do the worker task', '--worker', 'no-such-parent-0000:02-invoices', '--agent', 'claude'],
        { cwd: repoDir },
      );

      assert.notEqual(code, 0);
      assert.match(stderr, /no-such-parent-0000|not found|unknown/i);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('--integrate with an unknown parent slug exits non-zero', async () => {
    const { parent, repoDir } = initTmpRepo();
    try {
      const { code, stderr } = await runCli(
        ['integrate the branches', '--integrate', 'no-such-parent-0000', '--agent', 'claude'],
        { cwd: repoDir },
      );

      assert.notEqual(code, 0);
      assert.match(stderr, /no-such-parent-0000|not found|unknown/i);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects --worker combined with --ask, --quick, or --detach', async () => {
    for (const flag of ['--ask', '--quick', '--detach']) {
      const { code, stderr } = await runCli(['do something', '--worker', 'some-parent:some-id', flag]);
      assert.notEqual(code, 0, `expected non-zero exit for --worker + ${flag}`);
      assert.match(stderr, /cannot be combined|conflict/i);
    }
  });

  it('rejects --integrate combined with --ask, --quick, or --detach', async () => {
    for (const flag of ['--ask', '--quick', '--detach']) {
      const { code, stderr } = await runCli(['integrate', '--integrate', 'some-parent', flag]);
      assert.notEqual(code, 0, `expected non-zero exit for --integrate + ${flag}`);
      assert.match(stderr, /cannot be combined|conflict/i);
    }
  });
});
