import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanoutPipeline, cascadeStopFanoutChildren, runDetached } from '../main.js';
import { readFanout, writeFanout, patchWorker, patchIntegration } from '../lib/fanout.js';
import { jobPaths, readJob, writeJob, patchJob } from '../lib/jobs.js';
import { allocateJob as realAllocateJob } from '../lib/job-lifecycle.js';
import { exitCodeForSignal } from '../lib/agent.js';

/**
 * Contract this file pins down for the fan-out phase 3 coordinator (see
 * .spec/fanout-3-coordinator.md and .spec/fanout.md's "Scheduling" /
 * "Run shapes" / "Output" / "Interrupts" sections). None of
 * `runFanoutPipeline`, `cascadeStopFanoutChildren`, `--fan-out`,
 * `--max-workers`, `--max-concurrency`, `agents/boundaries.js`, or
 * `agents/decomposer.js` exist yet in main.js as of this test-writing
 * round — these tests describe the contract the next implementation round
 * must satisfy.
 *
 * `runFanoutPipeline(prompt, options)` — the `--fan-out` coordinator driver,
 * exported from main.js the same way `runPipeline`/`runWorkerPipeline`/
 * `runIntegratePipeline` are, for in-process testing with injected
 * collaborators:
 * - `options`: `agent`, `AgentClass`, `maxRounds` (default 5), `verbose`,
 *   `cwd` (repo root, default `process.cwd()`), `maxWorkers` (default 4),
 *   `maxConcurrency` (default null), the same job-record seams `runPipeline`
 *   has for the coordinator's OWN run.json (`jobSlug` — falls back to
 *   `process.env.ORCH_JOB_SLUG` — `jobCwd`, `patchJob`, `checkpointPause`,
 *   `pausePollIntervalMs`), plus fan-out-specific seams: `pollIntervalMs`
 *   (default 500 — interval for polling each spawned child's `run.json` to a
 *   terminal state), `spawn` (default `node:child_process`'s `spawn`, used to
 *   launch worker/integration children), `execFile` (used only to resolve
 *   `git rev-parse HEAD` for `fanout.json.base`), `allocateJob` (default the
 *   real `lib/job-lifecycle.js` implementation, used once per spawned child
 *   — never for the coordinator's own job, which the CLI wiring already
 *   allocated before calling this function, exactly like `runWorkerPipeline`
 *   receives an already-allocated `jobSlug`), `reconcileJob` (default the
 *   real `lib/jobs.js` implementation), and `exit` (default
 *   `(code) => process.exit(code)`, matching `runDetached`'s injectable
 *   `exit` seam so tests never kill the runner). `createRunContext`/
 *   `createWorktree`/`commitWorktree`/`collectWorktreeChanges` are accepted
 *   too but are used ONLY on the decline path (today's single-worktree
 *   pipeline) — never for a validated fan-out.
 * - Stage order: `triage` (reusing `agents/triage.js` + `parseTriageJson`,
 *   exactly like `runPipeline`). `parsed.simple === true` short-circuits to
 *   the existing quick-fix path (decision 7) — no `boundaries`/`decomposer`,
 *   no `fanout.json`.
 * - Otherwise: `boundaries` agent (writing to
 *   `<jobCwd>/.orch/<jobSlug>/boundaries.md`, `cwd: invocationCwd`) runs
 *   exactly once, regardless of how many decomposer repair rounds follow.
 * - `decomposer` agent runs with the boundaries agent's own message content
 *   passed in-memory as `boundariesOutput` (never re-read from disk), parsed
 *   via `parseDecomposition`. `validateDecomposition(decomposition,
 *   { maxWorkers })` runs next; on violations, the decomposer is re-invoked
 *   with a `feedback` array of the violation strings (up to two extra
 *   round-trips — three `decomposer` construction total in the worst case),
 *   then falls through to the decline path if still invalid.
 * - **Decline path** (`decomposable: false`, unparseable decomposer output,
 *   or failed validation after repairs): no `fanout.json` is ever written;
 *   the coordinator continues as today's single-worktree pipeline in its own
 *   job directory — `research` → `planner` → `createWorktree({ cwd,
 *   slug: jobSlug })` → test loop (`test-writer`⇄`test-critic`) → code loop
 *   (`code-writer`⇄`test-runner`) → commit — using the coordinator's own
 *   `jobSlug`/`jobCwd` exactly like `runPipeline`'s complex path.
 * - **On successful validation**: resolves `base = git rev-parse HEAD` (via
 *   `execFile`, at `cwd`), then `writeFanout(cwd, jobSlug, {...})` with the
 *   full schema from `.spec/fanout.md` (`parentSlug` === the coordinator's
 *   own `jobSlug`, `task` === `prompt`, `base`, `maxWorkers`,
 *   `maxConcurrency`, `concurrency`, `state: 'running'`, `workers[]` seeded
 *   `pending`/null, `integration` seeded `pending`/null, `startedAt`,
 *   `finishedAt: null`). The coordinator's own `run.json` is never patched
 *   with `branch`/`worktree` on this path (no worktree of its own).
 * - **Scaffold-first**: a `scaffold: true` worker is spawned alone (no other
 *   worker spawns until it settles); on `done` its `sha` (self-recorded by
 *   the worker child via `patchWorker`) replaces `fanout.json.base`; on
 *   `failed`/crash, the whole fan-out aborts before any parallel worker is
 *   spawned, and the coordinator exits non-zero.
 * - **Spawning a worker**: `allocateJob({ cwd, prompt: subtask + envelope,
 *   agent, maxRounds, state: 'starting', parent: jobSlug, role: 'worker',
 *   workerId })` reserves the slug and writes the child's initial
 *   `run.json`; the coordinator then patches that worker's `fanout.json`
 *   entry with `{ slug, branch: 'orch/<slug>', state: 'running' }` via
 *   `patchWorker`, spawns `process.execPath` with argv
 *   `[__filename, subtask + buildWorkerEnvelope(...), '--agent', agent,
 *   '--max-rounds', String(maxRounds), '--worker', '<jobSlug>:<workerId>']`
 *   and env `{ ...process.env, ORCH_JOB_SLUG: workerSlug,
 *   ORCH_DETACHED: '1', ORCH_FANOUT_DEPTH: '1' }`, `cwd: <repo root>`,
 *   `detached: true`, `stdio: ['ignore', logFd, logFd]` — the exact
 *   `runDetached` shape — then patches the child's own `run.json` with
 *   `{ pid: child.pid, state: 'running' }`. **Never** appends `--fan-out` to
 *   a child (decision 3, depth 1). The coordinator never calls
 *   `runWorkerPipeline`/`runIntegratePipeline` in-process (decision 4) — it
 *   always spawns a separate `orch` process per child.
 * - **Concurrency**: `planLayers(workers)` groups by `dependsOn`;
 *   `chooseConcurrency({ layerSize, maxConcurrency })` bounds how many
 *   workers within a layer are in flight at once; as each settles, the next
 *   pending worker in that layer (if any) is started.
 * - **Dependency handling**: a worker whose `dependsOn` entry ended `failed`
 *   (including a crash reconciled to `failed`) is patched to
 *   `state: 'skipped'` via `patchWorker` and is never spawned.
 * - **Polling**: every live child's `run.json` is polled via `reconcileJob`
 *   at `pollIntervalMs`; a dead pid without a terminal state reconciles to
 *   `crashed`, which the coordinator treats as `failed` for scheduling and
 *   exit-code purposes (patching the worker's `fanout.json` entry to
 *   `failed` itself, since a crashed child never got to self-patch).
 * - **Overlap + integration candidates**: once every worker has settled, the
 *   coordinator does NOT re-derive `changedFiles` (workers already record
 *   their own via `recordChangedFiles` before self-patching to `done`); it
 *   runs `detectOverlaps` over the `done` workers and sets
 *   `integration.candidates` to their branches in order. If no worker
 *   reached `done`, integration is never spawned and the coordinator exits
 *   non-zero.
 * - **Spawning integration**: identical shape to a worker spawn, with
 *   `--integrate <jobSlug>` in place of `--worker <parent>:<id>` and
 *   `fanout.task` as the prompt; polled the same way to a terminal state.
 * - **Exit codes**: `0` only when every worker reached `done` and
 *   `integration.state === 'done'` with a non-null `sha`; any worker
 *   `failed` forces a non-zero exit even when integration still commits
 *   (decision 6).
 *
 * `cascadeStopFanoutChildren(cwd, parentSlug, { kill, isPidAlive } = {})` —
 * the SIGINT/SIGHUP/SIGTERM cascade helper: reads `fanout.json`, resolves
 * each worker's (and the integration session's) live pid via its own
 * `run.json` (`readJob(cwd, slug).pid`), filtered through the injectable
 * `isPidAlive` (default the real `lib/jobs.js` implementation), and sends
 * `'SIGTERM'` to each via the injectable `kill` (default
 * `(pid, signal) => process.kill(pid, signal)`) — the same shape
 * `lib/jobs.js`'s `stopJob` uses. It never touches worktrees. This composes
 * with (does not replace) `lib/agent.js`'s existing `shutdown()` — the
 * coordinator's own SIGINT/SIGHUP/SIGTERM handling calls both.
 *
 * `--fan-out --detach` / `runDetached({ fanOut })`: Serve’s tick path starts
 * jobs via detach. Fan-out must spawn a detached coordinator with `--fan-out`
 * (optional `--max-workers` / `--max-concurrency`), no `--detach` on the
 * child, ORCH_JOB_SLUG, role coordinator — not the former in-process
 * allocate+run short-circuit before the detach branch.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
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

/** Fake `execFile` for `git rev-parse HEAD` at the fan-out's base resolution step. */
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

