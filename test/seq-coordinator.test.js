import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeqPipeline, cascadeStopSeqChildren, runDetached } from '../main.js';
import { readSeq, writeSeq } from '../lib/seq.js';
import {
  readJob,
  writeJob,
  patchJob,
  requestResume,
  checkpointPause as realCheckpointPause,
} from '../lib/jobs.js';
import { allocateJob as realAllocateJob } from '../lib/job-lifecycle.js';
import { writeConfig, localConfigPath } from '../lib/config.js';

/**
 * Contract this file pins down for the seq Phase 3 coordinator (see
 * .spec/seq.md Schedule loop / User-facing contract / Decisions and
 * task.md Phase 3). Mirrors test/fanout-coordinator.test.js for `--seq`.
 *
 * `runSeqPipeline(prompt, options)` — exported from main.js:
 * - Options mirror `runFanoutPipeline` seams (`agent`, `AgentClass`,
 *   `maxRounds`, `verbose`, `cwd`, `jobSlug`, `jobCwd`, `patchJob`,
 *   `checkpointPause`, `pollIntervalMs`, `spawn`, `execFile`, `allocateJob`,
 *   `reconcileJob`, `exit`, decline-path worktree helpers) plus `maxUnits`
 *   (default 8) and injectable `mergeOneUnit` / seq I/O helpers.
 * - Stage order: triage → (simple → quick-fix; skip seq) → seq-decomposer
 *   (NO boundaries) with ≤2 repair rounds → decline = single-worktree
 *   pipeline with **no** seq.json → success = create/reuse
 *   `orch/<parentSlug>` at HEAD, write seq.json, loop concurrency 1:
 *   spawn first pending at tip → wait → fail stops chain (exit 1) → done →
 *   mergeOneUnit → adjust → continue until no pending.
 * - Spawn argv uses `--unit <parent>:<unitId>` (not `--worker` / `--seq`),
 *   env sets ORCH_JOB_SLUG, ORCH_DETACHED=1, ORCH_SEQ_DEPTH=1,
 *   ORCH_FANOUT_DEPTH=1. Unit role is `worker`.
 * - Adjust validation flake after repairs: keep previous pending and
 *   continue (do not abort a green merge).
 * - While parent pauseRequested: do not spawn next unit; wait on live unit
 *   (fixture: hold first unit, arm pause after first spawn, assert second
 *   unit blocked until resume; no re-decompose / no duplicate spawn).
 * - Happy-path schedule (AC4): BOTH units spawn/merge in order; unit N+1
 *   sees post-merge tip; merge of unit N completes before spawn of N+1.
 *
 * CLI:
 * - `--seq`, `--max-units` (default 8) in --help; distinguish from --fan-out.
 * - Reject `--seq` with `--fan-out` / `--ask` / `--quick` / `--dry-run`.
 * - Reject `--seq` / `--fan-out` if ORCH_SEQ_DEPTH or ORCH_FANOUT_DEPTH set.
 * - `--seq --detach`: spawn detached coordinator with `--seq` (no detach
 *   flag), ORCH_JOB_SLUG, coordinator role. Positive path pinned via
 *   `runDetached({ seq })`. Fan-out detach is in fanout-coordinator.test.js.
 *
 * `cascadeStopSeqChildren(cwd, parentSlug, { kill, isPidAlive })` — reads
 * seq.json unit slugs and SIGTERMs live non-terminal children.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pinLocalBranchPrefix(cwd, prefix = 'long_running_session') {
  writeConfig(localConfigPath(cwd), { branchPrefix: prefix });
  return prefix;
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

function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

const SUMMARY_DELIM = '<<<SUMMARY>>>';
function withSummary(content, summary) {
  return `${content}\n${SUMMARY_DELIM}\n${summary}`;
}

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
      if (typeof behavior === 'function') return behavior(this);
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

const TRIAGE_SIMPLE = { ok: true, result: withSummary(JSON.stringify({ simple: true, why: 'tiny fix', fix_plan: 'fix the typo' }), 'triage ok') };
const TRIAGE_COMPLEX = { ok: true, result: withSummary(JSON.stringify({ simple: false, why: 'needs research and a split' }), 'triage ok') };
const QUICK_FIX_OK = { ok: true, result: withSummary('fixed the typo', 'quick-fix ok') };
const PASS_CRITIC = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), 'critic ok') };
const PASS_RUNNER = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), 'runner ok') };

function declineReply(why = 'single tightly-coupled change; no useful ordered split') {
  return { ok: true, result: withSummary(JSON.stringify({ decomposable: false, why }), 'seq-decomposer ok') };
}

function unitsReply(units, why = 'ordered finishable units') {
  return {
    ok: true,
    result: withSummary(JSON.stringify({ decomposable: true, why, units }), 'seq-decomposer ok'),
  };
}

const TWO_UNITS = [
  { id: '01-types', title: 'billing types', subtask: 'Add shared billing types and stubs.' },
  { id: '02-api', title: 'invoice API', subtask: 'Implement create and list invoice endpoints.' },
];

function adjustOk(rewrites = [], drops = []) {
  return {
    ok: true,
    result: withSummary(JSON.stringify({ rewrites, drops }), 'adjust ok'),
  };
}

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

/**
 * Fake spawn that settles unit children by writing their run.json / seq unit
 * state after a short delay, mirroring fanout-coordinator's fake spawn.
 *
 * `outcomes[unitId]` may be `{ state, sha }` or the string `'hold'`. Hold
 * leaves the unit running until `releaseHeld(unitId)` is called (pause /
 * re-attach fixtures).
 */
