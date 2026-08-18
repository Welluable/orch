import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContinuePipeline, runSeqContinuePipeline, cascadeStop, formatJobsTable, formatStatus } from '../main.js';
import { readJob, writeJob, listJobs } from '../lib/jobs.js';
import { readSeq, writeSeq } from '../lib/seq.js';
import { validateContinue } from '../lib/continue.js';
import { writeConfig, localConfigPath } from '../lib/config.js';

/**
 * Contract this file pins down for seq Phase 4 continue / resume / cascade /
 * job-tree presentation (see .spec/seq.md Failure and resume / Decision 14
 * and task.md Phase 4). Mirrors fan-out continue + job-tree coverage.
 *
 * - Successful `orch continue <unit-slug>` for a seq unit (`role:"worker"`
 *   with parent that has `seq.json`) patches **seq.json** (unit → `done`
 *   with sha/changedFiles), not fanout.json.
 * - `validateContinue` / CLI refuse continue on a seq coordinator: message
 *   points at unit continue + `orch --seq-continue` / resume (not only
 *   `--integrate`).
 * - Hidden `orch --seq-continue <parent-slug>`: merge fixed unit if needed →
 *   verify → adjust → pending loop (`runSeqContinuePipeline`).
 * - `cascadeStop` discovers live unit children from **seq.json** as well as
 *   fanout.json.
 * - `formatJobsTable` / `formatStatus` present seq coordinator + unit
 *   (`role:"worker"`) children the same way as fan-out (indented tree, no
 *   integrate child required).
 * - `orch pause|resume <seq-parent>` cascade to live unit children (mid-seq
 *   job-tree control; schedule-loop pause gating lives in
 *   seq-coordinator.test.js).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix = 'orch-seq-continue-') {
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

function createMockAgentClass(behaviors) {
  const instances = [];
  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
      instances.push(this);
    }

    async run() {
      const behavior = behaviors[agentRole(this.name)];
      if (!behavior) throw new Error(`MockAgent: no scripted behavior for role "${agentRole(this.name)}"`);
      return behavior;
    }
  }
  MockAgent.instances = instances;
  return MockAgent;
}

function workerPassBehaviors() {
  return {
    research: { ok: true, result: withSummary('research-output', 'research ok') },
    planner: { ok: true, result: withSummary('planner-output', 'planner ok') },
    'test-writer': { ok: true, result: withSummary('tests written', 'writer ok') },
    'test-critic': { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), 'critic ok') },
    'code-writer': { ok: true, result: withSummary('implemented', 'code ok') },
    'test-runner': { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), 'runner ok') },
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

function baseUnit(overrides = {}) {
  return {
    id: '01-types',
    title: 'billing types',
    subtask: 'Add shared billing types and stubs.',
    state: 'pending',
    slug: null,
    sha: null,
    changedFiles: null,
    ...overrides,
  };
}

function baseSeq(overrides = {}) {
  return {
    version: 1,
    parentSlug: 'wise-pine-e904',
    task: 'implement the billing module',
    base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    tip: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    maxUnits: 8,
    units: [
      baseUnit({
        id: '01-types',
        state: 'done',
        slug: 'rapid-fox-x7q2',
        sha: 'bbb1111',
        changedFiles: ['src/billing/types.ts'],
      }),
      baseUnit({
        id: '02-api',
        title: 'invoice API',
        subtask: 'Implement create/list invoice endpoints.',
        state: 'failed',
        slug: 'merry-elk-r4b1',
        sha: null,
        changedFiles: null,
      }),
      baseUnit({
        id: '03-ui',
        title: 'invoice UI',
        subtask: 'Build invoice list UI.',
        state: 'pending',
      }),
    ],
    adjustments: [],
    state: 'failed',
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function seedUnitJob(cwd, slug, overrides = {}) {
  const worktreePath = overrides.worktree === undefined
    ? path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`)
    : overrides.worktree;
  if (worktreePath) fs.mkdirSync(worktreePath, { recursive: true });
  writeJob(cwd, slug, {
    slug,
    task: 'Implement create/list invoice endpoints.',
    agent: 'claude',
    maxRounds: 5,
    cwd,
    pauseRequested: false,
    branch: worktreePath ? `orch/${slug}` : null,
    worktree: worktreePath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    logPath: path.join(cwd, '.orch', slug, 'orch.log'),
    pid: null,
    state: 'failed',
    phase: null,
    stage: null,
    round: null,
    parent: 'wise-pine-e904',
    role: 'worker',
    workerId: '02-api',
    ...overrides,
  });
  return worktreePath;
}

describe('validateContinue — seq coordinator refuse hint', () => {
  it('refuses continue on a seq coordinator and mentions seq-continue or resume (not only --integrate)', () => {
    const cwd = makeTmpCwd();
    const parentSlug = 'wise-pine-e904';
    writeJob(cwd, parentSlug, {
      slug: parentSlug,
      task: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      cwd,
      pauseRequested: false,
      branch: null,
      worktree: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      logPath: path.join(cwd, '.orch', parentSlug, 'orch.log'),
      pid: null,
      state: 'failed',
      parent: null,
      role: 'coordinator',
      workerId: null,
    });
    writeSeq(cwd, parentSlug, baseSeq());

    assert.throws(
      () => validateContinue(cwd, parentSlug, { task: 'fix the unit' }),
      (err) => {
        const msg = String(err.message || err);
        assert.match(msg, /coordinator/i);
        assert.match(msg, /seq-continue|resume/i);
        return true;
      },
    );
  });
});

describe('runContinuePipeline — successful seq unit continue patches seq.json', () => {
  it('marks the continued unit done in seq.json with sha and changedFiles', async () => {
    const cwd = makeTmpCwd();
    const parentSlug = 'wise-pine-e904';
    const unitSlug = 'merry-elk-r4b1';
    writeSeq(cwd, parentSlug, baseSeq());
    const worktreePath = seedUnitJob(cwd, unitSlug);
    fs.mkdirSync(path.join(cwd, '.orch', unitSlug), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.orch', unitSlug, 'status.md'),
      `# Status\n\n- Slug: \`${unitSlug}\`\n- Branch: \`orch/${unitSlug}\`\n- Worktree: \`${worktreePath}\`\n- Parent: \`${parentSlug}\`\n- Worker: \`02-api\`\n`,
    );

    const AgentClass = createMockAgentClass(workerPassBehaviors());
    const exit = mock.fn();

    await runContinuePipeline('fix the invoice API and finish the unit', {
      cwd,
      slug: unitSlug,
      agent: 'claude',
      AgentClass,
      createRunContext: () => fakeRunContext(cwd, unitSlug),
      createWorktree: async () => ({ worktreePath, branch: `orch/${unitSlug}` }),
      commitWorktree: async () => ({ sha: 'continued-sha' }),
      collectWorktreeChanges: async () => [],
      recordChangedFiles: () => ['src/billing/invoices.ts'],
      patchJob: () => {},
      checkpointPause: async () => {},
      exit,
    });

    const seq = readSeq(cwd, parentSlug);
    const unit = seq.units.find((u) => u.id === '02-api');
    assert.equal(unit.state, 'done');
    assert.equal(unit.sha, 'continued-sha');
    assert.deepEqual(unit.changedFiles, ['src/billing/invoices.ts']);
    assert.equal(unit.slug, unitSlug);
  });
});

describe('runSeqContinuePipeline / --seq-continue', () => {
  it('merges a fixed done-but-unmerged unit, adjusts, and continues pending loop', async () => {
    const cwd = makeTmpCwd();
    const prefix = pinLocalBranchPrefix(cwd);
    const parentSlug = 'wise-pine-e904';
    const storedUnitBranch = 'team_session/merry-elk-r4b1';
    writeJob(cwd, parentSlug, {
      slug: parentSlug,
      task: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      cwd,
      state: 'failed',
      role: 'coordinator',
      pid: null,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      logPath: path.join(cwd, '.orch', parentSlug, 'orch.log'),
      branch: null,
      worktree: null,
      pauseRequested: false,
      parent: null,
      workerId: null,
    });
    writeJob(cwd, 'merry-elk-r4b1', {
      slug: 'merry-elk-r4b1',
      task: 'Implement API.',
      agent: 'claude',
      maxRounds: 5,
      cwd,
      state: 'done',
      role: 'worker',
      parent: parentSlug,
      workerId: '02-api',
      branch: storedUnitBranch,
      worktree: path.join(path.dirname(cwd), `${path.basename(cwd)}-merry-elk-r4b1`),
      pid: null,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      logPath: path.join(cwd, '.orch', 'merry-elk-r4b1', 'orch.log'),
      pauseRequested: false,
    });
    writeSeq(cwd, parentSlug, baseSeq({
      units: [
        baseUnit({
          id: '01-types',
          state: 'done',
          slug: 'rapid-fox-x7q2',
          sha: 'bbb1111',
          changedFiles: [],
        }),
        baseUnit({
          id: '02-api',
          title: 'invoice API',
          subtask: 'Implement API.',
          state: 'done',
          slug: 'merry-elk-r4b1',
          sha: 'continued-sha',
          changedFiles: ['src/billing/invoices.ts'],
        }),
        baseUnit({
          id: '03-ui',
          title: 'invoice UI',
          subtask: 'Build UI.',
          state: 'pending',
        }),
      ],
      state: 'running',
    }));

    const mergeCalls = [];
    const spawnCalls = [];
    const AgentClass = createMockAgentClass({
      adjust: { ok: true, result: withSummary(JSON.stringify({ rewrites: [], drops: [] }), 'adjust ok') },
    });
    const exit = mock.fn();

    await runSeqContinuePipeline({
      cwd,
      parentSlug,
      agent: 'claude',
      AgentClass,
      jobSlug: parentSlug,
      jobCwd: cwd,
      mergeOneUnit: async ({ unitId, unitBranch }) => {
        mergeCalls.push({ unitId, unitBranch });
        const seq = readSeq(cwd, parentSlug);
        writeSeq(cwd, parentSlug, { ...seq, tip: `tip-after-${unitId}` });
      },
      spawn: (execPath, args, options) => {
        spawnCalls.push({ args, options });
        const child = { pid: 55001, unref() {}, kill() {}, on() { return child; } };
        // Immediately mark spawned unit done so the loop can finish in tests that
        // only assert merge-of-fixed-unit behavior.
        const unitIdx = args.indexOf('--unit');
        if (unitIdx !== -1) {
          const [, unitId] = args[unitIdx + 1].split(':');
          setTimeout(() => {
            const seq = readSeq(cwd, parentSlug);
            writeSeq(cwd, parentSlug, {
              ...seq,
              units: seq.units.map((u) => (
                u.id === unitId
                  ? { ...u, state: 'done', sha: `sha-${unitId}`, slug: options.env.ORCH_JOB_SLUG, changedFiles: [] }
                  : u
              )),
            });
            writeJob(cwd, options.env.ORCH_JOB_SLUG, {
              slug: options.env.ORCH_JOB_SLUG,
              state: 'done',
              pid: child.pid,
              role: 'worker',
              parent: parentSlug,
              workerId: unitId,
            });
          }, 20);
        }
        return child;
      },
      allocateJob: ({ prompt, workerId }) => {
        const slug = `spawned-${workerId}`;
        fs.mkdirSync(path.join(cwd, '.orch', slug), { recursive: true });
        writeJob(cwd, slug, {
          slug,
          task: prompt,
          state: 'starting',
          role: 'worker',
          parent: parentSlug,
          workerId,
          pid: null,
        });
        return { slug, runContext: fakeRunContext(cwd, slug), record: { slug } };
      },
      reconcileJob: (c, slug) => readJob(c, slug),
      pollIntervalMs: 15,
      exit,
      patchJob: () => {},
      checkpointPause: async () => {},
    });

    const mergedIds = mergeCalls.map((c) => c.unitId);
    assert.ok(mergedIds.includes('02-api'), `expected merge of fixed unit 02-api, got ${mergedIds}`);
    const apiMerge = mergeCalls.find((c) => c.unitId === '02-api');
    assert.equal(apiMerge.unitBranch, storedUnitBranch, 'done-but-unmerged unitBranch must use stored unit run.json.branch');
    const uiMerge = mergeCalls.find((c) => c.unitId === '03-ui');
    assert.ok(uiMerge, `expected merge of spawned 03-ui, got ${mergedIds}`);
    assert.equal(uiMerge.unitBranch, `${prefix}/spawned-03-ui`, 'spawned unitBranch must derive prefix/slug when run.json.branch is unset');
    assert.notEqual(uiMerge.unitBranch, 'orch/spawned-03-ui');
  });

  it('CLI --seq-continue rejects an unknown parent without seq.json', async () => {
    const cwd = makeTmpCwd();
    const { code, stderr } = await runCli(['--seq-continue', 'missing-parent-0000'], { cwd });
    assert.notEqual(code, 0);
    assert.match(stderr + '', /seq\.json|unknown|not found|missing/i);
  });
});

describe('cascadeStop — discovers seq.json unit children', () => {
  it('SIGTERMs a live seq unit child when stopping the parent', () => {
    const cwd = makeTmpCwd();
    const parentSlug = 'wise-pine-e904';
    writeJob(cwd, parentSlug, {
      slug: parentSlug,
      state: 'running',
      pid: 100,
      role: 'coordinator',
      parent: null,
    });
    writeSeq(cwd, parentSlug, baseSeq({
      state: 'running',
      units: [
        baseUnit({ id: '01-types', state: 'done', slug: 'unit-done-aaaa', sha: 'x', changedFiles: [] }),
        baseUnit({ id: '02-api', state: 'running', slug: 'unit-live-bbbb', sha: null }),
      ],
    }));
    writeJob(cwd, 'unit-live-bbbb', {
      slug: 'unit-live-bbbb',
      state: 'running',
      pid: 200,
      role: 'worker',
      parent: parentSlug,
      workerId: '02-api',
    });

    const killed = [];
    cascadeStop(cwd, parentSlug, {
      kill: (pid, signal) => killed.push({ pid, signal }),
      isPidAlive: (pid) => pid === 100 || pid === 200,
    });

    assert.ok(killed.some((k) => k.pid === 200 && k.signal === 'SIGTERM'));
    assert.ok(killed.some((k) => k.pid === 100 && k.signal === 'SIGTERM'));
  });
});

describe('formatJobsTable / formatStatus — seq coordinator + unit children', () => {
  function baseRecord(overrides = {}) {
    const slug = overrides.slug ?? 'stub-stub-0000';
    return {
      slug,
      task: 'implement the billing module',
      agent: 'claude',
      maxRounds: 5,
      cwd: '/tmp/wherever',
      pauseRequested: false,
      branch: null,
      worktree: null,
      startedAt: overrides.startedAt ?? new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      logPath: `/tmp/wherever/.orch/${slug}/orch.log`,
      pid: process.pid,
      state: 'running',
      phase: 'schedule',
      stage: null,
      round: null,
      parent: null,
      role: null,
      workerId: null,
      ...overrides,
    };
  }

  function seedJob(cwd, overrides = {}) {
    const record = baseRecord({
      cwd,
      logPath: path.join(cwd, '.orch', overrides.slug ?? 'stub-stub-0000', 'orch.log'),
      ...overrides,
    });
    writeJob(cwd, record.slug, record);
    return record;
  }

  it('renders a seq coordinator with unit workers indented under it (ROLE column; no integrate required)', () => {
    const parent = baseRecord({
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    const unitDone = baseRecord({
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '01-types',
      state: 'done',
      phase: 'commit',
      agent: 'cursor',
      pid: 12010,
      startedAt: '2026-07-26T12:00:01.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      exitCode: 0,
    });
    const unitRunning = baseRecord({
      slug: 'merry-elk-r4b1',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '02-api',
      state: 'running',
      phase: 'code-loop',
      agent: 'cursor',
      pid: 12014,
      startedAt: '2026-07-26T12:00:02.000Z',
    });

    const table = formatJobsTable([parent, unitRunning, unitDone]);
    const lines = table.split('\n');
    assert.match(lines[0], /^SLUG\s+ROLE\s+STATE\s+PHASE\s+AGENT\s+STARTED\s+DURATION\s+PID$/);

    const parentIdx = lines.findIndex((l) => l.startsWith('wise-pine-e904'));
    assert.ok(parentIdx > 0);
    assert.match(lines[parentIdx], /^wise-pine-e904\s+coordinator\s+running\s+schedule\s+cursor\s+.+\s+12001$/);
    assert.match(lines[parentIdx + 1], /^ {2}rapid-fox-x7q2\s+worker\s+done\s+commit\s+cursor\s+.+\s+-$/);
    assert.match(lines[parentIdx + 2], /^ {2}merry-elk-r4b1\s+worker\s+running\s+code-loop\s+cursor\s+.+\s+12014$/);
  });

  it('formatStatus expands seq unit children under the coordinator and shows parent: on a unit', () => {
    const cwd = makeTmpCwd('orch-seq-status-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, {
      slug: parentSlug,
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: parentSlug,
      role: 'worker',
      workerId: '01-types',
      state: 'done',
      phase: 'commit',
      branch: 'orch/rapid-fox-x7q2',
      agent: 'cursor',
      pid: 12010,
      startedAt: '2026-07-26T12:00:01.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      exitCode: 0,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: '02-api',
      state: 'running',
      phase: 'code-loop',
      branch: 'orch/merry-elk-r4b1',
      agent: 'cursor',
      pid: 12014,
      startedAt: '2026-07-26T12:00:02.000Z',
    });
    writeSeq(cwd, parentSlug, baseSeq({ state: 'running' }));

    const parentOut = formatStatus(cwd, readJob(cwd, parentSlug));
    assert.match(parentOut, /^slug:\s+wise-pine-e904$/m);
    assert.match(parentOut, /rapid-fox-x7q2/);
    assert.match(parentOut, /merry-elk-r4b1/);
    assert.match(parentOut, /rapid-fox-x7q2[\s\S]*?\bdone\b/);
    assert.match(parentOut, /merry-elk-r4b1[\s\S]*?\brunning\b/);

    const childOut = formatStatus(cwd, readJob(cwd, 'merry-elk-r4b1'));
    assert.match(childOut, /^parent:\s+wise-pine-e904$/m);
    assert.equal(childOut.includes('rapid-fox-x7q2'), false, 'unit status must not list siblings');
  });
});

describe('orch pause|resume — cascade for seq coordinator mid-schedule', () => {
  it('orch pause <seq-parent> cascades to the live unit child; resume clears both', async () => {
    const cwd = makeTmpCwd('orch-seq-cli-pause-');
    const parentSlug = 'wise-pine-e904';
    writeJob(cwd, parentSlug, {
      slug: parentSlug,
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
      logPath: path.join(cwd, '.orch', parentSlug, 'orch.log'),
      pid: process.pid,
      state: 'running',
      phase: 'schedule',
      parent: null,
      role: 'coordinator',
      workerId: null,
    });
    writeJob(cwd, 'merry-elk-r4b1', {
      slug: 'merry-elk-r4b1',
      task: 'Implement API.',
      agent: 'claude',
      maxRounds: 5,
      cwd,
      pauseRequested: false,
      branch: 'orch/merry-elk-r4b1',
      worktree: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      logPath: path.join(cwd, '.orch', 'merry-elk-r4b1', 'orch.log'),
      pid: process.pid,
      state: 'running',
      phase: 'code-loop',
      parent: parentSlug,
      role: 'worker',
      workerId: '02-api',
    });
    writeSeq(cwd, parentSlug, baseSeq({
      state: 'running',
      units: [
        baseUnit({ id: '01-types', state: 'done', slug: 'rapid-fox-x7q2', sha: 'x', changedFiles: [] }),
        baseUnit({ id: '02-api', title: 'invoice API', subtask: 'Implement API.', state: 'running', slug: 'merry-elk-r4b1' }),
        baseUnit({ id: '03-ui', title: 'invoice UI', subtask: 'Build UI.', state: 'pending' }),
      ],
    }));

    const paused = await runCli(['pause', parentSlug], { cwd });
    assert.equal(paused.code, 0, paused.stderr);
    assert.equal(readJob(cwd, parentSlug).pauseRequested, true);
    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, true);

    // Flip parent+child into paused so resume has a clear non-terminal pause to clear.
    writeJob(cwd, parentSlug, { ...readJob(cwd, parentSlug), state: 'paused' });
    writeJob(cwd, 'merry-elk-r4b1', { ...readJob(cwd, 'merry-elk-r4b1'), state: 'paused' });

    const resumed = await runCli(['resume', parentSlug], { cwd });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(readJob(cwd, parentSlug).pauseRequested, false);
    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, false);
    assert.ok(listJobs(cwd).some((j) => j.slug === parentSlug));
  });
});