/** Strip an optional ` k/N` round suffix from an agent spinner name. */
function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

/** Same mock-AgentClass-by-role pattern as test/fanout-children.test.js / test/main.test.js. */
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

const TRIAGE_SIMPLE = { ok: true, result: withSummary(JSON.stringify({ simple: true, why: 'tiny fix', fix_plan: 'fix the typo' }), 'triage ok') };
const TRIAGE_COMPLEX = { ok: true, result: withSummary(JSON.stringify({ simple: false, why: 'needs research and a split' }), 'triage ok') };
const BOUNDARIES_OK = { ok: true, result: withSummary('boundaries-output: scaffold + 2 parallel endpoint workers', 'boundaries ok') };
const QUICK_FIX_OK = { ok: true, result: withSummary('fixed the typo', 'quick-fix ok') };
const PASS_CRITIC = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), 'critic ok') };
const PASS_RUNNER = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), 'runner ok') };

function declineReply(why = 'the task is a single tightly-coupled change with no independent seams') {
  return { ok: true, result: withSummary(JSON.stringify({ decomposable: false, why }), 'decomposer ok') };
}

function decomposeReply(workers, why = 'independent endpoints') {
  return { ok: true, result: withSummary(JSON.stringify({ decomposable: true, why, workers }), 'decomposer ok') };
}