function makeSettlingSpawn({ settleMs = 30, onSpawn, outcomes = {}, cwd: defaultCwd, parentSlug } = {}) {
  const calls = [];
  const releaseHeld = Object.create(null);

  const settleUnit = (call, unitId, outcome) => {
    const slug = call.options.env?.ORCH_JOB_SLUG;
    const cwd = call.options.cwd ?? defaultCwd;
    if (!slug || !cwd) return;
    try {
      const jobPath = path.join(cwd, '.orch', slug, 'run.json');
      if (fs.existsSync(jobPath)) {
        const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
        fs.writeFileSync(jobPath, JSON.stringify({
          ...job,
          state: outcome.state,
          sha: outcome.sha ?? null,
          pid: call.pid,
          exitCode: outcome.state === 'done' ? 0 : 1,
          finishedAt: new Date().toISOString(),
        }, null, 2));
      }
      const seqParent = parentSlug ?? call.args[call.args.indexOf('--unit') + 1]?.split(':')[0];
      if (seqParent) {
        const seq = readSeq(cwd, seqParent);
        if (seq) {
          writeSeq(cwd, seqParent, {
            ...seq,
            units: seq.units.map((u) => (
              u.id === unitId
                ? {
                  ...u,
                  state: outcome.state,
                  sha: outcome.sha ?? null,
                  slug,
                  changedFiles: outcome.state === 'done' ? (outcome.changedFiles ?? []) : null,
                }
                : u
            )),
          });
        }
      }
    } catch {
      // ignore race with allocate
    }
    onSpawn?.({ ...call, settled: outcome });
  };

  const spawnFn = (execPath, args, options) => {
    const call = { execPath, args, options, pid: 40_000 + calls.length };
    calls.push(call);
    onSpawn?.(call);

    const unitIdx = args.indexOf('--unit');
    let unitId = null;
    if (unitIdx !== -1) {
      [, unitId] = args[unitIdx + 1].split(':');
    }

    const child = {
      pid: call.pid,
      unref() {},
      kill() {},
      on() { return child; },
    };

    if (unitId != null) {
      const outcome = outcomes[unitId] ?? { state: 'done', sha: `sha-${unitId}` };
      if (outcome === 'hold') {
        releaseHeld[unitId] = () => {
          settleUnit(call, unitId, { state: 'done', sha: `sha-${unitId}` });
        };
      } else {
        setTimeout(() => settleUnit(call, unitId, outcome), settleMs);
      }
    }

    return child;
  };
  spawnFn.calls = calls;
  spawnFn.releaseHeld = (unitId) => {
    if (typeof releaseHeld[unitId] !== 'function') {
      throw new Error(`no held unit to release: ${unitId}`);
    }
    releaseHeld[unitId]();
  };
  return spawnFn;
}

function fakeDetachSpawn(pid) {
  return mock.fn(() => ({ pid, unref: () => {} }));
}

function unitIdsFromSpawns(calls) {
  return calls
    .filter((c) => c.args.includes('--unit'))
    .map((c) => c.args[c.args.indexOf('--unit') + 1].split(':')[1]);
}

describe('runSeqPipeline — triage short-circuit (simple never seqs)', () => {
  it('simple:true routes straight to quick-fix; no seq-decomposer, no seq.json', async () => {
    const cwd = makeTmpCwd('orch-seq-simple-');
    const jobSlug = 'calm-otter-a1b2';
    const order = [];
    const AgentClass = createMockAgentClass({
      triage: TRIAGE_SIMPLE,
      'quick-fix': QUICK_FIX_OK,
    }, { order });
    const exit = mock.fn();

    await runSeqPipeline('fix the typo', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      AgentClass,
      exit,
      patchJob: () => {},
      checkpointPause: async () => {},
    });

    assert.ok(order.includes('triage'));
    assert.ok(order.includes('quick-fix'));
    assert.ok(!order.includes('seq-decomposer'));
    assert.ok(!order.includes('boundaries'));
    assert.equal(readSeq(cwd, jobSlug), null);
  });
});

