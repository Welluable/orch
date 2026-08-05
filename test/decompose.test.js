import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDecomposePipeline, runSeqPipeline, runDetached } from '../main.js';
import { readSeq, writeSeq, validateSeqDecomposition, SEQ_DOC_STATES } from '../lib/seq.js';
import { readJob, writeJob } from '../lib/jobs.js';
import { allocateJob as realAllocateJob } from '../lib/job-lifecycle.js';
import {
  seqDecomposerAgentArgs,
  decomposeAgentArgs,
} from '../agents/seq-decomposer.js';
import * as agentsIndex from '../agents/index.js';
import { parseDecomposition } from '../lib/parse-decomposition.js';

/**
 * Contract for `.spec/decompose.md`: `--decompose` plan-only pipeline,
 * `--seq --from`, plan-mode seq-decomposer, and validator `minUnits: 1`.
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

function unitsReply(units, why = 'ordered finishable units') {
  return {
    ok: true,
    result: withSummary(JSON.stringify({ why, units }), 'seq-decomposer ok'),
  };
}

const THREE_UNITS = [
  { id: '01-types', title: 'billing types', subtask: 'Add shared billing types and stubs.' },
  { id: '02-api', title: 'invoice API', subtask: 'Implement create and list invoice endpoints.' },
  { id: '03-ui', title: 'billing UI', subtask: 'Build the billing settings page.' },
];

const ONE_UNIT = [
  { id: '01-task', title: 'fix typo', subtask: 'Fix the typo in README.' },
];

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

function makeSettlingSpawn({ settleMs = 30, outcomes = {}, cwd: defaultCwd, parentSlug } = {}) {
  const calls = [];
  const spawnFn = (execPath, args, options) => {
    const call = { execPath, args, options, pid: 50_000 + calls.length };
    calls.push(call);
    const unitIdx = args.indexOf('--unit');
    let unitId = null;
    if (unitIdx !== -1) {
      [, unitId] = args[unitIdx + 1].split(':');
    }
    const child = { pid: call.pid, unref() {}, kill() {}, on() { return child; } };
    if (unitId != null) {
      const outcome = outcomes[unitId] ?? { state: 'done', sha: `sha-${unitId}` };
      setTimeout(() => {
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
                      changedFiles: outcome.state === 'done' ? [] : null,
                    }
                    : u
                )),
              });
            }
          }
        } catch {
          // ignore
        }
      }, settleMs);
    }
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

function plannedSeq(overrides = {}) {
  return {
    version: 1,
    parentSlug: 'wise-pine-e904',
    task: 'implement the billing module',
    base: 'aaa111',
    tip: 'aaa111',
    maxUnits: 8,
    units: THREE_UNITS.map((u) => ({
      ...u,
      state: 'pending',
      slug: null,
      sha: null,
      changedFiles: null,
    })),
    adjustments: [],
    state: 'planned',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

describe('validateSeqDecomposition minUnits', () => {
  it('default / minUnits:2 still rejects a single unit', () => {
    const violations = validateSeqDecomposition({
      units: [{ id: '01-a', title: 'a', subtask: 'do a' }],
    });
    assert.ok(violations.includes('fewer than two units; not decomposable'));
  });

  it('minUnits:1 accepts one well-formed unit', () => {
    assert.deepEqual(
      validateSeqDecomposition(
        { units: [{ id: '01-a', title: 'a', subtask: 'do a' }] },
        { minUnits: 1 },
      ),
      [],
    );
  });

  it('empty units[] is invalid under minUnits:1 with distinct copy', () => {
    const violations = validateSeqDecomposition({ units: [] }, { minUnits: 1 });
    assert.ok(violations.length > 0);
    assert.ok(!violations.some((v) => /two units/i.test(v)));
  });

  it('SEQ_DOC_STATES includes planned', () => {
    assert.ok(SEQ_DOC_STATES.includes('planned'));
  });
});

describe('seq-decomposer plan mode', () => {
  it('decomposeAgentArgs / mode:plan never declines and requires ≥1 unit', () => {
    const viaWrapper = decomposeAgentArgs({
      prompt: 'implement billing',
      cwd: '/tmp/repo',
      maxUnits: 6,
      researchPath: '/tmp/repo/.orch/x/research.md',
    });
    const viaMode = seqDecomposerAgentArgs({
      prompt: 'implement billing',
      cwd: '/tmp/repo',
      maxUnits: 6,
      mode: 'plan',
      researchPath: '/tmp/repo/.orch/x/research.md',
    });
    for (const args of [viaWrapper, viaMode]) {
      assert.match(args.name, /seq-decomposer/);
      assert.match(args.instructions, /at least 1|≥1|At least 1/i);
      assert.match(args.instructions, /Never decline|no decomposable:false|never decline/i);
      assert.match(args.instructions, /research/i);
      assert.match(args.instructions, /6/);
      assert.doesNotMatch(args.instructions, /"decomposable": false/);
    }
  });

  it('default mode still allows decomposable:false', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement billing',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assert.match(args.instructions, /decomposable": false|decomposable:\s*false/i);
  });

  it('agents/index.js re-exports decomposeAgentArgs', () => {
    assert.equal(typeof agentsIndex.decomposeAgentArgs, 'function');
  });

  it('plan-mode JSON without decomposable parses', () => {
    const parsed = parseDecomposition(JSON.stringify({
      why: 'singleton',
      units: ONE_UNIT,
    }));
    assert.equal(parsed.units.length, 1);
  });
});

describe('runDecomposePipeline', () => {
  it('N=3 writes seq.json state planned, job done phase decompose, no triage/spawn', async () => {
    const cwd = makeTmpCwd('orch-decompose-');
    const order = [];
    const exits = [];
    const MockAgent = createMockAgentClass({
      research: { ok: true, result: withSummary('/tmp/research.md', 'mapped billing routes') },
      'seq-decomposer': unitsReply(THREE_UNITS),
      triage: () => { throw new Error('triage must not run'); },
    }, { order });

    const spawnFn = mock.fn(() => { throw new Error('spawn must not run'); });
    const createWorktreeFn = mock.fn(() => { throw new Error('worktree must not run'); });
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'deadbeef\n' },
    ]);

    const alloc = realAllocateJob({
      cwd,
      prompt: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      state: 'running',
      pid: process.pid,
    });

    await runDecomposePipeline('implement the billing module', {
      agent: 'claude',
      AgentClass: MockAgent,
      cwd,
      jobSlug: alloc.slug,
      jobCwd: cwd,
      maxUnits: 8,
      spawn: spawnFn,
      createWorktree: createWorktreeFn,
      execFile,
      exit: (code) => { exits.push(code); },
    });

    assert.deepEqual(exits, [0]);
    assert.ok(!order.includes('triage'));
    assert.ok(order.includes('research'));
    assert.ok(order.includes('seq-decomposer'));
    assert.equal(spawnFn.mock.callCount(), 0);
    assert.equal(createWorktreeFn.mock.callCount(), 0);

    const seq = readSeq(cwd, alloc.slug);
    assert.equal(seq.state, 'planned');
    assert.equal(seq.units.length, 3);
    assert.ok(seq.units.every((u) => u.state === 'pending' && u.slug === null));
    assert.equal(seq.base, 'deadbeef');
    assert.equal(seq.tip, 'deadbeef');

    const job = readJob(cwd, alloc.slug);
    assert.equal(job.state, 'done');
    assert.equal(job.phase, 'decompose');
    assert.equal(job.exitCode, 0);
    assert.ok(job.role == null || job.role === '-' || job.role === '');
  });

  it('N=1 is accepted in plan mode', async () => {
    const cwd = makeTmpCwd('orch-decompose-one-');
    const exits = [];
    const MockAgent = createMockAgentClass({
      research: { ok: true, result: withSummary('path', 'typo is in README') },
      'seq-decomposer': unitsReply(ONE_UNIT),
    });
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'abc123\n' },
    ]);
    const alloc = realAllocateJob({
      cwd, prompt: 'fix typo', agent: 'claude', maxRounds: 5, state: 'running', pid: process.pid,
    });

    await runDecomposePipeline('fix typo', {
      agent: 'claude',
      AgentClass: MockAgent,
      cwd,
      jobSlug: alloc.slug,
      jobCwd: cwd,
      execFile,
      exit: (code) => { exits.push(code); },
    });

    assert.deepEqual(exits, [0]);
    const seq = readSeq(cwd, alloc.slug);
    assert.equal(seq.units.length, 1);
    assert.equal(seq.state, 'planned');
  });

  it('invalid then empty repairs fail with no planned seq', async () => {
    const cwd = makeTmpCwd('orch-decompose-fail-');
    const exits = [];
    const MockAgent = createMockAgentClass({
      research: { ok: true, result: withSummary('path', 'research ok') },
      'seq-decomposer': [
        { ok: true, result: withSummary('not json', 'bad') },
        { ok: true, result: withSummary(JSON.stringify({ why: 'x', units: [] }), 'empty') },
        { ok: true, result: withSummary(JSON.stringify({ why: 'x', units: [] }), 'empty') },
      ],
    });
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'abc\n' },
    ]);
    const alloc = realAllocateJob({
      cwd, prompt: 'task', agent: 'claude', maxRounds: 5, state: 'running', pid: process.pid,
    });

    await runDecomposePipeline('task', {
      agent: 'claude',
      AgentClass: MockAgent,
      cwd,
      jobSlug: alloc.slug,
      jobCwd: cwd,
      execFile,
      exit: (code) => { exits.push(code); },
    });

    assert.deepEqual(exits, [1]);
    const seq = readSeq(cwd, alloc.slug);
    assert.equal(seq, null);
    const job = readJob(cwd, alloc.slug);
    assert.equal(job.state, 'failed');
  });
});

describe('runSeqPipeline --from', () => {
  it('skips decomposer, spawns first pending unit, sets state running', async () => {
    const cwd = makeTmpCwd('orch-from-');
    const slug = 'wise-pine-e904';
    fs.mkdirSync(path.join(cwd, '.orch', slug), { recursive: true });
    writeSeq(cwd, slug, plannedSeq({ parentSlug: slug }));
    writeJob(cwd, slug, {
      slug,
      task: 'implement the billing module',
      agent: 'claude',
      state: 'done',
      phase: 'decompose',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      pid: null,
    });

    const order = [];
    const exits = [];
    const MockAgent = createMockAgentClass({
      triage: () => { throw new Error('triage must not run'); },
      'seq-decomposer': () => { throw new Error('decomposer must not run'); },
      adjust: { ok: true, result: withSummary(JSON.stringify({ rewrites: [], drops: [] }), 'ok') },
    }, { order });

    const spawnFn = makeSettlingSpawn({
      cwd,
      parentSlug: slug,
      outcomes: {
        '01-types': { state: 'done', sha: 'sha-01' },
        '02-api': { state: 'done', sha: 'sha-02' },
        '03-ui': { state: 'done', sha: 'sha-03' },
      },
    });

    const createWorktreeFn = mock.fn(({ slug: s }) => ({
      repoRoot: cwd,
      worktreePath: `${cwd}-${s}`,
      branch: `orch/${s}`,
    }));
    const mergeOneUnitFn = mock.fn(async ({ unitId }) => {
      const seq = readSeq(cwd, slug);
      writeSeq(cwd, slug, {
        ...seq,
        tip: `tip-after-${unitId}`,
        units: seq.units.map((u) => (u.id === unitId ? { ...u, state: 'done' } : u)),
      });
    });
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('--show-toplevel'), stdout: `${cwd}\n` },
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'aaa111\n' },
    ]);

    await runSeqPipeline('ignored', {
      agent: 'claude',
      AgentClass: MockAgent,
      cwd,
      jobSlug: slug,
      jobCwd: cwd,
      fromSlug: slug,
      spawn: spawnFn,
      createWorktree: createWorktreeFn,
      mergeOneUnit: mergeOneUnitFn,
      allocateJob: realAllocateJob,
      reconcileJob: (c, s, j) => j,
      execFile,
      pollIntervalMs: 20,
      exit: (code) => { exits.push(code); },
    });

    assert.ok(exits.includes(0));
    assert.ok(!order.includes('triage'));
    assert.ok(!order.includes('seq-decomposer'));
    assert.ok(spawnFn.calls.some((c) => c.args.includes('--unit')));
    assert.ok(createWorktreeFn.mock.callCount() >= 1);
    const firstUnitArg = spawnFn.calls.find((c) => c.args.includes('--unit')).args;
    assert.match(firstUnitArg[firstUnitArg.indexOf('--unit') + 1], /^wise-pine-e904:01-types$/);
  });

  it('unknown slug exits 1', async () => {
    const cwd = makeTmpCwd('orch-from-miss-');
    const exits = [];
    await runSeqPipeline('', {
      agent: 'claude',
      AgentClass: createMockAgentClass({}),
      cwd,
      jobSlug: 'missing-slug',
      jobCwd: cwd,
      fromSlug: 'missing-slug',
      exit: (code) => { exits.push(code); },
    });
    assert.deepEqual(exits, [1]);
  });

  it('already-done seq exits 0 without spawn', async () => {
    const cwd = makeTmpCwd('orch-from-done-');
    const slug = 'done-seq-1';
    fs.mkdirSync(path.join(cwd, '.orch', slug), { recursive: true });
    writeSeq(cwd, slug, plannedSeq({
      parentSlug: slug,
      state: 'done',
      units: THREE_UNITS.map((u) => ({
        ...u, state: 'done', slug: 'u', sha: 's', changedFiles: [],
      })),
    }));
    writeJob(cwd, slug, {
      slug, task: 't', agent: 'claude', state: 'done', phase: 'schedule',
      exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });

    const spawnFn = mock.fn(() => { throw new Error('should not spawn'); });
    const exits = [];
    await runSeqPipeline('', {
      agent: 'claude',
      AgentClass: createMockAgentClass({}),
      cwd,
      jobSlug: slug,
      jobCwd: cwd,
      fromSlug: slug,
      spawn: spawnFn,
      exit: (code) => { exits.push(code); },
    });
    assert.deepEqual(exits, [0]);
    assert.equal(spawnFn.mock.callCount(), 0);
  });
});

describe('--decompose / --from CLI', () => {
  it('documents --decompose and --from in --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--decompose/);
    assert.match(stdout, /--from/);
  });

  for (const conflicting of ['--seq', '--fan-out', '--ask', '--quick', '--dry-run']) {
    it(`rejects --decompose combined with ${conflicting}`, async () => {
      const cwd = makeTmpCwd('orch-decomp-cli-');
      const { code, stderr } = await runCli(
        ['a trivial task', '--decompose', conflicting, '--agent', 'claude'],
        { cwd },
      );
      assert.notEqual(code, 0);
      assert.match(stderr + '', /cannot be combined|Error:/i);
      assert.equal(fs.existsSync(path.join(cwd, '.orch')) && fs.readdirSync(path.join(cwd, '.orch')).some((s) => {
        try { return readSeq(cwd, s)?.state === 'planned'; } catch { return false; }
      }), false);
    });
  }

  it('rejects --seq --from with a task prompt', async () => {
    const { code, stderr } = await runCli(
      ['should not be here', '--seq', '--from', 'some-slug', '--agent', 'claude'],
    );
    assert.notEqual(code, 0);
    assert.match(stderr + '', /does not take a task|--from/i);
  });

  it('rejects --max-units with --seq --from', async () => {
    const cwd = makeTmpCwd('orch-from-max-');
    const slug = 'plan-slug';
    fs.mkdirSync(path.join(cwd, '.orch', slug), { recursive: true });
    writeSeq(cwd, slug, plannedSeq({ parentSlug: slug }));
    const { code, stderr } = await runCli(
      ['--seq', '--from', slug, '--max-units', '4', '--agent', 'claude'],
      { cwd },
    );
    assert.notEqual(code, 0);
    assert.match(stderr + '', /max-units/i);
  });

  it('rejects --from without --seq', async () => {
    const { code, stderr } = await runCli(['--from', 'x', '--agent', 'claude']);
    assert.notEqual(code, 0);
    assert.match(stderr + '', /--from requires --seq/i);
  });

  it('unknown --seq --from slug exits 1', async () => {
    const cwd = makeTmpCwd('orch-from-cli-miss-');
    const { code, stderr } = await runCli(
      ['--seq', '--from', 'no-such-slug', '--agent', 'claude'],
      { cwd },
    );
    assert.notEqual(code, 0);
    assert.match(stderr + '', /unknown parent|no seq\.json/i);
  });
});

describe('runDetached decompose', () => {
  it('spawns a detached child with --decompose / --max-units and no coordinator role', async () => {
    const cwd = makeTmpCwd('orch-detach-decomp-');
    const spawnMock = mock.fn(() => ({ pid: 4242, unref() {} }));
    const exit = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('plan this', {
        agent: 'claude',
        maxRounds: 5,
        decompose: true,
        maxUnits: 6,
        cwd,
        spawn: spawnMock,
        exit,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(spawnMock.mock.calls.length, 1);
    const [, args, spawnOptions] = spawnMock.mock.calls[0].arguments;
    assert.ok(args.includes('--decompose'));
    assert.ok(args.includes('--max-units'));
    assert.ok(args.includes('6'));
    assert.ok(!args.includes('--seq'));
    assert.ok(!args.includes('--detach'));
    const slug = spawnOptions.env.ORCH_JOB_SLUG;
    const job = readJob(cwd, slug);
    assert.ok(job.role == null || job.role === '-' || job.role === '');
    assert.equal(exit.mock.calls[0].arguments[0], 0);
  });
});