const ONE_WORKER_REPLY = decomposeReply([
  { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
]);

function threeWorkerScaffoldSet() {
  return [
    { id: '01-scaffold', title: 'shared scaffold', subtask: 'Pre-register shared registries, barrels, and stubs.', area: 'src/billing/', owns: ['src/billing/types.ts'], dependsOn: [], scaffold: true },
    { id: '02-invoices', title: 'invoice endpoints', subtask: 'Implement invoice endpoints.', area: 'src/billing/invoices/', owns: ['src/billing/invoices/'], dependsOn: ['01-scaffold'], scaffold: false },
    { id: '03-charges', title: 'charge endpoints', subtask: 'Implement charge endpoints.', area: 'src/billing/charges/', owns: ['src/billing/charges/'], dependsOn: ['01-scaffold'], scaffold: false },
  ];
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

/** Deterministic 40-hex-char-shaped fake sha for a given worker id. */
function fakeSha(workerId) {
  return `${workerId}0000000000000000000000000000000000000`.slice(0, 40);
}

function seedCoordinatorJob(cwd, jobSlug, overrides = {}) {
  writeJob(cwd, jobSlug, {
    slug: jobSlug,
    task: 'implement the billing module',
    agent: 'claude',
    maxRounds: 5,
    cwd,
    pauseRequested: false,
    branch: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logPath: path.join(cwd, '.orch', jobSlug, 'orch.log'),
    pid: process.pid,
    state: 'running',
    phase: null,
    stage: null,
    round: null,
    parent: null,
    role: 'coordinator',
    workerId: null,
    ...overrides,
  });
}

/**
 * A single fake `spawn` that drives every worker/integration child spawned
 * during a test: it inspects `--worker <parent>:<id>` / `--integrate
 * <parent>` in the child argv, then schedules a real `patchJob` (the child's
 * own run.json) + real `patchWorker`/`patchIntegration` (fanout.json) after
 * `delayMs`, exactly like a real detached child eventually would — so the
 * coordinator's real `reconcileJob`-based poll loop observes the transition
 * naturally. `outcomes` maps workerId -> 'done' | 'failed' | 'crash'.
 * `integrationOutcome` is 'done' | 'failed' | undefined (not reached).
 */
function fakeChildSpawn({ cwd, parentSlug, outcomes = {}, integrationOutcome, delayMs = 15 }) {
  let pid = 900000;
  let active = 0;
  let maxActive = 0;
  const calls = [];

  const spawnFn = mock.fn((command, args, options) => {
    const thisPid = pid++;
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ command, args, options, pid: thisPid });

    const workerIdx = args.indexOf('--worker');
    const integrateIdx = args.indexOf('--integrate');

    if (workerIdx !== -1) {
      const [, workerId] = args[workerIdx + 1].split(':');
      const workerSlug = options.env.ORCH_JOB_SLUG;
      const outcome = outcomes[workerId] ?? 'done';
      if (outcome !== 'crash') {
        setTimeout(() => {
          active -= 1;
          patchJob(cwd, workerSlug, {
            state: outcome === 'done' ? 'done' : 'failed',
            exitCode: outcome === 'done' ? 0 : 1,
            finishedAt: new Date().toISOString(),
          });
          if (outcome === 'done') {
            patchWorker(cwd, parentSlug, workerId, {
              state: 'done',
              sha: fakeSha(workerId),
              changedFiles: [`src/${workerId}.ts`],
            });
          } else {
            patchWorker(cwd, parentSlug, workerId, { state: 'failed' });
          }
        }, delayMs);
      }
      // 'crash': leave run.json at state:'running' with a pid that (almost
      // certainly) is not alive — reconcileJob's poll tick discovers this.
    } else if (integrateIdx !== -1) {
      const integrationSlug = options.env.ORCH_JOB_SLUG;
      setTimeout(() => {
        active -= 1;
        patchJob(cwd, integrationSlug, {
          state: integrationOutcome === 'done' ? 'done' : 'failed',
          exitCode: integrationOutcome === 'done' ? 0 : 1,
          finishedAt: new Date().toISOString(),
        });
        patchIntegration(cwd, parentSlug, integrationOutcome === 'done'
          ? { state: 'done', sha: 'integrationsha00000000000000000000000' }
          : { state: 'failed' });
      }, delayMs);
    }

    return { pid: thisPid, unref: () => {} };
  });

  return { spawnFn, calls, maxActive: () => maxActive };
}

/** Deterministic `allocateJob` wrapping the real (synchronous) implementation with a slug derived from workerId/role. */
function makeDeterministicAllocateJob() {
  return mock.fn((opts) => {
    const generateSlug = () => (opts.role === 'integration' ? 'tidy-heron-m2p9' : `${opts.workerId}-slug`);
    return realAllocateJob({ ...opts, generateSlug });
  });
}

describe('runFanoutPipeline — triage short-circuit (decision 7: quick-fix never fans out)', () => {
  it('simple:true routes straight to quick-fix; no boundaries/decomposer agents, no fanout.json', async () => {
    const cwd = makeTmpCwd('orch-fanout-quickfix-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);

    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_SIMPLE, 'quick-fix': QUICK_FIX_OK });
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('fix the typo', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(MockAgentClass.instances.map((i) => agentRole(i.name)), ['triage', 'quick-fix']);
    assert.equal(readFanout(cwd, jobSlug), null);
    assert.equal(readJob(cwd, jobSlug).state, 'done');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] === 0));
  });
});

describe('runFanoutPipeline — boundaries + decomposer + validation repair loop', () => {
  it('runs boundaries exactly once and passes its output to decomposer in-memory', async () => {
    const cwd = makeTmpCwd('orch-fanout-boundaries-once-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(threeWorkerScaffoldSet()),
    });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: {}, integrationOutcome: 'done' });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 10,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const boundariesInstances = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'boundaries');
    assert.equal(boundariesInstances.length, 1);
    assert.equal(boundariesInstances[0].options.cwd, cwd);
    assert.ok(
      boundariesInstances[0].instructions.includes(path.join(cwd, '.orch', jobSlug, 'boundaries.md')),
      'expected boundaries agent to be told to write to .orch/<jobSlug>/boundaries.md',
    );
    const decomposerInstance = MockAgentClass.instances.find((i) => agentRole(i.name) === 'decomposer');
    assert.ok(decomposerInstance.instructions.includes('boundaries-output'), 'expected boundariesOutput interpolated in-memory into the decomposer instructions');
  });

  it('repairs an invalid decomposition once, then succeeds on the second decomposer attempt', async () => {
    const cwd = makeTmpCwd('orch-fanout-repair-succeed-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: [ONE_WORKER_REPLY, decomposeReply(threeWorkerScaffoldSet())],
    });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: {}, integrationOutcome: 'done' });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 10,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const decomposerInstances = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'decomposer');
    assert.equal(decomposerInstances.length, 2, 'expected exactly one repair round-trip');
    assert.match(decomposerInstances[1].instructions, /\[Validation Feedback\]/);
    assert.match(decomposerInstances[1].instructions, /fewer than two workers/i);

    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.length, 3);
  });

  it('after two repair round-trips still invalid, falls through to the decline path without ever writing fanout.json', async () => {
    const cwd = makeTmpCwd('orch-fanout-repair-exhaust-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: ONE_WORKER_REPLY,
      research: { ok: true, result: withSummary('research-output', 'research ok') },
      planner: { ok: true, result: withSummary('planner-output', 'planner ok') },
      'test-writer': { ok: true, result: withSummary('tests written', 'writer ok') },
      'test-critic': PASS_CRITIC,
      'code-writer': { ok: true, result: withSummary('implemented', 'code ok') },
      'test-runner': PASS_RUNNER,
    });

    const worktree = fakeWorktree(cwd, jobSlug);
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        createRunContext: mock.fn(() => ({
          slug: jobSlug,
          artifactDir: path.join(cwd, '.orch', jobSlug),
          researchPath: path.join(cwd, '.orch', jobSlug, 'research.md'),
          taskPath: path.join(cwd, '.orch', jobSlug, 'task.md'),
          statusPath: path.join(cwd, '.orch', jobSlug, 'status.md'),
        })),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        collectWorktreeChanges: mock.fn(() => null),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    const decomposerInstances = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'decomposer');
    assert.equal(decomposerInstances.length, 3, 'expected initial attempt + two repair round-trips');

    assert.equal(readFanout(cwd, jobSlug), null, 'no fanout.json should ever be written on the decline path');
    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['triage', 'boundaries', 'decomposer', 'decomposer', 'decomposer', 'research', 'planner', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] === 0));
  });
});