describe('runSeqPipeline — no boundaries; decomposer repair then decline', () => {
  it('never runs boundaries; repairs invalid decomposition then declines without seq.json', async () => {
    const cwd = makeTmpCwd('orch-seq-decline-');
    const prefix = pinLocalBranchPrefix(cwd);
    const jobSlug = 'calm-otter-a1b2';
    const order = [];
    const invalid = unitsReply([{ id: '01-only', title: 'only', subtask: 'alone' }]);
    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': [invalid, invalid, invalid],
      decomposer: [invalid, invalid, invalid],
      research: { ok: true, result: withSummary('research', 'ok') },
      planner: { ok: true, result: withSummary('plan', 'ok') },
      'test-writer': { ok: true, result: withSummary('tests', 'ok') },
      'test-critic': PASS_CRITIC,
      'code-writer': { ok: true, result: withSummary('code', 'ok') },
      'test-runner': PASS_RUNNER,
    }, { order });

    const createWorktree = mock.fn(async ({ slug }) => ({
      worktreePath: path.join(cwd, `wt-${slug}`),
      branch: `orch/${slug}`,
    }));
    const commitWorktree = mock.fn(async () => ({ sha: 'decline-sha' }));
    const exit = mock.fn();
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse'), stdout: 'basehead\n' },
    ]);

    await runSeqPipeline('implement the billing module', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      maxUnits: 8,
      AgentClass,
      createWorktree,
      commitWorktree,
      collectWorktreeChanges: async () => [],
      createRunContext: () => ({
        slug: jobSlug,
        artifactDir: path.join(cwd, '.orch', jobSlug),
        researchPath: path.join(cwd, '.orch', jobSlug, 'research.md'),
        taskPath: path.join(cwd, '.orch', jobSlug, 'task.md'),
        statusPath: path.join(cwd, '.orch', jobSlug, 'status.md'),
      }),
      execFile,
      exit,
      patchJob: () => {},
      checkpointPause: async () => {},
    });

    assert.ok(!order.includes('boundaries'));
    const decomposerCalls = order.filter((r) => r === 'seq-decomposer' || r === 'decomposer');
    assert.ok(decomposerCalls.length >= 1 && decomposerCalls.length <= 3);
    assert.equal(readSeq(cwd, jobSlug), null);
    assert.ok(createWorktree.mock.calls.length >= 1, 'decline path creates coordinator worktree');
    assert.equal(createWorktree.mock.calls[0].arguments[0].branchPrefix, prefix);
  });

  it('decomposable:false declines to single-worktree pipeline without seq.json', async () => {
    const cwd = makeTmpCwd('orch-seq-decline-false-');
    const prefix = pinLocalBranchPrefix(cwd);
    const jobSlug = 'calm-otter-a1b2';
    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': declineReply(),
      decomposer: declineReply(),
      research: { ok: true, result: withSummary('research', 'ok') },
      planner: { ok: true, result: withSummary('plan', 'ok') },
      'test-writer': { ok: true, result: withSummary('tests', 'ok') },
      'test-critic': PASS_CRITIC,
      'code-writer': { ok: true, result: withSummary('code', 'ok') },
      'test-runner': PASS_RUNNER,
    });
    const exit = mock.fn();
    const createWorktree = mock.fn(async ({ slug }) => ({
      worktreePath: path.join(cwd, `wt-${slug}`),
      branch: `orch/${slug}`,
    }));

    await runSeqPipeline('implement tightly coupled change', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      AgentClass,
      createWorktree,
      commitWorktree: async () => ({ sha: 'decline-sha' }),
      collectWorktreeChanges: async () => [],
      createRunContext: () => ({
        slug: jobSlug,
        artifactDir: path.join(cwd, '.orch', jobSlug),
        researchPath: path.join(cwd, '.orch', jobSlug, 'research.md'),
        taskPath: path.join(cwd, '.orch', jobSlug, 'task.md'),
        statusPath: path.join(cwd, '.orch', jobSlug, 'status.md'),
      }),
      execFile: makeFakeExecFile([{ match: () => true, stdout: 'base\n' }]).execFile,
      exit,
      patchJob: () => {},
      checkpointPause: async () => {},
    });

    assert.equal(readSeq(cwd, jobSlug), null);
    assert.ok(createWorktree.mock.calls.length >= 1, 'decline path creates a worktree');
    assert.equal(createWorktree.mock.calls[0].arguments[0].slug, jobSlug);
    assert.equal(createWorktree.mock.calls[0].arguments[0].branchPrefix, prefix);
  });
});

describe('runSeqPipeline — successful decompose bootstrap + strict concurrency 1', () => {
  it('writes seq.json, spawns BOTH units one at a time with --unit and depth env, merges in order, and bases unit N+1 at the post-merge tip', async () => {
    const cwd = makeTmpCwd('orch-seq-ok-');
    const prefix = pinLocalBranchPrefix(cwd);
    const jobSlug = 'wise-pine-e904';
    const baseTip = 'basehead00001111222233334444555566667777';
    fs.mkdirSync(path.join(cwd, '.orch', jobSlug), { recursive: true });
    writeJob(cwd, jobSlug, {
      slug: jobSlug,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      role: 'coordinator',
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    });

    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': unitsReply(TWO_UNITS),
      decomposer: unitsReply(TWO_UNITS),
      adjust: adjustOk(),
    });

    const mergeCalls = [];
    const tipsAtUnitSpawn = [];
    const mergeCountAtUnitSpawn = [];
    const inFlightAtSpawn = [];

    const spawnFn = makeSettlingSpawn({
      settleMs: 40,
      cwd,
      parentSlug: jobSlug,
      outcomes: {
        '01-types': { state: 'done', sha: 'sha-01' },
        '02-api': { state: 'done', sha: 'sha-02' },
      },
      onSpawn: (call) => {
        if (!call.args?.includes('--unit') || call.settled) return;
        const seq = readSeq(cwd, jobSlug);
        tipsAtUnitSpawn.push(seq?.tip ?? null);
        mergeCountAtUnitSpawn.push(mergeCalls.length);
        const running = (seq?.units ?? []).filter((u) => u.state === 'running').map((u) => u.id);
        inFlightAtSpawn.push(running);
      },
    });

    let tipCounter = 0;
    const mergeOneUnit = async ({ unitId }) => {
      mergeCalls.push(unitId);
      const seq = readSeq(cwd, jobSlug);
      tipCounter += 1;
      writeSeq(cwd, jobSlug, { ...seq, tip: `tip-${tipCounter}` });
    };

    const allocateJob = async (opts) => realAllocateJob({ ...opts, cwd });
    const exit = mock.fn();
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse'), stdout: `${baseTip}\n` },
    ]);

    const reconcileJob = (c, slug) => readJob(c, slug);
    const createWorktree = mock.fn(async ({ slug }) => ({
      worktreePath: path.join(cwd, `wt-${slug}`),
      branch: `orch/${slug}`,
    }));

    await runSeqPipeline('implement the billing module', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      maxUnits: 8,
      AgentClass,
      spawn: spawnFn,
      allocateJob,
      reconcileJob,
      mergeOneUnit,
      pollIntervalMs: 20,
      execFile,
      createWorktree,
      exit,
      patchJob: (c, slug, patch) => patchJob(c, slug, patch),
      checkpointPause: async () => {},
    });

    const seq = readSeq(cwd, jobSlug);
    assert.ok(seq, 'seq.json must exist after successful decompose');
    assert.equal(seq.parentSlug, jobSlug);
    assert.equal(seq.units.length, 2);
    assert.equal(seq.maxUnits, 8);
    assert.ok(createWorktree.mock.calls.length >= 1, 'ensureSeqCoordinatorWorktree must create');
    assert.equal(createWorktree.mock.calls[0].arguments[0].slug, jobSlug);
    assert.equal(createWorktree.mock.calls[0].arguments[0].branchPrefix, prefix);

    const spawnedIds = unitIdsFromSpawns(spawnFn.calls);
    assert.deepEqual(spawnedIds, ['01-types', '02-api'], 'both units must spawn exactly once, in order');

    for (const call of spawnFn.calls.filter((c) => c.args.includes('--unit'))) {
      assert.ok(!call.args.includes('--seq'), 'unit must never receive --seq');
      assert.ok(!call.args.includes('--fan-out'));
      assert.equal(call.options.env.ORCH_DETACHED, '1');
      assert.equal(call.options.env.ORCH_SEQ_DEPTH, '1');
      assert.equal(call.options.env.ORCH_FANOUT_DEPTH, '1');
      assert.ok(call.options.env.ORCH_JOB_SLUG);
    }

    // AC4: merge each green unit before the next starts; tip advances for unit N+1.
    assert.deepEqual(mergeCalls, ['01-types', '02-api']);
    assert.equal(tipsAtUnitSpawn.length, 2);
    assert.equal(tipsAtUnitSpawn[0], baseTip, 'first unit bases at the initial tip');
    assert.equal(tipsAtUnitSpawn[1], 'tip-1', 'second unit must base at post-merge tip of unit 01');
    assert.equal(seq.tip, 'tip-2', 'final tip must reflect both merges');

    // Strict concurrency 1: at each spawn, at most the unit being started is running
    // (no prior unit still marked running alongside a new spawn).
    for (const running of inFlightAtSpawn) {
      assert.ok(running.length <= 1, `expected ≤1 in-flight unit at spawn, got ${running.join(',')}`);
    }
    assert.deepEqual(
      mergeCountAtUnitSpawn,
      [0, 1],
      '01-types must already be merged before 02-api spawns (AC4 tip/schedule)',
    );
  });

  it('stops the chain on first failed unit without spawning later units; exits 1', async () => {
    const cwd = makeTmpCwd('orch-seq-stop-');
    const jobSlug = 'wise-pine-e904';
    fs.mkdirSync(path.join(cwd, '.orch', jobSlug), { recursive: true });
    writeJob(cwd, jobSlug, {
      slug: jobSlug,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      role: 'coordinator',
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    });

    const three = [
      ...TWO_UNITS,
      { id: '03-ui', title: 'invoice UI', subtask: 'Build UI.' },
    ];
    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': unitsReply(three),
      decomposer: unitsReply(three),
      adjust: adjustOk(),
    });

    const spawnFn = makeSettlingSpawn({
      settleMs: 30,
      cwd,
      parentSlug: jobSlug,
      outcomes: { '01-types': { state: 'failed', sha: null } },
    });

    const exitCodes = [];
    const exit = (code) => { exitCodes.push(code); };

    await runSeqPipeline('implement the billing module', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      maxUnits: 8,
      AgentClass,
      spawn: spawnFn,
      allocateJob: async (opts) => realAllocateJob({ ...opts, cwd }),
      reconcileJob: (c, slug) => readJob(c, slug),
      mergeOneUnit: async () => {
        throw new Error('mergeOneUnit must not run after unit failure');
      },
      pollIntervalMs: 20,
      execFile: makeFakeExecFile([{ match: () => true, stdout: 'basehead\n' }]).execFile,
      createWorktree: async ({ slug }) => ({ worktreePath: path.join(cwd, `wt-${slug}`), branch: `orch/${slug}` }),
      exit,
      patchJob: (c, slug, patch) => patchJob(c, slug, patch),
      checkpointPause: async () => {},
    });

    const spawnedIds = unitIdsFromSpawns(spawnFn.calls);
    assert.ok(!spawnedIds.includes('02-api'));
    assert.ok(!spawnedIds.includes('03-ui'));
    assert.ok(exitCodes.includes(1));
  });
});