describe('runFanoutPipeline — decline path (decomposable:false falls to single-worktree pipeline)', () => {
  it('runs research → planner → worktree → test loop → code loop → commit in the coordinator\'s own job directory; no workers scheduled', async () => {
    const cwd = makeTmpCwd('orch-fanout-decline-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: declineReply(),
      research: { ok: true, result: withSummary('research-output', 'research ok') },
      planner: { ok: true, result: withSummary('planner-output', 'planner ok') },
      'test-writer': { ok: true, result: withSummary('tests written', 'writer ok') },
      'test-critic': PASS_CRITIC,
      'code-writer': { ok: true, result: withSummary('implemented', 'code ok') },
      'test-runner': PASS_RUNNER,
    });

    const worktree = fakeWorktree(cwd, jobSlug);
    const createWorktreeMock = mock.fn(() => worktree);
    const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        createRunContext: mock.fn(() => ({
          slug: jobSlug,
          artifactDir: path.join(cwd, '.orch', jobSlug),
          researchPath: path.join(cwd, '.orch', jobSlug, 'research.md'),
          taskPath: path.join(cwd, '.orch', jobSlug, 'task.md'),
          statusPath: path.join(cwd, '.orch', jobSlug, 'status.md'),
        })),
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
        collectWorktreeChanges: mock.fn(() => null),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['triage', 'boundaries', 'decomposer', 'research', 'planner', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
    assert.equal(createWorktreeMock.mock.calls.length, 1);
    assert.equal(createWorktreeMock.mock.calls[0].arguments[0].slug, jobSlug);
    assert.equal(commitWorktreeMock.mock.calls.length, 1);
    assert.equal(readFanout(cwd, jobSlug), null);
    assert.equal(readJob(cwd, jobSlug).state, 'done');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] === 0));
  });
});

describe('runFanoutPipeline — fanout.json bootstrap on successful validation', () => {
  it('writes the full fanout.json schema, keyed by the coordinator\'s own jobSlug as parentSlug, and never gives the coordinator a worktree', async () => {
    const cwd = makeTmpCwd('orch-fanout-bootstrap-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const base = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: `${base}\n` },
    ]);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      // Non-scaffold set so fanout.json.base stays the bootstrap git HEAD
      // (a scaffold success rewrites base — covered by the scaffold-first suite).
      decomposer: decomposeReply([
        { id: '02-invoices', title: 'invoice endpoints', subtask: 'Implement invoice endpoints.', area: 'src/billing/invoices/', owns: ['src/billing/invoices/'], dependsOn: [], scaffold: false },
        { id: '03-charges', title: 'charge endpoints', subtask: 'Implement charge endpoints.', area: 'src/billing/charges/', owns: ['src/billing/charges/'], dependsOn: [], scaffold: false },
      ]),
    });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: {}, integrationOutcome: 'done' });
    const createWorktreeMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        maxConcurrency: 2,
        pollIntervalMs: 10,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        createWorktree: createWorktreeMock,
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const doc = readFanout(cwd, jobSlug);
    assert.ok(doc, 'expected fanout.json to exist');
    assert.equal(doc.parentSlug, jobSlug);
    assert.equal(doc.task, 'implement the billing module');
    assert.equal(doc.base, base);
    assert.equal(doc.maxWorkers, 4);
    assert.equal(doc.maxConcurrency, 2);
    assert.equal(typeof doc.concurrency, 'number');
    assert.equal(doc.workers.length, 2);
    assert.deepEqual(Object.keys(doc).sort(), [
      'base', 'concurrency', 'finishedAt', 'integration', 'maxConcurrency',
      'maxWorkers', 'parentSlug', 'startedAt', 'state', 'task', 'workers',
    ]);

    assert.equal(createWorktreeMock.mock.calls.length, 0, 'the coordinator must never create its own worktree');
    const coordinatorRecord = readJob(cwd, jobSlug);
    assert.equal(coordinatorRecord.branch, null);
    assert.equal(coordinatorRecord.worktree, null);
    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['triage', 'boundaries', 'decomposer'],
      'implementer stages (research/planner/test-writer/test-critic/code-writer/test-runner) must never run in-process for a validated fan-out',
    );
  });
});

describe('runFanoutPipeline — scaffold-first', () => {
  it('spawns the scaffold worker alone; on success replaces fanout.json.base with its sha before any parallel worker starts', async () => {
    const cwd = makeTmpCwd('orch-fanout-scaffold-success-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(threeWorkerScaffoldSet()),
    });
    const { spawnFn, calls } = fakeChildSpawn({
      cwd, parentSlug: jobSlug, outcomes: { '01-scaffold': 'done', '02-invoices': 'done', '03-charges': 'done' }, integrationOutcome: 'done', delayMs: 20,
    });

    const logSpy = mock.method(console, 'log', () => {});
    const runPromise = runFanoutPipeline('implement the billing module', {
      agent: 'claude',
      AgentClass: MockAgentClass,
      cwd,
      jobSlug,
      jobCwd: cwd,
      maxWorkers: 4,
      pollIntervalMs: 5,
      execFile,
      spawn: spawnFn,
      allocateJob: makeDeterministicAllocateJob(),
      exit: mock.fn(),
    });

    // Checkpoint before the scaffold's delayMs has elapsed: only the scaffold
    // should have been spawned so far — the two parallel workers must wait
    // for it to settle.
    await sleep(10);
    assert.equal(calls.length, 1, 'the scaffold worker must run alone before any parallel worker is spawned');
    assert.match(calls[0].args.join(' '), /--worker wise-pine-e904:01-scaffold/);

    try {
      await runPromise;
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(calls.length, 4, 'scaffold + 2 parallel workers + integrate');
    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.base, fakeSha('01-scaffold'));
  });

  it('aborts the whole fan-out before any parallel worker spawns when the scaffold worker fails, and exits non-zero', async () => {
    const cwd = makeTmpCwd('orch-fanout-scaffold-fail-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(threeWorkerScaffoldSet()),
    });
    const { spawnFn, calls } = fakeChildSpawn({
      cwd, parentSlug: jobSlug, outcomes: { '01-scaffold': 'failed' }, delayMs: 10,
    });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(calls.length, 1, 'no parallel worker or integration should ever be spawned after a failed scaffold');
    assert.ok(!calls.some((c) => c.args.includes('--integrate')));
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0));
  });
});