describe('runSeqPipeline — waitForUnit reconcileJob arity', () => {
  it('passes the job record into reconcileJob after unit spawn (avoids record.state crash)', async () => {
    const cwd = makeTmpCwd('orch-seq-reconcile-arity-');
    const jobSlug = 'wise-pine-e904';
    const baseTip = 'basehead00001111222233334444555566667777';
    fs.mkdirSync(path.join(cwd, '.orch', jobSlug), { recursive: true });
    writeJob(cwd, jobSlug, {
      slug: jobSlug,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      role: 'coordinator',
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    });

    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': unitsReply(TWO_UNITS),
      decomposer: unitsReply(TWO_UNITS),
      adjust: adjustOk(),
    });

    const spawnFn = makeSettlingSpawn({
      settleMs: 40,
      cwd,
      parentSlug: jobSlug,
      outcomes: {
        '01-types': { state: 'done', sha: 'sha-01' },
        '02-api': { state: 'done', sha: 'sha-02' },
      },
    });

    const reconcileCalls = [];
    const exit = mock.fn();
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse'), stdout: `${baseTip}\n` },
    ]);

    await runSeqPipeline('implement the billing module', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      maxUnits: 8,
      AgentClass,
      spawn: spawnFn,
      allocateJob: async (opts) => realAllocateJob({ ...opts, cwd }),
      reconcileJob: (c, slug, record) => {
        // Real reconcileJob(cwd, slug, record) throws if record is missing
        // (reads record.state). waitForUnit must pass readJob(...) as fan-out does.
        if (record == null) throw new TypeError("Cannot read properties of undefined (reading 'state')");
        reconcileCalls.push({ slug, state: record.state });
        return record;
      },
      mergeOneUnit: async ({ unitId }) => {
        const seq = readSeq(cwd, jobSlug);
        writeSeq(cwd, jobSlug, { ...seq, tip: `tip-after-${unitId}` });
      },
      pollIntervalMs: 20,
      execFile,
      createWorktree: async ({ slug }) => ({
        worktreePath: path.join(cwd, `wt-${slug}`),
        branch: `orch/${slug}`,
      }),
      exit,
      patchJob: (c, slug, patch) => patchJob(c, slug, patch),
      checkpointPause: async () => {},
    });

    assert.ok(reconcileCalls.length > 0, 'waitForUnit must call reconcileJob while the unit is live');
    assert.equal(exit.mock.calls[0]?.arguments[0], 0);
  });
});

describe('runSeqPipeline — parent pauseRequested gates next-unit spawn', () => {
  it('does not spawn the next unit while parent is paused; waits on the live unit; resumes without re-decompose or duplicate spawn', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-seq-parent-pause-');
    const jobSlug = 'wise-pine-e904';
    fs.mkdirSync(path.join(cwd, '.orch', jobSlug), { recursive: true });
    writeJob(cwd, jobSlug, {
      slug: jobSlug,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      role: 'coordinator',
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    });

    let decomposerCount = 0;
    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': () => {
        decomposerCount += 1;
        return unitsReply(TWO_UNITS);
      },
      decomposer: () => {
        decomposerCount += 1;
        return unitsReply(TWO_UNITS);
      },
      adjust: adjustOk(),
    });

    const spawnFn = makeSettlingSpawn({
      settleMs: 20,
      cwd,
      parentSlug: jobSlug,
      outcomes: { '01-types': 'hold', '02-api': { state: 'done', sha: 'sha-02' } },
    });

    let pauseArmed = false;
    let observedBlockedSpawn = false;
    const checkpointPause = mock.fn(async (jobCwd, slug, opts) => {
      const unitSpawnCount = unitIdsFromSpawns(spawnFn.calls).length;
      if (slug === jobSlug && unitSpawnCount >= 1 && !pauseArmed) {
        pauseArmed = true;
        patchJob(jobCwd, slug, { pauseRequested: true, state: 'pausing' });
      }
      await realCheckpointPause(jobCwd, slug, { ...opts, pollIntervalMs: opts?.pollIntervalMs ?? 5 });
    });

    const mergeCalls = [];
    const startedAt = Date.now();
    const driver = setInterval(() => {
      const current = readJob(cwd, jobSlug);
      const spawned = unitIdsFromSpawns(spawnFn.calls);
      if (current?.state === 'paused' && current.pauseRequested) {
        if (spawned.length === 1) observedBlockedSpawn = true;
        assert.equal(spawned.length, 1, 'must not spawn 02-api while parent is paused');
        assert.deepEqual(spawned, ['01-types']);
        // Live unit stays running across the pause — release it, then resume parent.
        try {
          spawnFn.releaseHeld('01-types');
        } catch {
          // already released
        }
        requestResume(cwd, jobSlug);
        return;
      }
      if (Date.now() - startedAt > 1500) {
        try { spawnFn.releaseHeld('01-types'); } catch { /* ok */ }
        if (current?.pauseRequested) requestResume(cwd, jobSlug);
      }
    }, 15);

    const exit = mock.fn();
    try {
      await runSeqPipeline('implement the billing module', {
        cwd,
        jobSlug,
        jobCwd: cwd,
        agent: 'claude',
        maxUnits: 8,
        AgentClass,
        spawn: spawnFn,
        allocateJob: async (opts) => realAllocateJob({ ...opts, cwd }),
        reconcileJob: (c, slug) => readJob(c, slug),
        mergeOneUnit: async ({ unitId }) => {
          mergeCalls.push(unitId);
          const seq = readSeq(cwd, jobSlug);
          writeSeq(cwd, jobSlug, { ...seq, tip: `tip-after-${unitId}` });
        },
        pollIntervalMs: 15,
        pausePollIntervalMs: 5,
        execFile: makeFakeExecFile([{ match: () => true, stdout: 'basehead\n' }]).execFile,
        createWorktree: async ({ slug }) => ({
          worktreePath: path.join(cwd, `wt-${slug}`),
          branch: `orch/${slug}`,
        }),
        exit,
        patchJob: (c, slug, patch) => patchJob(c, slug, patch),
        checkpointPause,
      });
    } finally {
      clearInterval(driver);
    }

    assert.ok(observedBlockedSpawn, 'expected schedule blocked while parent was paused with a live unit');
    assert.equal(decomposerCount, 1, 'resume must not re-run seq-decomposer');
    assert.deepEqual(unitIdsFromSpawns(spawnFn.calls), ['01-types', '02-api']);
    assert.deepEqual(mergeCalls, ['01-types', '02-api']);
  });
});