describe('runFanoutPipeline — spawn mechanics (envelopes, hidden flags, env, repo-root cwd)', () => {
  it('spawns a worker with the envelope-appended prompt, --worker <parent>:<id>, fan-out env vars, repo-root cwd, and never --fan-out', async () => {
    const cwd = makeTmpCwd('orch-fanout-spawn-mechanics-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a workers', subtask: 'Implement invoice endpoints.', area: 'src/billing/invoices/', owns: ['src/billing/invoices/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b worker', subtask: 'Implement charge endpoints.', area: 'src/billing/charges/', owns: ['src/billing/charges/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn, calls } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'done' }, integrationOutcome: 'done', delayMs: 10 });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('implement the billing module', {
        agent: 'claude',
        maxRounds: 3,
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const workerCall = calls.find((c) => c.args.includes('--worker'));
    assert.ok(workerCall, 'expected at least one --worker spawn');
    assert.equal(workerCall.command, process.execPath);
    assert.ok(!workerCall.args.includes('--fan-out'), 'a worker must never receive --fan-out (decision 3, depth 1)');
    assert.ok(workerCall.args.includes('--agent'));
    assert.ok(workerCall.args.includes('claude'));
    assert.ok(workerCall.args.includes('--max-rounds'));
    assert.ok(workerCall.args.includes('3'));
    const workerFlagIdx = workerCall.args.indexOf('--worker');
    assert.match(workerCall.args[workerFlagIdx + 1], /^wise-pine-e904:[ab]$/);
    assert.ok(
      workerCall.args.some((a) => a.includes('Implement invoice endpoints.') || a.includes('Implement charge endpoints.')),
      'expected the subtask + worker envelope as the prompt argv',
    );
    assert.ok(
      workerCall.args.some((a) => a.includes('parallel orch run')),
      'expected the worker envelope wording to be present',
    );

    assert.equal(workerCall.options.cwd, cwd, 'children must run with cwd at the repo root, never a worktree');
    assert.equal(workerCall.options.detached, true);
    assert.equal(workerCall.options.stdio[0], 'ignore');
    assert.equal(typeof workerCall.options.stdio[1], 'number');
    assert.equal(workerCall.options.stdio[1], workerCall.options.stdio[2]);
    assert.equal(workerCall.options.env.ORCH_DETACHED, '1');
    assert.equal(workerCall.options.env.ORCH_FANOUT_DEPTH, '1');
    assert.match(workerCall.options.env.ORCH_JOB_SLUG, /-slug$/);

    const integrateCall = calls.find((c) => c.args.includes('--integrate'));
    assert.ok(integrateCall);
    assert.ok(!integrateCall.args.includes('--fan-out'));
    const integrateFlagIdx = integrateCall.args.indexOf('--integrate');
    assert.equal(integrateCall.args[integrateFlagIdx + 1], jobSlug);
    assert.equal(integrateCall.options.env.ORCH_FANOUT_DEPTH, '1');
    assert.equal(integrateCall.options.cwd, cwd);
  });
});

describe('runFanoutPipeline — layered concurrency scheduling', () => {
  it('never exceeds maxConcurrency in-flight workers within a layer, and eventually spawns every one of them', async () => {
    const cwd = makeTmpCwd('orch-fanout-concurrency-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = ['a', 'b', 'c'].map((id) => (
      { id, title: id, subtask: `do ${id}`, area: `src/${id}/`, owns: [`src/${id}/`], dependsOn: [], scaffold: false }
    ));
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn, calls, maxActive } = fakeChildSpawn({
      cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'done', c: 'done' }, integrationOutcome: 'done', delayMs: 25,
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do three independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        maxConcurrency: 2,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const workerCalls = calls.filter((c) => c.args.includes('--worker'));
    assert.equal(workerCalls.length, 3, 'all three same-layer workers must eventually be spawned');
    assert.ok(maxActive() <= 2, `expected at most 2 in-flight workers at once, saw ${maxActive()}`);

    const doc = readFanout(cwd, jobSlug);
    assert.deepEqual(doc.workers.map((w) => w.state).sort(), ['done', 'done', 'done']);
  });
});

describe('runFanoutPipeline — dependency handling', () => {
  it('skips a worker whose dependency failed (state:"skipped", never spawned), and still integrates the workers that succeeded', async () => {
    const cwd = makeTmpCwd('orch-fanout-dep-skip-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b (depends on a)', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: false },
      { id: 'c', title: 'c', subtask: 'do c', area: 'src/c/', owns: ['src/c/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn, calls } = fakeChildSpawn({
      cwd, parentSlug: jobSlug, outcomes: { a: 'failed', c: 'done' }, integrationOutcome: 'done', delayMs: 10,
    });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do three things, b depends on a', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(!calls.some((c) => c.args.includes('--worker') && c.args.some((a) => a.endsWith(':b'))), 'worker b must never be spawned');

    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'failed');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'skipped');
    assert.equal(doc.workers.find((w) => w.id === 'c').state, 'done');

    // A failed worker forces a non-zero exit even though integration still ran on the green subset.
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0));
  });

  it('reconciles a crashed worker (dead pid, no terminal state) to "failed" for scheduling purposes', async () => {
    const cwd = makeTmpCwd('orch-fanout-crash-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b (depends on a)', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn, calls } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'crash' }, delayMs: 10 });
    const exitMock = mock.fn();

    const reconcileJobMock = mock.fn((jobCwd, slug, record) => {
      if (record.state === 'running' && slug === 'a-slug') {
        return { ...record, state: 'crashed', finishedAt: new Date().toISOString(), exitCode: null };
      }
      return record;
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two things, b depends on a', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        reconcileJob: reconcileJobMock,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(!calls.some((c) => c.args.includes('--worker') && c.args.some((a) => a.endsWith(':b'))), 'worker b must never be spawned once a is treated as failed');
    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'failed');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'skipped');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0));
  });
});

describe('runFanoutPipeline — no green workers', () => {
  it('skips integration entirely and exits non-zero when every worker failed', async () => {
    const cwd = makeTmpCwd('orch-fanout-no-green-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn, calls } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'failed', b: 'failed' }, delayMs: 10 });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(!calls.some((c) => c.args.includes('--integrate')), 'integration must never be spawned when no worker reached done');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0));
  });
});

describe('runFanoutPipeline — exit codes', () => {
  it('exits 0 when every worker succeeded and integration committed (state:"done" with a sha)', async () => {
    const cwd = makeTmpCwd('orch-fanout-exit-zero-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'done' }, integrationOutcome: 'done', delayMs: 10 });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(exitMock.mock.calls.map((c) => c.arguments[0]), [0]);
    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.integration.state, 'done');
    assert.ok(doc.integration.sha);
  });

  it('exits non-zero when any worker failed, even though integration still committed on the green subset', async () => {
    const cwd = makeTmpCwd('orch-fanout-exit-nonzero-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'failed' }, integrationOutcome: 'done', delayMs: 10 });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.integration.state, 'done');
    assert.ok(doc.integration.sha, 'integration still committed on the green subset');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0), 'exit must be non-zero because worker b failed');
  });
});