describe('runSeqPipeline — adjust flake keeps previous pending', () => {
  it('continues after adjust validation failures rather than aborting a green merge', async () => {
    const cwd = makeTmpCwd('orch-seq-adjust-flake-');
    const jobSlug = 'wise-pine-e904';
    fs.mkdirSync(path.join(cwd, '.orch', jobSlug), { recursive: true });
    writeJob(cwd, jobSlug, {
      slug: jobSlug,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      role: 'coordinator',
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    });

    const badAdjust = {
      ok: true,
      result: withSummary(JSON.stringify({
        rewrites: [{ id: '99-invented', title: 'x', subtask: 'y' }],
        drops: [],
      }), 'adjust bad'),
    };

    const AgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      'seq-decomposer': unitsReply(TWO_UNITS),
      decomposer: unitsReply(TWO_UNITS),
      adjust: [badAdjust, badAdjust, badAdjust],
    });

    const spawnFn = makeSettlingSpawn({
      settleMs: 30,
      outcomes: {
        '01-types': { state: 'done', sha: 'sha-01' },
        '02-api': { state: 'done', sha: 'sha-02' },
      },
      onSpawn: (call) => {
        if (!call.args?.includes('--unit')) return;
        const [parent, unitId] = call.args[call.args.indexOf('--unit') + 1].split(':');
        setTimeout(() => {
          const seq = readSeq(cwd, parent);
          if (!seq) return;
          writeSeq(cwd, parent, {
            ...seq,
            units: seq.units.map((u) => (
              u.id === unitId
                ? { ...u, state: 'done', sha: `sha-${unitId}`, slug: call.options.env.ORCH_JOB_SLUG, changedFiles: [] }
                : u
            )),
          });
        }, 35);
      },
    });

    const exit = mock.fn();
    await runSeqPipeline('implement the billing module', {
      cwd,
      jobSlug,
      jobCwd: cwd,
      agent: 'claude',
      maxUnits: 8,
      AgentClass,
      spawn: spawnFn,
      allocateJob: async (opts) => realAllocateJob({ ...opts, cwd }),
      reconcileJob: (c, slug) => readJob(c, slug),
      mergeOneUnit: async () => {
        const seq = readSeq(cwd, jobSlug);
        writeSeq(cwd, jobSlug, { ...seq, tip: `tip-${Date.now()}` });
      },
      pollIntervalMs: 20,
      execFile: makeFakeExecFile([{ match: () => true, stdout: 'basehead\n' }]).execFile,
      createWorktree: async ({ slug }) => ({ worktreePath: path.join(cwd, `wt-${slug}`), branch: `orch/${slug}` }),
      exit,
      patchJob: (c, slug, patch) => patchJob(c, slug, patch),
      checkpointPause: async () => {},
    });

    const seq = readSeq(cwd, jobSlug);
    assert.ok(seq);
    // Pending list kept (02-api still present as an id — may be done if second unit ran)
    assert.ok(seq.units.some((u) => u.id === '02-api'));
    assert.ok(!seq.units.some((u) => u.id === '99-invented'));
  });
});

describe('--seq CLI flags and guards', () => {
  it('documents --seq and --max-units in --help, distinct from --fan-out', async () => {
    const { stdout } = await runCli(['--help']);
    assert.match(stdout, /--seq/);
    assert.match(stdout, /--max-units/);
    assert.match(stdout, /--fan-out/);
    assert.match(stdout, /ordered|sequential|merge each|adjust/i);
  });

  for (const conflicting of ['--fan-out', '--ask', '--quick', '--dry-run']) {
    it(`rejects --seq combined with ${conflicting}`, async () => {
      const cwd = makeTmpCwd('orch-seq-cli-');
      const { code, stderr } = await runCli(['a trivial task', '--seq', conflicting], { cwd });
      assert.notEqual(code, 0);
      assert.equal(readSeq(cwd, 'unused'), null);
      assert.ok(stderr.length > 0 || code !== 0);
    });
  }

  it('rejects --seq when ORCH_SEQ_DEPTH is already set', async () => {
    const cwd = makeTmpCwd('orch-seq-depth-');
    const { code } = await runCli(
      ['a trivial task', '--seq'],
      { cwd, env: { ...process.env, ORCH_SEQ_DEPTH: '1' } },
    );
    assert.notEqual(code, 0);
  });

  it('rejects --seq when ORCH_FANOUT_DEPTH is already set', async () => {
    const cwd = makeTmpCwd('orch-seq-depth-fo-');
    const { code } = await runCli(
      ['a trivial task', '--seq'],
      { cwd, env: { ...process.env, ORCH_FANOUT_DEPTH: '1' } },
    );
    assert.notEqual(code, 0);
  });

  it('rejects --fan-out when ORCH_SEQ_DEPTH is already set', async () => {
    const cwd = makeTmpCwd('orch-fo-seq-depth-');
    const { code } = await runCli(
      ['a trivial task', '--fan-out'],
      { cwd, env: { ...process.env, ORCH_SEQ_DEPTH: '1' } },
    );
    assert.notEqual(code, 0);
  });

  it('rejects a non-positive-integer --max-units', async () => {
    const { code, stderr } = await runCli(['a trivial task', '--seq', '--max-units', '0']);
    assert.notEqual(code, 0);
    assert.match(stderr + '', /max-units|positive|integer/i);
  });
});

describe('--seq --detach', () => {
  it('does not reject --seq combined with --detach as an illegal flag pairing', async () => {
    const cwd = makeTmpCwd('orch-seq-detach-');
    const { stderr } = await runCli(
      ['implement the billing module', '--seq', '--detach', '--agent', 'claude'],
      { cwd },
    );
    assert.doesNotMatch(
      stderr,
      /cannot combine.*--seq.*--detach|cannot combine.*--detach.*--seq/i,
    );
  });

  it('spawns a detached coordinator child with --seq (no --detach), ORCH_JOB_SLUG, and role coordinator', async () => {
    // Pins the positive detach path. runDetached({ seq: true }) must forward
    // --seq/--max-units and allocate the parent as role:"coordinator".
    // Fan-out detach (`runDetached({ fanOut })`) is covered in
    // test/fanout-coordinator.test.js.
    const cwd = makeTmpCwd('orch-seq-detach-spawn-');
    const spawnMock = fakeDetachSpawn(65432);
    const exit = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('implement the billing module', {
        agent: 'claude',
        maxRounds: 5,
        seq: true,
        maxUnits: 6,
        cwd,
        spawn: spawnMock,
        exit,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(spawnMock.mock.calls.length, 1, 'must spawn exactly one detached coordinator child');
    const [command, args, spawnOptions] = spawnMock.mock.calls[0].arguments;
    assert.equal(command, process.execPath);
    assert.ok(args.includes('implement the billing module'));
    assert.ok(args.includes('--seq'), 'child must receive --seq so it enters runSeqPipeline');
    assert.ok(args.includes('--max-units'));
    assert.ok(args.includes('6'));
    assert.ok(!args.includes('--detach'), 'child must not receive --detach (would spawn a grandchild)');
    assert.ok(!args.includes('--fan-out'));

    assert.equal(spawnOptions.detached, true);
    assert.equal(spawnOptions.env.ORCH_DETACHED, '1');
    assert.match(spawnOptions.env.ORCH_JOB_SLUG, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

    const slug = spawnOptions.env.ORCH_JOB_SLUG;
    const record = readJob(cwd, slug);
    assert.equal(record.role, 'coordinator');
    assert.equal(record.pid, 65432);
    assert.equal(record.state, 'running');
    assert.equal(exit.mock.calls[0].arguments[0], 0);
  });
});

describe('cascadeStopSeqChildren', () => {
  it('signals only live non-terminal unit children recorded in seq.json', () => {
    const cwd = makeTmpCwd('orch-seq-cascade-');
    const parentSlug = 'wise-pine-e904';
    writeSeq(cwd, parentSlug, {
      version: 1,
      parentSlug,
      task: 't',
      base: 'b',
      tip: 't',
      maxUnits: 8,
      units: [
        { id: '01-types', title: 'a', subtask: 'a', state: 'done', slug: 'unit-done-aaaa', sha: 'x', changedFiles: [] },
        { id: '02-api', title: 'b', subtask: 'b', state: 'running', slug: 'unit-live-bbbb', sha: null, changedFiles: null },
        { id: '03-ui', title: 'c', subtask: 'c', state: 'pending', slug: null, sha: null, changedFiles: null },
      ],
      adjustments: [],
      state: 'running',
    });
    fs.mkdirSync(path.join(cwd, '.orch', 'unit-done-aaaa'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.orch', 'unit-live-bbbb'), { recursive: true });
    writeJob(cwd, 'unit-done-aaaa', { slug: 'unit-done-aaaa', state: 'done', pid: 111, role: 'worker', parent: parentSlug });
    writeJob(cwd, 'unit-live-bbbb', { slug: 'unit-live-bbbb', state: 'running', pid: 222, role: 'worker', parent: parentSlug });

    const killed = [];
    cascadeStopSeqChildren(cwd, parentSlug, {
      kill: (pid, signal) => killed.push({ pid, signal }),
      isPidAlive: (pid) => pid === 222,
    });

    assert.deepEqual(killed, [{ pid: 222, signal: 'SIGTERM' }]);
  });
});