describe('runFanoutPipeline — overlap detection + integration candidates', () => {
  it('sets integration.candidates to the done workers\' branches in order, without re-deriving changedFiles', async () => {
    const cwd = makeTmpCwd('orch-fanout-overlaps-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'done' }, integrationOutcome: 'done', delayMs: 10 });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    const doc = readFanout(cwd, jobSlug);
    assert.deepEqual(doc.integration.candidates, ['orch/a-slug', 'orch/b-slug']);
    // The coordinator must not overwrite what the worker children already
    // self-recorded via recordChangedFiles/patchWorker.
    assert.deepEqual(doc.workers.find((w) => w.id === 'a').changedFiles, ['src/a.ts']);
    assert.deepEqual(doc.workers.find((w) => w.id === 'b').changedFiles, ['src/b.ts']);
  });
});

describe('--fan-out CLI flags and guards', () => {
  it('documents --fan-out, --max-workers, and --max-concurrency in --help output', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--fan-out/);
    assert.match(stdout, /--max-workers/);
    assert.match(stdout, /--max-concurrency/);
  });

  for (const conflicting of ['--ask', '--quick', '--dry-run']) {
    it(`rejects --fan-out combined with ${conflicting} (non-zero exit, no fanout.json created)`, async () => {
      const cwd = makeTmpCwd('orch-fanout-guard-');
      try {
        const { code, stderr } = await runCli(['a trivial task', '--fan-out', conflicting], { cwd });
        assert.notEqual(code, 0);
        assert.match(stderr, /fan-out/i);
        assert.equal(fs.existsSync(path.join(cwd, '.orch')), false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it('rejects --fan-out when ORCH_FANOUT_DEPTH is already set in the environment', async () => {
    const cwd = makeTmpCwd('orch-fanout-depth-guard-');
    try {
      const { code, stderr } = await runCli(
        ['a trivial task', '--fan-out'],
        { cwd, env: { ...process.env, ORCH_FANOUT_DEPTH: '1' } },
      );
      assert.notEqual(code, 0);
      assert.match(stderr, /fan-out|depth/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive-integer --max-workers / --max-concurrency the same way --max-rounds does', async () => {
    for (const flag of ['--max-workers', '--max-concurrency']) {
      const { code, stderr } = await runCli(['a trivial task', '--fan-out', flag, '0']);
      assert.notEqual(code, 0);
      assert.match(stderr, /must be a positive integer/);
    }
  });
});

describe('--fan-out --detach', () => {
  function fakeDetachSpawn(pid) {
    return mock.fn(() => ({ pid, unref: () => {} }));
  }

  it('spawns a detached coordinator child with --fan-out (no --detach), ORCH_JOB_SLUG, and role coordinator', async () => {
    // Serve starts jobs via runDetached; fan-out must not short-circuit to
    // in-process allocate+run before the detach branch. runDetached({ fanOut })
    // must forward --fan-out (and optional max-workers / max-concurrency) and
    // allocate the parent as role:"coordinator" — mirroring --seq --detach.
    // CLI `--fan-out --detach` must call this same path (not runFanoutPipeline
    // in-process); pinned here via the injectable spawn seam.
    const cwd = makeTmpCwd('orch-fanout-detach-spawn-');
    const spawnMock = fakeDetachSpawn(65433);
    const exit = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('implement the billing module', {
        agent: 'claude',
        maxRounds: 5,
        fanOut: true,
        maxWorkers: 6,
        maxConcurrency: 3,
        cwd,
        spawn: spawnMock,
        exit,
      });

      assert.equal(spawnMock.mock.calls.length, 1, 'must spawn exactly one detached coordinator child');
      const [command, args, spawnOptions] = spawnMock.mock.calls[0].arguments;
      assert.equal(command, process.execPath);
      assert.ok(args.includes('implement the billing module'));
      assert.ok(args.includes('--fan-out'), 'child must receive --fan-out so it enters runFanoutPipeline');
      assert.ok(args.includes('--max-workers'));
      assert.ok(args.includes('6'));
      assert.ok(args.includes('--max-concurrency'));
      assert.ok(args.includes('3'));
      assert.ok(!args.includes('--detach'), 'child must not receive --detach (would spawn a grandchild)');
      assert.ok(!args.includes('--seq'));

      assert.equal(spawnOptions.detached, true);
      assert.equal(spawnOptions.env.ORCH_DETACHED, '1');
      assert.match(spawnOptions.env.ORCH_JOB_SLUG, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

      const slug = spawnOptions.env.ORCH_JOB_SLUG;
      const record = readJob(cwd, slug);
      assert.equal(record.role, 'coordinator');
      assert.equal(record.pid, 65433);
      assert.equal(record.state, 'running');
      assert.equal(exit.mock.calls[0].arguments[0], 0);
    } finally {
      logSpy.mock.restore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('cascadeStopFanoutChildren — SIGTERM cascade to every live child pid in fanout.json', () => {
  it('signals only the live, non-terminal workers and the integration session, skipping terminal ones', () => {
    const cwd = makeTmpCwd('orch-fanout-cascade-unit-');
    const parentSlug = 'wise-pine-e904';
    writeFanout(cwd, parentSlug, {
      parentSlug,
      task: 'implement the billing module',
      base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      maxWorkers: 4,
      maxConcurrency: null,
      concurrency: 2,
      state: 'running',
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false, slug: 'a-slug', branch: 'orch/a-slug', state: 'running', sha: null, changedFiles: [], overlaps: [] },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false, slug: 'b-slug', branch: 'orch/b-slug', state: 'done', sha: 'x', changedFiles: [], overlaps: [] },
      ],
      integration: { slug: 'tidy-heron-m2p9', pid: 55555, branch: null, worktree: null, candidates: [], merged: [], skipped: [], overlappingFiles: [], state: 'merging', sha: null },
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
    });
    writeJob(cwd, 'a-slug', { slug: 'a-slug', pid: 11111, state: 'running', parent: parentSlug, role: 'worker', workerId: 'a' });
    writeJob(cwd, 'b-slug', { slug: 'b-slug', pid: 22222, state: 'done', parent: parentSlug, role: 'worker', workerId: 'b' });
    writeJob(cwd, 'tidy-heron-m2p9', { slug: 'tidy-heron-m2p9', pid: 55555, state: 'running', parent: parentSlug, role: 'integration' });

    const signaled = [];
    const kill = mock.fn((pid, signal) => signaled.push({ pid, signal }));
    // Force isPidAlive to treat 11111/55555 as alive and 22222 as dead, without depending on real OS pids.
    const isPidAliveMock = (pid) => pid === 11111 || pid === 55555;

    cascadeStopFanoutChildren(cwd, parentSlug, { kill, isPidAlive: isPidAliveMock });

    assert.deepEqual(signaled.sort((x, y) => x.pid - y.pid), [
      { pid: 11111, signal: 'SIGTERM' },
      { pid: 55555, signal: 'SIGTERM' },
    ]);
  });

  it('actually terminates real live child processes recorded under a fan-out', async () => {
    const cwd = makeTmpCwd('orch-fanout-cascade-real-');
    const parentSlug = 'wise-pine-e904';

    const stub = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const workerChild = stub();
    const integrateChild = stub();
    workerChild.unref();
    integrateChild.unref();

    writeFanout(cwd, parentSlug, {
      parentSlug,
      task: 'implement the billing module',
      base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      maxWorkers: 4,
      maxConcurrency: null,
      concurrency: 1,
      state: 'running',
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false, slug: 'a-slug', branch: 'orch/a-slug', state: 'running', sha: null, changedFiles: [], overlaps: [] },
      ],
      integration: { slug: 'tidy-heron-m2p9', pid: integrateChild.pid, branch: null, worktree: null, candidates: [], merged: [], skipped: [], overlappingFiles: [], state: 'merging', sha: null },
      startedAt: new Date(0).toISOString(),
      finishedAt: null,
    });
    writeJob(cwd, 'a-slug', { slug: 'a-slug', pid: workerChild.pid, state: 'running', parent: parentSlug, role: 'worker', workerId: 'a' });
    writeJob(cwd, 'tidy-heron-m2p9', { slug: 'tidy-heron-m2p9', pid: integrateChild.pid, state: 'running', parent: parentSlug, role: 'integration' });

    function pidAlive(pid) {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }
    function waitFor(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate()) return resolve();
          if (Date.now() - started > timeoutMs) return reject(new Error(`timed out after ${timeoutMs}ms`));
          setTimeout(tick, intervalMs);
        };
        tick();
      });
    }

    assert.equal(pidAlive(workerChild.pid), true);
    assert.equal(pidAlive(integrateChild.pid), true);

    cascadeStopFanoutChildren(cwd, parentSlug);

    await waitFor(() => !pidAlive(workerChild.pid) && !pidAlive(integrateChild.pid));
    assert.equal(pidAlive(workerChild.pid), false);
    assert.equal(pidAlive(integrateChild.pid), false);
  });
});

/**
 * Task.md section 5's actual gap: it's not enough for `cascadeStopFanoutChildren`
 * to work in isolation (covered above) — `runFanoutPipeline` itself must wire a
 * SIGINT/SIGTERM/SIGHUP handler that calls it, that handler must compose with (not
 * replace) whatever `lib/agent.js`'s existing shutdown machinery already
 * registered, and the coordinator must not double-register the same signal via
 * `process.once`. These tests capture whatever handler(s) `runFanoutPipeline`
 * registers via `process.on`/`process.once` while a fan-out is genuinely
 * mid-flight (two real, never-completing stub child processes standing in for
 * workers, exactly like the "actually terminates real live child processes"
 * `cascadeStopFanoutChildren` test above), then invoke the captured handler
 * directly and synchronously — the same technique test/interrupt.test.js uses
 * for `shutdown()` — instead of sending a real OS signal.
 */
describe('runFanoutPipeline — interrupt wiring (composes with lib/agent.js shutdown, no double-registration)', () => {
  it('adds exactly one new SIGINT/SIGTERM/SIGHUP listener per signal without removing a pre-existing shutdown listener, and invoking the SIGTERM one cascades a real SIGTERM to every live worker and exits with exitCodeForSignal("SIGTERM")', async () => {
    const cwd = makeTmpCwd('orch-fanout-interrupt-wiring-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });

    // Real, never-completing stub children (never patched to done/failed) so a
    // real SIGTERM actually has something live to kill — mirrors the existing
    // "actually terminates real live child processes" cascadeStopFanoutChildren
    // test, but driven through runFanoutPipeline's own spawn seam.
    const workerChildren = [];
    const spawnFn = mock.fn(() => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      workerChildren.push(child);
      return { pid: child.pid, unref: () => {} };
    });

    // Stand-ins for whatever lib/agent.js's registerShutdownHandlers() would
    // already have installed in production (triggered by the first real Agent
    // construction, e.g. triage) — proves the coordinator's own wiring adds to
    // this rather than clobbering it.
    const preexisting = { SIGINT: mock.fn(), SIGTERM: mock.fn(), SIGHUP: mock.fn() };
    for (const sig of Object.keys(preexisting)) process.once(sig, preexisting[sig]);
    const baseline = Object.fromEntries(Object.keys(preexisting).map((sig) => [sig, process.listenerCount(sig)]));

    const exitMock = mock.fn();
    const onSpy = mock.method(process, 'on');
    const onceSpy = mock.method(process, 'once');

    const logSpy = mock.method(console, 'log', () => {});
    const runPromise = runFanoutPipeline('do two independent things', {
      agent: 'claude',
      AgentClass: MockAgentClass,
      cwd,
      jobSlug,
      jobCwd: cwd,
      maxWorkers: 4,
      pollIntervalMs: 5,
      execFile,
      spawn: spawnFn,
      allocateJob: makeDeterministicAllocateJob(),
      exit: exitMock,
    });

    let newHandlers;
    try {
      await waitFor(() => workerChildren.length === 2 && workerChildren.every((c) => pidAlive(c.pid)));

      onSpy.mock.restore();
      onceSpy.mock.restore();

      const registrations = [...onSpy.mock.calls, ...onceSpy.mock.calls]
        .map((c) => ({ signal: c.arguments[0], handler: c.arguments[1] }))
        .filter((r) => r.signal === 'SIGINT' || r.signal === 'SIGTERM' || r.signal === 'SIGHUP')
        .filter((r) => r.handler !== preexisting[r.signal]);

      for (const sig of Object.keys(preexisting)) {
        const forSignal = registrations.filter((r) => r.signal === sig);
        assert.equal(forSignal.length, 1, `expected runFanoutPipeline to register exactly one new ${sig} listener`);
        assert.equal(
          process.listenerCount(sig),
          baseline[sig] + 1,
          `runFanoutPipeline's ${sig} wiring must add a listener alongside the pre-existing one, not replace it`,
        );
      }

      newHandlers = Object.fromEntries(
        Object.keys(preexisting).map((sig) => [sig, registrations.find((r) => r.signal === sig).handler]),
      );

      // Invoke directly, synchronously — no real OS signal — same technique
      // test/interrupt.test.js uses to call shutdown() as a plain function.
      newHandlers.SIGTERM('SIGTERM');

      await waitFor(() => workerChildren.every((c) => !pidAlive(c.pid)));
      assert.ok(
        workerChildren.every((c) => !pidAlive(c.pid)),
        'expected the cascade to SIGTERM every live worker pid recorded under the fan-out',
      );

      await runPromise;
      assert.ok(
        exitMock.mock.calls.some((c) => c.arguments[0] === exitCodeForSignal('SIGTERM')),
        'expected the coordinator to eventually exit with exitCodeForSignal("SIGTERM") (143) after the interrupt',
      );

      // lastOutcome capture (task.md section 1, the 4th of the 4 named
      // terminal-write call sites — "stopped" specifically): the same
      // shutdown()-driven `state:"stopped"` write that already carries
      // exitCode/finishedAt must also carry a fresh `lastOutcome`, mirroring
      // the record's own live fields at that terminal moment.
      const stoppedRecord = readJob(cwd, jobSlug);
      assert.equal(stoppedRecord.state, 'stopped');
      assert.ok(stoppedRecord.lastOutcome, 'expected a lastOutcome object on the stopped record');
      assert.equal(stoppedRecord.lastOutcome.state, 'stopped');
      assert.equal(stoppedRecord.lastOutcome.exitCode, stoppedRecord.exitCode);
      assert.equal(stoppedRecord.lastOutcome.finishedAt, stoppedRecord.finishedAt);
      assert.equal(stoppedRecord.lastOutcome.task, 'do two independent things');
      assert.equal(stoppedRecord.lastOutcome.phase, stoppedRecord.phase);
      assert.equal(stoppedRecord.lastOutcome.stage, stoppedRecord.stage);
      assert.equal(stoppedRecord.lastOutcome.round, stoppedRecord.round);
    } finally {
      logSpy.mock.restore();
      for (const sig of Object.keys(preexisting)) {
        process.removeListener(sig, preexisting[sig]);
        if (newHandlers?.[sig]) process.removeListener(sig, newHandlers[sig]);
      }
      for (const child of workerChildren) {
        if (pidAlive(child.pid)) process.kill(child.pid, 'SIGKILL');
      }
    }
  });
});

/**
 * Contract this section pins down for `lastOutcome` capture on the fan-out
 * coordinator driver itself — the 4th of the 4 terminal-write call sites
 * named in `.orch/sunny-oasis-a761/task.md` section 1 (`runPipeline`/
 * `runWorkerPipeline` covered in test/main.test.js and
 * test/fanout-children.test.js, `runIntegratePipeline` covered in
 * test/fanout-children.test.js, "stopped" covered above in the interrupt-
 * wiring test). The coordinator's own `run.json.lastOutcome` is independent
 * of any child worker's/integration session's `run.json`. Unlike
 * `runPipeline`/`runWorkerPipeline`/`runIntegratePipeline` (which each run
 * a code loop in-process and so have an unambiguous `codeAccepted.verdict.
 * summary` to source `lastOutcome.summary` from), the coordinator's own
 * process never runs a code loop itself in the fan-out (non-decline) path —
 * workers and integration run in spawned children with their own separate
 * `run.json`s — so this suite only pins down that `summary` is present as a
 * best-effort string (per the same "fall back to '' if nothing captured"
 * rule every other lastOutcome write follows), not its exact text.
 */
describe('runFanoutPipeline lastOutcome capture on terminal states', () => {
  it('writes lastOutcome.state:"done" with a best-effort summary string when every worker + integration succeed', async () => {
    const cwd = makeTmpCwd('orch-fanout-lastoutcome-done-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({ triage: TRIAGE_COMPLEX, boundaries: BOUNDARIES_OK, decomposer: decomposeReply(workers) });
    const { spawnFn } = fakeChildSpawn({ cwd, parentSlug: jobSlug, outcomes: { a: 'done', b: 'done' }, integrationOutcome: 'done', delayMs: 10 });
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(exitMock.mock.calls.map((c) => c.arguments[0]), [0]);
    const record = readJob(cwd, jobSlug);
    assert.equal(record.state, 'done');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'done');
    assert.equal(record.lastOutcome.exitCode, 0);
    assert.equal(record.lastOutcome.finishedAt, record.finishedAt);
    assert.equal(record.lastOutcome.task, 'do two independent things');
    assert.equal(record.lastOutcome.phase, record.phase);
    assert.equal(record.lastOutcome.stage, record.stage);
    assert.equal(record.lastOutcome.round, record.round);
    assert.equal(typeof record.lastOutcome.summary, 'string');
    assert.ok(record.lastOutcome.error == null, 'error should be omitted/null on a clean done');
  });

  it('writes lastOutcome.state:"failed" with the thrown error message when a stage throws (triage agent errors)', async () => {
    const cwd = makeTmpCwd('orch-fanout-lastoutcome-failed-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);

    class ThrowingTriageAgent {
      constructor(name) { this.name = name; }
      async run() { throw new Error('triage agent exploded'); }
    }
    const exitMock = mock.fn();

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      await runFanoutPipeline('do two independent things', {
        agent: 'claude',
        AgentClass: ThrowingTriageAgent,
        cwd,
        jobSlug,
        jobCwd: cwd,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
    }

    assert.deepEqual(exitMock.mock.calls.map((c) => c.arguments[0]), [1]);
    const record = readJob(cwd, jobSlug);
    assert.equal(record.state, 'failed');
    assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
    assert.equal(record.lastOutcome.state, 'failed');
    assert.equal(record.lastOutcome.exitCode, 1);
    assert.equal(record.lastOutcome.task, 'do two independent things');
    assert.equal(record.lastOutcome.phase, record.phase);
    assert.equal(record.lastOutcome.stage, record.stage);
    assert.equal(typeof record.lastOutcome.error, 'string');
    assert.match(
      record.lastOutcome.error,
      /failure\.log/,
      'failed lastOutcome.error should be a pointer to failure.log, not a verbose dump',
    );
    assert.equal(record.failureLogPath, jobPaths(cwd, jobSlug).failureLogPath);
    assert.equal(fs.existsSync(record.failureLogPath), true);
    const failureBody = fs.readFileSync(record.failureLogPath, 'utf8');
    assert.match(
      failureBody,
      /error:\s*triage agent exploded/,
      'failure.log header error: must retain err.message for recover',
    );
    assert.doesNotMatch(
      record.lastOutcome.error,
      /triage agent exploded/,
      'lastOutcome.error must not duplicate the durable header reason',
    );
  });
});
