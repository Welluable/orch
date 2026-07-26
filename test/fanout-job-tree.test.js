import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatJobsTable,
  formatStatus,
  cascadeStop,
  runFanoutPipeline,
} from '../main.js';
import {
  cascadePause,
  cascadeResume,
  writeJob,
  readJob,
  listJobs,
  patchJob,
  jobPaths,
  requestResume,
  checkpointPause as realCheckpointPause,
} from '../lib/jobs.js';
import { readFanout, writeFanout, patchWorker, patchIntegration } from '../lib/fanout.js';
import { allocateJob as realAllocateJob } from '../lib/job-lifecycle.js';

/**
 * Contract this file pins down for fan-out phase 4 — job tree + cascade
 * control (see `.spec/fanout-4-job-tree.md` and `.spec/fanout.md` decisions
 * 18–19 / "Job tree rendering" / "Cascade pause / resume / stop").
 *
 * None of `formatJobsTable`'s tree layout, `formatStatus`'s parent/child
 * expansion, `cascadePause` / `cascadeResume` / `cascadeStop`, parent-aware
 * CLI pause/resume/stop wiring, or coordinator schedule-loop
 * `jobCheckpoint` calls exist yet as of this test-writing round — these
 * tests describe the contract the next implementation round must satisfy.
 *
 * ## formatJobsTable(jobs)
 * - Columns: `SLUG ROLE STATE PHASE AGENT PID` (ROLE added; STARTED omitted
 *   to match the phase-4 / fanout.md sample).
 * - Top-level rows: jobs with no `parent` (coordinators + ordinary runs),
 *   most-recent-first among themselves.
 * - Children (jobs whose `parent` matches a top-level slug) indent two
 *   spaces under that coordinator; order is workers first (stable among
 *   themselves by `startedAt` ascending — spawn order), then the
 *   `integration` child last. Display role `integration` as `integrate`;
 *   null role as `-`.
 * - Terminal jobs show PID `-`; live jobs show their pid.
 *
 * ## formatStatus(cwd, record)
 * - Parent (`role === 'coordinator'` or has children with matching
 *   `parent`): prints the usual record fields, then each child in the same
 *   tree order as `formatJobsTable`, with at least state/phase/branch.
 * - Child (`parent` set): prints the usual fields plus `parent: <slug>`;
 *   does **not** list siblings. The parent slug may appear on the `parent:`
 *   line (exactly once) — do not assert against `includes('<parent>\n')`.
 * - Default `orch status` (no slug): most-recent job from `listJobs`, same
 *   parent-vs-child view as an explicit slug.
 *
 * ## cascadePause(cwd, parentSlug) → { childrenSignaled }
 * - `requestPause` on the parent; for every job with `parent === parentSlug`
 *   in live states `running`/`pausing`/`paused`, the same pause write.
 * - Returns `{ childrenSignaled: <number of children pause-written> }`
 *   (CLI prints this count). Does not touch unrelated top-level jobs.
 *
 * ## cascadeResume(cwd, parentSlug) → { childrenSignaled }
 * - `requestResume` on the parent; cascade resume only to non-terminal
 *   children that are `paused`/`pausing`. Running children are left alone.
 *
 * ## cascadeStop(cwd, parentSlug, { kill, isPidAlive } = {})
 * - SIGTERM the parent pid if alive, then every live child pid (compose /
 *   extend `cascadeStopFanoutChildren` so CLI stop also stops the parent;
 *   the coordinator signal handler may keep calling the child-only helper).
 *
 * ## CLI wiring (`orch pause|resume|stop <slug>`)
 * - If `role === 'coordinator'` (or the slug has children with matching
 *   `parent`), use the cascade helpers; else keep leaf
 *   `requestPause` / `requestResume` / `stopJob`. Parent pause stdout
 *   reports the child signal count.
 *
 * ## Coordinator schedule / poll (phase-4 locks)
 * - `await jobCheckpoint()` before spawning the next worker and on each
 *   poll tick; while paused do not spawn, do not advance, do not kill
 *   children.
 * - Resume mid-fan-out (in-process): clearing pause does not re-run
 *   boundaries/decompose; **re-attach** to still-live children (no re-spawn);
 *   spawn only still-`pending` workers; no duplicate of live/`done`/
 *   `failed`/`skipped` workers.
 * - Integrate: spawn only after every worker has settled, and only when no
 *   integrate job is already live or `done` (no duplicate on resume).
 * - Leaf pause: coordinator waits; does not mark failed; does not start
 *   dependents.
 * - Leaf stop / crash / failed: mark worker `failed` in `fanout.json`;
 *   skip dependents; continue schedule.
 * - Parent cascade stop: all live child pids including integrate.
 * - Default `orch status` (no slug): most-recent job via `listJobs`, with the
 *   same parent-tree vs child-`parent:` view as an explicit slug.
 *
 * ## logs
 * - `orch logs <parent>` remains coordinator-log-only (no multi-file
 *   follow). Covered by asserting the existing single-slug log path
 *   behavior is unchanged for a parent slug.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix = 'orch-fanout-tree-') {
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
    phase: 'test-loop',
    stage: 'test-writer',
    round: 1,
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

function withSummary(result, summary) {
  return typeof result === 'string'
    ? `${result}\n\n<<<SUMMARY>>>\n${summary}\n`
    : result;
}

function createMockAgentClass(behaviors) {
  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
    }

    async run() {
      const role = String(this.name).replace(/\s+\d+\/\d+$/, '');
      const behavior = behaviors[this.name] ?? behaviors[role];
      if (typeof behavior === 'function') return behavior(this);
      if (behavior && typeof behavior === 'object' && 'ok' in behavior) return behavior;
      return { ok: true, result: withSummary('ok', `${role} ok`) };
    }
  }
  return MockAgent;
}

const TRIAGE_COMPLEX = {
  ok: true,
  result: withSummary(JSON.stringify({
    simple: false,
    reason: 'multi-area change',
    recommendedAgent: null,
  }), 'complex'),
};

const BOUNDARIES_OK = {
  ok: true,
  result: withSummary('partitionable into independent workers', 'boundaries ok'),
};

function decomposeReply(workers, why = 'independent endpoints') {
  return {
    ok: true,
    result: withSummary(JSON.stringify({ decomposable: true, why, workers }), 'decomposer ok'),
  };
}

function makeFakeExecFile(rules) {
  return {
    execFile: mock.fn((command, args) => {
      for (const rule of rules) {
        if (rule.match(args)) return rule.stdout;
      }
      throw new Error(`unexpected execFile: ${command} ${args.join(' ')}`);
    }),
  };
}

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
    phase: 'schedule',
    stage: null,
    round: null,
    parent: null,
    role: 'coordinator',
    workerId: null,
    ...overrides,
  });
}

/**
 * Fake spawn that can hold a worker in a non-terminal state (paused /
 * running) until a caller flips it, so leaf-pause / parent-pause /
 * resume-reattach tests can observe coordinator wait behavior.
 *
 * `outcomes[workerId]` may be:
 * - `'done' | 'failed' | 'crash'` — settle after `delayMs` (same as
 *   fanout-coordinator)
 * - `'hold'` — leave the child `running` forever (caller patches later)
 * - `'pause-then-done'` — after `delayMs`, flip child run.json to
 *   `paused`/`pauseRequested:true` and leave it there until
 *   `releasePaused(workerId)` is called, which then marks done.
 *
 * `integrationOutcome` may be `'done' | 'failed' | 'hold'`. When `'hold'`,
 * call `releaseIntegrate()` to settle the live integrate child.
 */
function fakeChildSpawn({ cwd, parentSlug, outcomes = {}, integrationOutcome, delayMs = 15 }) {
  let pid = 900000;
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const releasePaused = Object.create(null);
  let releaseIntegrateFn = null;

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

      if (outcome === 'hold') {
        // Leave running; caller owns settlement.
      } else if (outcome === 'pause-then-done') {
        setTimeout(() => {
          patchJob(cwd, workerSlug, {
            state: 'paused',
            pauseRequested: true,
            phase: 'code-loop',
          });
          releasePaused[workerId] = () => {
            active -= 1;
            patchJob(cwd, workerSlug, {
              state: 'done',
              pauseRequested: false,
              exitCode: 0,
              finishedAt: new Date().toISOString(),
            });
            patchWorker(cwd, parentSlug, workerId, {
              state: 'done',
              sha: fakeSha(workerId),
              changedFiles: [`src/${workerId}.ts`],
            });
          };
        }, delayMs);
      } else if (outcome !== 'crash') {
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
    } else if (integrateIdx !== -1) {
      const integrationSlug = options.env.ORCH_JOB_SLUG;
      if (integrationOutcome === 'hold') {
        releaseIntegrateFn = () => {
          active -= 1;
          patchJob(cwd, integrationSlug, {
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
          });
          patchIntegration(cwd, parentSlug, {
            state: 'done',
            sha: 'integrationsha00000000000000000000000',
          });
          releaseIntegrateFn = null;
        };
      } else {
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
    }

    return { pid: thisPid, unref: () => {} };
  });

  return {
    spawnFn,
    calls,
    maxActive: () => maxActive,
    releasePaused: (workerId) => {
      if (typeof releasePaused[workerId] !== 'function') {
        throw new Error(`no paused worker to release: ${workerId}`);
      }
      releasePaused[workerId]();
    },
    releaseIntegrate: () => {
      if (typeof releaseIntegrateFn !== 'function') {
        throw new Error('no held integrate child to release');
      }
      releaseIntegrateFn();
    },
  };
}

function makeDeterministicAllocateJob() {
  return mock.fn((opts) => {
    const generateSlug = () => (opts.role === 'integration' ? 'tidy-heron-m2p9' : `${opts.workerId}-slug`);
    return realAllocateJob({ ...opts, generateSlug });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// formatJobsTable — indented tree + ROLE column
// ---------------------------------------------------------------------------

describe('formatJobsTable — job tree rendering', () => {
  it('renders a coordinator with mixed children indented under it, ROLE column, and ordinary top-level jobs unindented', () => {
    const parent = baseRecord({
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    const workerDone = baseRecord({
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '02-invoices',
      state: 'done',
      phase: 'commit',
      agent: 'cursor',
      pid: 12010,
      startedAt: '2026-07-26T12:00:01.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      exitCode: 0,
    });
    const workerPaused = baseRecord({
      slug: 'merry-elk-r4b1',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: '03-charges',
      state: 'paused',
      phase: 'code-loop',
      agent: 'cursor',
      pid: 12014,
      startedAt: '2026-07-26T12:00:02.000Z',
    });
    const integrate = baseRecord({
      slug: 'tidy-heron-m2p9',
      parent: 'wise-pine-e904',
      role: 'integration',
      state: 'pending',
      phase: null,
      agent: 'cursor',
      pid: null,
      startedAt: '2026-07-26T12:00:03.000Z',
    });
    const solo = baseRecord({
      slug: 'solo-meadow-a1b2',
      role: null,
      parent: null,
      state: 'running',
      phase: 'test-loop',
      agent: 'claude',
      pid: 13002,
      // More recent than the coordinator → appears first among top-level rows.
      startedAt: '2026-07-26T13:00:00.000Z',
    });

    // Flat most-recent-first input, as listJobs returns today — grouping is
    // a presentation concern inside formatJobsTable.
    const table = formatJobsTable([solo, parent, integrate, workerPaused, workerDone]);
    const lines = table.split('\n');

    assert.match(lines[0], /^SLUG\s+ROLE\s+STATE\s+PHASE\s+AGENT\s+PID$/);
    assert.equal(lines[0].includes('STARTED'), false, 'phase-4 sample omits STARTED');

    const body = lines.slice(1).join('\n');
    // Top-level most-recent-first: solo before coordinator.
    assert.match(body, /^solo-meadow-a1b2\s+-\s+running\s+test-loop\s+claude\s+13002$/m);
    assert.match(body, /^wise-pine-e904\s+coordinator\s+running\s+schedule\s+cursor\s+12001$/m);

    // Children indented two spaces under their parent, workers then integrate.
    const parentIdx = lines.findIndex((l) => l.startsWith('wise-pine-e904'));
    assert.ok(parentIdx > 0);
    assert.match(lines[parentIdx + 1], /^ {2}rapid-fox-x7q2\s+worker\s+done\s+commit\s+cursor\s+-$/);
    assert.match(lines[parentIdx + 2], /^ {2}merry-elk-r4b1\s+worker\s+paused\s+code-loop\s+cursor\s+12014$/);
    assert.match(lines[parentIdx + 3], /^ {2}tidy-heron-m2p9\s+integrate\s+pending\s+-\s+cursor\s+-$/);

    // Solo is top-level (no leading spaces on the slug column).
    const soloLine = lines.find((l) => l.includes('solo-meadow-a1b2'));
    assert.ok(soloLine);
    assert.equal(soloLine.startsWith('  '), false);
  });

  it('keeps an ordinary job with no parent as a single top-level row with ROLE "-"', () => {
    const table = formatJobsTable([
      baseRecord({
        slug: 'lonely-bay-0001',
        role: null,
        parent: null,
        state: 'running',
        phase: 'research',
        agent: 'agn',
        pid: 42,
      }),
    ]);
    const lines = table.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^lonely-bay-0001\s+-\s+running\s+research\s+agn\s+42$/);
  });
});

// ---------------------------------------------------------------------------
// formatStatus — parent tree vs child parent line
// ---------------------------------------------------------------------------

describe('formatStatus — parent tree vs child parent line', () => {
  it('expands children under a coordinator in tree order (state/phase/branch)', () => {
    const cwd = makeTmpCwd('orch-status-parent-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
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
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      phase: 'code-loop',
      branch: 'orch/merry-elk-r4b1',
      agent: 'cursor',
      pid: 12014,
      startedAt: '2026-07-26T12:00:02.000Z',
    });
    seedJob(cwd, {
      slug: 'tidy-heron-m2p9',
      parent: 'wise-pine-e904',
      role: 'integration',
      state: 'pending',
      phase: null,
      branch: null,
      agent: 'cursor',
      pid: null,
      startedAt: '2026-07-26T12:00:03.000Z',
    });
    // Unrelated job must not appear in the parent's status tree.
    seedJob(cwd, {
      slug: 'solo-meadow-a1b2',
      role: null,
      parent: null,
      state: 'running',
      phase: 'test-loop',
      agent: 'claude',
      pid: 13002,
      startedAt: '2026-07-26T13:00:00.000Z',
    });

    const parent = readJob(cwd, 'wise-pine-e904');
    const out = formatStatus(cwd, parent);

    assert.match(out, /^slug:\s+wise-pine-e904$/m);
    assert.match(out, /^state:\s+running$/m);
    assert.equal(out.includes('solo-meadow-a1b2'), false);

    // Children appear after the parent fields, indented, workers then integrate.
    const foxIdx = out.indexOf('rapid-fox-x7q2');
    const elkIdx = out.indexOf('merry-elk-r4b1');
    const heronIdx = out.indexOf('tidy-heron-m2p9');
    assert.ok(foxIdx > 0 && elkIdx > foxIdx && heronIdx > elkIdx);

    assert.match(out, /rapid-fox-x7q2[\s\S]*?\bdone\b[\s\S]*?\bcommit\b[\s\S]*?orch\/rapid-fox-x7q2/);
    assert.match(out, /merry-elk-r4b1[\s\S]*?\bpaused\b[\s\S]*?\bcode-loop\b[\s\S]*?orch\/merry-elk-r4b1/);
  });

  it('shows parent: <slug> on a child and does not list siblings', () => {
    const cwd = makeTmpCwd('orch-status-child-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      phase: 'code-loop',
      branch: 'orch/merry-elk-r4b1',
      startedAt: '2026-07-26T12:00:02.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
      state: 'done',
      phase: 'commit',
      branch: 'orch/rapid-fox-x7q2',
      startedAt: '2026-07-26T12:00:01.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      exitCode: 0,
    });

    const child = readJob(cwd, 'merry-elk-r4b1');
    const out = formatStatus(cwd, child);

    assert.match(out, /^slug:\s+merry-elk-r4b1$/m);
    assert.match(out, /^parent:\s+wise-pine-e904$/m);
    assert.equal(out.includes('rapid-fox-x7q2'), false);
    // Parent slug is allowed on the `parent:` line; it must not appear again
    // as a nested expansion (e.g. a second slug:/tree block for the parent).
    assert.equal(
      (out.match(/wise-pine-e904/g) || []).length,
      1,
      'parent slug appears only on the parent: line',
    );
  });
});

// ---------------------------------------------------------------------------
// cascadePause / cascadeResume
// ---------------------------------------------------------------------------

describe('cascadePause / cascadeResume', () => {
  it('cascadePause sets pauseRequested on the parent and every live child; returns childrenSignaled count', () => {
    const cwd = makeTmpCwd('orch-cascade-pause-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, {
      slug: parentSlug,
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: parentSlug,
      role: 'worker',
      workerId: 'a',
      state: 'running',
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      pauseRequested: true,
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'done-worker-0001',
      parent: parentSlug,
      role: 'worker',
      workerId: 'c',
      state: 'done',
      phase: 'commit',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      pid: 1,
    });
    seedJob(cwd, {
      slug: 'solo-meadow-a1b2',
      role: null,
      parent: null,
      state: 'running',
      phase: 'test-loop',
      pid: process.pid,
    });

    const result = cascadePause(cwd, parentSlug);

    assert.equal(result.childrenSignaled, 2);

    const parent = readJob(cwd, parentSlug);
    assert.equal(parent.pauseRequested, true);
    assert.equal(parent.state, 'pausing');

    const live = readJob(cwd, 'rapid-fox-x7q2');
    assert.equal(live.pauseRequested, true);
    assert.equal(live.state, 'pausing');

    const alreadyPaused = readJob(cwd, 'merry-elk-r4b1');
    assert.equal(alreadyPaused.pauseRequested, true);
    assert.equal(alreadyPaused.state, 'paused');

    const done = readJob(cwd, 'done-worker-0001');
    assert.equal(done.pauseRequested, false);
    assert.equal(done.state, 'done');

    const solo = readJob(cwd, 'solo-meadow-a1b2');
    assert.equal(solo.pauseRequested, false);
    assert.equal(solo.state, 'running');
  });

  it('cascadeResume clears pause on the parent and paused/pausing children only', () => {
    const cwd = makeTmpCwd('orch-cascade-resume-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, {
      slug: parentSlug,
      role: 'coordinator',
      state: 'paused',
      pauseRequested: true,
      phase: 'schedule',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      pauseRequested: true,
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'still-running-0001',
      parent: parentSlug,
      role: 'worker',
      workerId: 'a',
      state: 'running',
      pauseRequested: false,
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'pausing-child-0001',
      parent: parentSlug,
      role: 'worker',
      workerId: 'c',
      state: 'pausing',
      pauseRequested: true,
      phase: 'test-loop',
      pid: process.pid,
    });

    const result = cascadeResume(cwd, parentSlug);
    assert.equal(result.childrenSignaled, 2);

    const parent = readJob(cwd, parentSlug);
    assert.equal(parent.pauseRequested, false);
    assert.equal(parent.state, 'running');

    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, false);
    assert.equal(readJob(cwd, 'merry-elk-r4b1').state, 'running');
    assert.equal(readJob(cwd, 'pausing-child-0001').pauseRequested, false);
    assert.equal(readJob(cwd, 'pausing-child-0001').state, 'running');

    // Running child was not touched beyond identity.
    assert.equal(readJob(cwd, 'still-running-0001').state, 'running');
    assert.equal(readJob(cwd, 'still-running-0001').pauseRequested, false);
  });
});

// ---------------------------------------------------------------------------
// cascadeStop — parent + live children (including integrate)
// ---------------------------------------------------------------------------

describe('cascadeStop — SIGTERM parent and every live child pid', () => {
  it('signals the parent pid when alive and every live worker + integrate child', () => {
    const cwd = makeTmpCwd('orch-cascade-stop-');
    const parentSlug = 'wise-pine-e904';
    writeFanout(cwd, parentSlug, {
      parentSlug,
      task: 't',
      base: 'abc',
      maxWorkers: 4,
      maxConcurrency: null,
      concurrency: 2,
      state: 'running',
      workers: [
        { id: 'a', slug: 'a-slug', state: 'running', branch: 'orch/a-slug' },
        { id: 'b', slug: 'b-slug', state: 'done', branch: 'orch/b-slug' },
      ],
      integration: { slug: 'tidy-heron-m2p9', state: 'running', pid: 55555 },
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    seedJob(cwd, { slug: parentSlug, role: 'coordinator', state: 'running', pid: 10001 });
    seedJob(cwd, { slug: 'a-slug', parent: parentSlug, role: 'worker', workerId: 'a', state: 'running', pid: 11111 });
    seedJob(cwd, { slug: 'b-slug', parent: parentSlug, role: 'worker', workerId: 'b', state: 'done', pid: 22222, finishedAt: new Date().toISOString(), exitCode: 0 });
    seedJob(cwd, { slug: 'tidy-heron-m2p9', parent: parentSlug, role: 'integration', state: 'running', pid: 55555 });

    const signaled = [];
    const kill = mock.fn((pid, signal) => {
      signaled.push({ pid, signal });
    });
    const isPidAliveMock = mock.fn((pid) => [10001, 11111, 55555].includes(pid));

    cascadeStop(cwd, parentSlug, { kill, isPidAlive: isPidAliveMock });

    assert.deepEqual(
      signaled.map((s) => s.pid).sort((a, b) => a - b),
      [10001, 11111, 55555],
    );
    assert.ok(signaled.every((s) => s.signal === 'SIGTERM'));
    assert.equal(signaled.some((s) => s.pid === 22222), false, 'done child must not be signaled');
  });
});

// ---------------------------------------------------------------------------
// CLI wiring — cascade vs leaf
// ---------------------------------------------------------------------------

describe('orch pause|resume|stop — cascade for coordinator, leaf otherwise', () => {
  it('orch pause <parent> cascades and reports how many children were signaled', async () => {
    const cwd = makeTmpCwd('orch-cli-pause-parent-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, { slug: parentSlug, role: 'coordinator', state: 'running', phase: 'schedule', pid: process.pid });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: parentSlug,
      role: 'worker',
      workerId: 'a',
      state: 'running',
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: 'b',
      state: 'running',
      phase: 'code-loop',
      pid: process.pid,
    });

    const { code, stdout, stderr } = await runCli(['pause', parentSlug], { cwd });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /2/);
    assert.match(stdout, /pause|child/i);

    assert.equal(readJob(cwd, parentSlug).pauseRequested, true);
    assert.equal(readJob(cwd, 'rapid-fox-x7q2').pauseRequested, true);
    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, true);
  });

  it('orch pause <child> is leaf-only — does not pause parent or siblings', async () => {
    const cwd = makeTmpCwd('orch-cli-pause-child-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, { slug: parentSlug, role: 'coordinator', state: 'running', phase: 'schedule', pid: process.pid });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: parentSlug,
      role: 'worker',
      workerId: 'a',
      state: 'running',
      phase: 'code-loop',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: 'b',
      state: 'running',
      phase: 'code-loop',
      pid: process.pid,
    });

    const { code, stderr } = await runCli(['pause', 'merry-elk-r4b1'], { cwd });
    assert.equal(code, 0, stderr);

    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, true);
    assert.equal(readJob(cwd, parentSlug).pauseRequested, false);
    assert.equal(readJob(cwd, 'rapid-fox-x7q2').pauseRequested, false);
  });

  it('orch resume <parent> clears pause on parent and paused children', async () => {
    const cwd = makeTmpCwd('orch-cli-resume-parent-');
    const parentSlug = 'wise-pine-e904';
    seedJob(cwd, {
      slug: parentSlug,
      role: 'coordinator',
      state: 'paused',
      pauseRequested: true,
      phase: 'schedule',
      pid: process.pid,
    });
    seedJob(cwd, {
      slug: 'merry-elk-r4b1',
      parent: parentSlug,
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      pauseRequested: true,
      phase: 'code-loop',
      pid: process.pid,
    });

    const { code, stderr } = await runCli(['resume', parentSlug], { cwd });
    assert.equal(code, 0, stderr);
    assert.equal(readJob(cwd, parentSlug).pauseRequested, false);
    assert.equal(readJob(cwd, parentSlug).state, 'running');
    assert.equal(readJob(cwd, 'merry-elk-r4b1').pauseRequested, false);
    assert.equal(readJob(cwd, 'merry-elk-r4b1').state, 'running');
  });

  it('orch stop <parent> signals parent and every live child including integrate', async () => {
    const cwd = makeTmpCwd('orch-cli-stop-parent-');
    const parentSlug = 'wise-pine-e904';

    // Real sleeping children so stop can SIGTERM live pids.
    const parentProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const workerProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const integrateProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFanout(cwd, parentSlug, {
        parentSlug,
        task: 't',
        base: 'abc',
        maxWorkers: 4,
        maxConcurrency: null,
        concurrency: 1,
        state: 'running',
        workers: [{ id: 'a', slug: 'a-slug', state: 'running', branch: 'orch/a-slug' }],
        integration: { slug: 'tidy-heron-m2p9', state: 'running', pid: integrateProc.pid },
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      seedJob(cwd, { slug: parentSlug, role: 'coordinator', state: 'running', pid: parentProc.pid });
      seedJob(cwd, {
        slug: 'a-slug',
        parent: parentSlug,
        role: 'worker',
        workerId: 'a',
        state: 'running',
        pid: workerProc.pid,
      });
      seedJob(cwd, {
        slug: 'tidy-heron-m2p9',
        parent: parentSlug,
        role: 'integration',
        state: 'running',
        pid: integrateProc.pid,
      });

      const { code, stderr } = await runCli(['stop', parentSlug], { cwd });
      assert.equal(code, 0, stderr);

      await sleep(100);
      // process.kill(pid) leaves ChildProcess.killed false; signal deaths report
      // via signalCode with exitCode null — accept any of those as "stopped".
      const wasStopped = (proc) => proc.killed || proc.exitCode != null || proc.signalCode != null;
      assert.equal(wasStopped(parentProc), true);
      assert.equal(wasStopped(workerProc), true);
      assert.equal(wasStopped(integrateProc), true);
    } finally {
      for (const p of [parentProc, workerProc, integrateProc]) {
        try { process.kill(p.pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  });

  it('orch list shows the indented tree for a seeded coordinator + children', async () => {
    const cwd = makeTmpCwd('orch-cli-list-tree-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      // Live pid so listJobs reconcile keeps state running (fake pids → crashed).
      pid: process.pid,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
      state: 'done',
      phase: 'commit',
      agent: 'cursor',
      pid: 12010,
      startedAt: '2026-07-26T12:00:01.000Z',
      finishedAt: '2026-07-26T12:05:00.000Z',
      exitCode: 0,
    });
    seedJob(cwd, {
      slug: 'solo-meadow-a1b2',
      role: null,
      parent: null,
      state: 'running',
      phase: 'test-loop',
      agent: 'claude',
      pid: process.pid,
      startedAt: '2026-07-26T13:00:00.000Z',
    });

    const { code, stdout, stderr } = await runCli(['list'], { cwd });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^SLUG\s+ROLE\s+STATE\s+PHASE\s+AGENT\s+PID$/m);
    assert.match(stdout, /^ {2}rapid-fox-x7q2\s+worker\b/m);
    assert.match(stdout, /^solo-meadow-a1b2\s+-\s+running\b/m);
    assert.match(stdout, /^wise-pine-e904\s+coordinator\b/m);
  });

  it('orch status <parent> expands children; orch status <child> shows parent line only', async () => {
    const cwd = makeTmpCwd('orch-cli-status-tree-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
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
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      phase: 'code-loop',
      branch: 'orch/merry-elk-r4b1',
      agent: 'cursor',
      pid: 12014,
      startedAt: '2026-07-26T12:00:02.000Z',
    });

    const parentStatus = await runCli(['status', 'wise-pine-e904'], { cwd });
    assert.equal(parentStatus.code, 0, parentStatus.stderr);
    assert.match(parentStatus.stdout, /rapid-fox-x7q2/);
    assert.match(parentStatus.stdout, /merry-elk-r4b1/);

    const childStatus = await runCli(['status', 'merry-elk-r4b1'], { cwd });
    assert.equal(childStatus.code, 0, childStatus.stderr);
    assert.match(childStatus.stdout, /^parent:\s+wise-pine-e904$/m);
    assert.equal(childStatus.stdout.includes('rapid-fox-x7q2'), false);
    assert.equal(
      (childStatus.stdout.match(/wise-pine-e904/g) || []).length,
      1,
      'parent slug appears only on the parent: line',
    );
  });

  it('orch status (no slug) defaults to most-recent job with parent-vs-child view', async () => {
    const cwd = makeTmpCwd('orch-cli-status-default-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      state: 'running',
      phase: 'schedule',
      agent: 'cursor',
      pid: 12001,
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
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
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'b',
      state: 'paused',
      phase: 'code-loop',
      branch: 'orch/merry-elk-r4b1',
      agent: 'cursor',
      pid: 12014,
      // Most recent among these three → default status picks the child view.
      startedAt: '2026-07-26T14:00:00.000Z',
    });

    const childDefault = await runCli(['status'], { cwd });
    assert.equal(childDefault.code, 0, childDefault.stderr);
    assert.match(childDefault.stdout, /^slug:\s+merry-elk-r4b1$/m);
    assert.match(childDefault.stdout, /^parent:\s+wise-pine-e904$/m);
    assert.equal(childDefault.stdout.includes('rapid-fox-x7q2'), false);

    // Bump the coordinator to most-recent → default status expands the tree.
    patchJob(cwd, 'wise-pine-e904', { startedAt: '2026-07-26T15:00:00.000Z' });
    const parentDefault = await runCli(['status'], { cwd });
    assert.equal(parentDefault.code, 0, parentDefault.stderr);
    assert.match(parentDefault.stdout, /^slug:\s+wise-pine-e904$/m);
    assert.match(parentDefault.stdout, /rapid-fox-x7q2/);
    assert.match(parentDefault.stdout, /merry-elk-r4b1/);
  });

  it('orch logs <parent> tails only the coordinator orch.log (no child log fan-in)', async () => {
    const cwd = makeTmpCwd('orch-cli-logs-parent-');
    const parentSlug = 'wise-pine-e904';
    const childSlug = 'rapid-fox-x7q2';
    seedJob(cwd, { slug: parentSlug, role: 'coordinator', state: 'running', pid: process.pid });
    seedJob(cwd, {
      slug: childSlug,
      parent: parentSlug,
      role: 'worker',
      workerId: 'a',
      state: 'running',
      pid: process.pid,
    });
    fs.writeFileSync(jobPaths(cwd, parentSlug).logPath, 'parent-log-line\n');
    fs.writeFileSync(jobPaths(cwd, childSlug).logPath, 'child-log-line-MUST-NOT-APPEAR\n');

    const { code, stdout, stderr } = await runCli(['logs', parentSlug], { cwd });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /parent-log-line/);
    assert.equal(stdout.includes('child-log-line-MUST-NOT-APPEAR'), false);
  });
});

// ---------------------------------------------------------------------------
// Coordinator schedule: parent pause checkpoints + leaf pause/stop reactions
// ---------------------------------------------------------------------------

describe('runFanoutPipeline — parent pause during schedule (no spawn while paused)', () => {
  it('honors pauseRequested between poll ticks: stops spawning until resumed, does not re-decompose, and does not duplicate already-spawned workers', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-parent-pause-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    // Two independent workers, concurrency 1 so the second spawn is a
    // distinct checkpoint the pause can block.
    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    let boundariesCount = 0;
    let decomposerCount = 0;
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: () => {
        boundariesCount += 1;
        return BOUNDARIES_OK;
      },
      decomposer: () => {
        decomposerCount += 1;
        return decomposeReply(workers);
      },
    });

    const { spawnFn, calls } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'hold', b: 'done' },
      integrationOutcome: 'done',
      delayMs: 10,
    });

    // After the first worker spawn, request a parent pause. The next
    // jobCheckpoint (poll tick / before next spawn) must park the
    // coordinator until we clear pauseRequested.
    let pauseArmed = false;
    let observedBlockedSpawn = false;
    const checkpointPause = mock.fn(async (jobCwd, slug, opts) => {
      const workerSpawnCount = calls.filter((c) => c.args.includes('--worker')).length;
      if (slug === jobSlug && workerSpawnCount >= 1 && !pauseArmed) {
        pauseArmed = true;
        patchJob(jobCwd, slug, { pauseRequested: true, state: 'pausing' });
      }
      await realCheckpointPause(jobCwd, slug, { ...opts, pollIntervalMs: opts?.pollIntervalMs ?? 5 });
    });

    const startedAt = Date.now();
    // While the coordinator is paused: assert b has not spawned yet, then
    // settle a and clear the pause so the schedule can advance. Failsafe:
    // if schedule checkpoints are missing, settle a after 1.5s so the run
    // exits and the assertions below fail clearly instead of hanging.
    const driver = setInterval(() => {
      const current = readJob(cwd, jobSlug);
      const workerSpawnCount = calls.filter((c) => c.args.includes('--worker')).length;
      if (current?.state === 'paused' && current.pauseRequested) {
        if (workerSpawnCount === 1) observedBlockedSpawn = true;
        assert.equal(workerSpawnCount, 1, 'must not spawn b while parent is paused');
        const a = readJob(cwd, 'a-slug');
        if (a?.state === 'running') {
          patchJob(cwd, 'a-slug', {
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
          });
          patchWorker(cwd, jobSlug, 'a', {
            state: 'done',
            sha: fakeSha('a'),
            changedFiles: ['src/a.ts'],
          });
        }
        requestResume(cwd, jobSlug);
        return;
      }
      if (Date.now() - startedAt > 1500) {
        const a = readJob(cwd, 'a-slug');
        if (a?.state === 'running') {
          patchJob(cwd, 'a-slug', {
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
          });
          patchWorker(cwd, jobSlug, 'a', {
            state: 'done',
            sha: fakeSha('a'),
            changedFiles: ['src/a.ts'],
          });
        }
        if (current?.pauseRequested) requestResume(cwd, jobSlug);
      }
    }, 15);

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
        maxConcurrency: 1,
        pollIntervalMs: 5,
        pausePollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        checkpointPause,
        exit: exitMock,
      });
    } finally {
      clearInterval(driver);
      logSpy.mock.restore();
    }

    assert.ok(observedBlockedSpawn, 'expected to observe the schedule blocked while parent was paused');
    assert.equal(boundariesCount, 1, 'resume must not re-run boundaries');
    assert.equal(decomposerCount, 1, 'resume must not re-run decomposer');

    const workerSpawns = calls.filter((c) => c.args.includes('--worker'));
    assert.equal(workerSpawns.length, 2, 'each worker spawned exactly once (no duplicates on resume)');

    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'done');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'done');
  });

  it('resume mid-fan-out re-attaches to a still-live worker (no re-spawn) and only spawns still-pending workers', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-reattach-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    let boundariesCount = 0;
    let decomposerCount = 0;
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: () => {
        boundariesCount += 1;
        return BOUNDARIES_OK;
      },
      decomposer: () => {
        decomposerCount += 1;
        return decomposeReply(workers);
      },
    });

    const { spawnFn, calls } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'hold', b: 'done' },
      integrationOutcome: 'done',
      delayMs: 10,
    });

    let pauseArmed = false;
    let resumedWithLiveA = false;
    let aSlugAtResume = null;
    const checkpointPause = mock.fn(async (jobCwd, slug, opts) => {
      const workerSpawnCount = calls.filter((c) => c.args.includes('--worker')).length;
      if (slug === jobSlug && workerSpawnCount >= 1 && !pauseArmed) {
        pauseArmed = true;
        patchJob(jobCwd, slug, { pauseRequested: true, state: 'pausing' });
      }
      await realCheckpointPause(jobCwd, slug, { ...opts, pollIntervalMs: opts?.pollIntervalMs ?? 5 });
    });

    const startedAt = Date.now();
    // Keep a live across the pause/resume boundary — do NOT settle it before
    // resume. That is the re-attach contract from fanout.md.
    const driver = setInterval(() => {
      const current = readJob(cwd, jobSlug);
      const workerSpawnCount = calls.filter((c) => c.args.includes('--worker')).length;
      const a = readJob(cwd, 'a-slug');

      if (current?.state === 'paused' && current.pauseRequested) {
        assert.equal(workerSpawnCount, 1, 'must not spawn b while parent is paused');
        assert.equal(a?.state, 'running', 'live worker a must still be running at resume');
        aSlugAtResume = a.slug;
        resumedWithLiveA = true;
        requestResume(cwd, jobSlug);
        return;
      }

      // After resume with a still live: settle a so b can spawn and the run can finish.
      if (resumedWithLiveA && a?.state === 'running' && !current?.pauseRequested) {
        assert.equal(
          calls.filter((c) => c.args.includes('--worker') && c.args.some((arg) => arg.endsWith(':a'))).length,
          1,
          'must not re-spawn live worker a on resume',
        );
        patchJob(cwd, 'a-slug', {
          state: 'done',
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        });
        patchWorker(cwd, jobSlug, 'a', {
          state: 'done',
          sha: fakeSha('a'),
          changedFiles: ['src/a.ts'],
        });
      }

      if (Date.now() - startedAt > 2500) {
        if (a?.state === 'running') {
          patchJob(cwd, 'a-slug', {
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
          });
          patchWorker(cwd, jobSlug, 'a', {
            state: 'done',
            sha: fakeSha('a'),
            changedFiles: ['src/a.ts'],
          });
        }
        if (current?.pauseRequested) requestResume(cwd, jobSlug);
      }
    }, 15);

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
        maxConcurrency: 1,
        pollIntervalMs: 5,
        pausePollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        checkpointPause,
        exit: exitMock,
      });
    } finally {
      clearInterval(driver);
      logSpy.mock.restore();
    }

    assert.ok(resumedWithLiveA, 'expected resume while worker a was still live');
    assert.equal(aSlugAtResume, 'a-slug');
    assert.equal(boundariesCount, 1, 'resume must not re-run boundaries');
    assert.equal(decomposerCount, 1, 'resume must not re-run decomposer');

    const aSpawns = calls.filter((c) => c.args.includes('--worker') && c.args.some((arg) => arg.endsWith(':a')));
    const bSpawns = calls.filter((c) => c.args.includes('--worker') && c.args.some((arg) => arg.endsWith(':b')));
    assert.equal(aSpawns.length, 1, 'live worker a re-attached — never re-spawned');
    assert.equal(bSpawns.length, 1, 'pending worker b spawned once after a settled');

    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'done');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'done');
  });

  it('spawns integrate only after all workers settle; does not duplicate when integrate is already live or done', { timeout: 10000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-integrate-guard-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(workers),
    });

    const { spawnFn, calls, releaseIntegrate } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'hold', b: 'hold' },
      integrationOutcome: 'hold',
      delayMs: 10,
    });

    let pauseArmed = false;
    let phase = 'wait-workers-spawned';
    let observedNoIntegrateWhileWorkersLive = false;
    let observedLiveIntegrateAcrossResume = false;
    let settledWorkers = false;

    const checkpointPause = mock.fn(async (jobCwd, slug, opts) => {
      const workerSpawnCount = calls.filter((c) => c.args.includes('--worker')).length;
      if (slug === jobSlug && workerSpawnCount >= 2 && !pauseArmed && phase === 'wait-workers-spawned') {
        pauseArmed = true;
        patchJob(jobCwd, slug, { pauseRequested: true, state: 'pausing' });
      }
      await realCheckpointPause(jobCwd, slug, { ...opts, pollIntervalMs: opts?.pollIntervalMs ?? 5 });
    });

    const startedAt = Date.now();
    const driver = setInterval(() => {
      const current = readJob(cwd, jobSlug);
      const integrateSpawns = calls.filter((c) => c.args.includes('--integrate'));
      const a = readJob(cwd, 'a-slug');
      const b = readJob(cwd, 'b-slug');
      const doc = readFanout(cwd, jobSlug);

      if (phase === 'wait-workers-spawned' && current?.state === 'paused' && current.pauseRequested) {
        assert.equal(integrateSpawns.length, 0, 'must not spawn integrate while workers are still live');
        observedNoIntegrateWhileWorkersLive = true;
        requestResume(cwd, jobSlug);
        phase = 'settle-workers';
        return;
      }

      if (phase === 'settle-workers' && !settledWorkers && a?.state === 'running' && b?.state === 'running') {
        // After resume with both still live: still no integrate.
        assert.equal(integrateSpawns.length, 0, 'resume must not spawn integrate before workers settle');
        settledWorkers = true;
        for (const id of ['a', 'b']) {
          patchJob(cwd, `${id}-slug`, {
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
          });
          patchWorker(cwd, jobSlug, id, {
            state: 'done',
            sha: fakeSha(id),
            changedFiles: [`src/${id}.ts`],
          });
        }
        phase = 'wait-integrate-live';
        return;
      }

      if (phase === 'wait-integrate-live' && integrateSpawns.length === 1) {
        const integrateSlug = integrateSpawns[0].options.env.ORCH_JOB_SLUG;
        const integrateJob = readJob(cwd, integrateSlug);
        if (integrateJob?.state === 'running' || doc?.integration?.state === 'running' || doc?.integration?.slug) {
          // Pause while integrate is live — resume must re-attach, not re-spawn.
          if (!current?.pauseRequested && current?.state !== 'paused') {
            patchJob(cwd, jobSlug, { pauseRequested: true, state: 'pausing' });
            phase = 'resume-with-live-integrate';
          }
        }
        return;
      }

      if (phase === 'resume-with-live-integrate' && current?.state === 'paused' && current.pauseRequested) {
        assert.equal(integrateSpawns.length, 1, 'integrate already live — must not have duplicated before resume');
        observedLiveIntegrateAcrossResume = true;
        requestResume(cwd, jobSlug);
        phase = 'release-integrate';
        return;
      }

      if (phase === 'release-integrate' && !current?.pauseRequested) {
        assert.equal(
          calls.filter((c) => c.args.includes('--integrate')).length,
          1,
          'must not re-spawn integrate that was already live across resume',
        );
        try {
          releaseIntegrate();
          phase = 'assert-done-no-duplicate';
        } catch {
          // releaseIntegrate may not be ready for one tick
        }
        return;
      }

      if (phase === 'assert-done-no-duplicate') {
        const after = readFanout(cwd, jobSlug);
        if (after?.integration?.state === 'done') {
          assert.equal(
            calls.filter((c) => c.args.includes('--integrate')).length,
            1,
            'must not re-spawn integrate that is already done',
          );
          phase = 'finished';
        }
      }

      if (Date.now() - startedAt > 4000) {
        if (a?.state === 'running') {
          patchJob(cwd, 'a-slug', { state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
          patchWorker(cwd, jobSlug, 'a', { state: 'done', sha: fakeSha('a'), changedFiles: ['src/a.ts'] });
        }
        if (b?.state === 'running') {
          patchJob(cwd, 'b-slug', { state: 'done', exitCode: 0, finishedAt: new Date().toISOString() });
          patchWorker(cwd, jobSlug, 'b', { state: 'done', sha: fakeSha('b'), changedFiles: ['src/b.ts'] });
        }
        if (current?.pauseRequested) requestResume(cwd, jobSlug);
        try { releaseIntegrate(); } catch { /* ignore */ }
      }
    }, 15);

    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('do two things then integrate', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        maxConcurrency: 2,
        pollIntervalMs: 5,
        pausePollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        checkpointPause,
        exit: exitMock,
      });
    } finally {
      clearInterval(driver);
      logSpy.mock.restore();
    }

    assert.ok(observedNoIntegrateWhileWorkersLive, 'expected no integrate spawn while workers were live');
    assert.ok(observedLiveIntegrateAcrossResume, 'expected resume while integrate was still live');
    assert.equal(
      calls.filter((c) => c.args.includes('--integrate')).length,
      1,
      'integrate spawned exactly once (not duplicated when live or done)',
    );
    assert.equal(readFanout(cwd, jobSlug).integration.state, 'done');
  });

  it('does not spawn integrate when fanout.integration is already done (resume / re-entry gate)', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-integrate-done-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    // validateDecomposition requires ≥2 workers; use two so the schedule
    // reaches the integrate gate instead of declining to the single-worktree path.
    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(workers),
    });

    const { spawnFn, calls } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'done', b: 'done' },
      integrationOutcome: 'done',
      delayMs: 10,
    });

    // Before the coordinator would spawn integrate, mark integration already
    // done in fanout.json (as if a prior attempt finished). The integrate
    // gate must skip spawning.
    let markedDone = false;
    const checkpointPause = mock.fn(async (jobCwd, slug, opts) => {
      const doc = readFanout(jobCwd, slug);
      if (
        !markedDone
        && doc?.workers?.length
        && doc.workers.every((w) => ['done', 'failed', 'skipped'].includes(w.state))
        && (doc.integration?.state === 'pending' || !doc.integration?.slug)
      ) {
        markedDone = true;
        patchIntegration(jobCwd, slug, {
          state: 'done',
          slug: 'preexisting-integrate',
          branch: 'orch/preexisting-integrate',
          sha: 'integrationsha00000000000000000000000',
        });
      }
      await realCheckpointPause(jobCwd, slug, { ...opts, pollIntervalMs: opts?.pollIntervalMs ?? 5 });
    });

    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runFanoutPipeline('single worker, integrate already done', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        jobSlug,
        jobCwd: cwd,
        maxWorkers: 4,
        pollIntervalMs: 5,
        pausePollIntervalMs: 5,
        execFile,
        spawn: spawnFn,
        allocateJob: makeDeterministicAllocateJob(),
        checkpointPause,
        exit: exitMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(markedDone, 'expected to mark integration done before the integrate gate');
    assert.equal(
      calls.filter((c) => c.args.includes('--integrate')).length,
      0,
      'must not spawn integrate when fanout.integration is already done',
    );
  });
});

describe('runFanoutPipeline — leaf pause / leaf stop poll reactions', () => {
  it('leaf pause: coordinator waits without marking failed and does not start dependents', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-leaf-pause-');
    const jobSlug = 'wise-pine-e904';
    seedCoordinatorJob(cwd, jobSlug);
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('rev-parse') && args.includes('HEAD'), stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' },
    ]);

    const workers = [
      { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      { id: 'b', title: 'b', subtask: 'do b (depends on a)', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: false },
    ];
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(workers),
    });

    const { spawnFn, calls, releasePaused } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'pause-then-done', b: 'done' },
      integrationOutcome: 'done',
      delayMs: 10,
    });

    // While a is paused, assert the coordinator has not failed it and has
    // not spawned b; then release the pause so the run can finish.
    let observedPausedWait = false;
    let released = false;
    const watcher = setInterval(() => {
      const a = readJob(cwd, 'a-slug');
      const doc = readFanout(cwd, jobSlug);
      if (!released && (a?.state === 'paused' || a?.state === 'pausing')) {
        observedPausedWait = true;
        assert.notEqual(doc.workers.find((w) => w.id === 'a').state, 'failed');
        assert.ok(
          !calls.some((c) => c.args.includes('--worker') && c.args.some((arg) => arg.endsWith(':b'))),
          'dependent b must not start while a is paused',
        );
        // Parent / sibling must not have been auto-paused by leaf pause.
        assert.equal(readJob(cwd, jobSlug).pauseRequested, false);
        released = true;
        releasePaused('a');
      }
    }, 10);

    const exitMock = mock.fn();
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
        exit: exitMock,
      });
    } finally {
      clearInterval(watcher);
      logSpy.mock.restore();
    }

    assert.ok(observedPausedWait, 'expected to observe the coordinator waiting on a paused leaf');
    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'done');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'done');
  });

  it('leaf stop: marks that worker failed in fanout.json, skips dependents, and continues the rest of the schedule', { timeout: 8000 }, async () => {
    const cwd = makeTmpCwd('orch-fanout-leaf-stop-');
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
    const MockAgentClass = createMockAgentClass({
      triage: TRIAGE_COMPLEX,
      boundaries: BOUNDARIES_OK,
      decomposer: decomposeReply(workers),
    });

    // Hold a in running; externally stop it (terminal stopped) so the
    // coordinator's poll treats it like a leaf stop.
    const { spawnFn, calls } = fakeChildSpawn({
      cwd,
      parentSlug: jobSlug,
      outcomes: { a: 'hold', c: 'done' },
      integrationOutcome: 'done',
      delayMs: 10,
    });

    let stopped = false;
    const stopper = setInterval(() => {
      const a = readJob(cwd, 'a-slug');
      if (!stopped && a?.state === 'running') {
        stopped = true;
        patchJob(cwd, 'a-slug', {
          state: 'stopped',
          exitCode: 143,
          finishedAt: new Date().toISOString(),
        });
      }
    }, 10);

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
      clearInterval(stopper);
      logSpy.mock.restore();
    }

    assert.ok(!calls.some((c) => c.args.includes('--worker') && c.args.some((arg) => arg.endsWith(':b'))));
    const doc = readFanout(cwd, jobSlug);
    assert.equal(doc.workers.find((w) => w.id === 'a').state, 'failed');
    assert.equal(doc.workers.find((w) => w.id === 'b').state, 'skipped');
    assert.equal(doc.workers.find((w) => w.id === 'c').state, 'done');
    assert.ok(exitMock.mock.calls.some((c) => c.arguments[0] !== 0));
  });
});

// ---------------------------------------------------------------------------
// Sanity: listJobs stays flat; tree is presentation-only
// ---------------------------------------------------------------------------

describe('listJobs remains flat (tree is formatJobsTable presentation)', () => {
  it('listJobs still returns a flat most-recent-first array including children', () => {
    const cwd = makeTmpCwd('orch-listjobs-flat-');
    seedJob(cwd, {
      slug: 'wise-pine-e904',
      role: 'coordinator',
      startedAt: '2026-07-26T12:00:00.000Z',
    });
    seedJob(cwd, {
      slug: 'rapid-fox-x7q2',
      parent: 'wise-pine-e904',
      role: 'worker',
      workerId: 'a',
      startedAt: '2026-07-26T12:00:01.000Z',
    });
    seedJob(cwd, {
      slug: 'solo-meadow-a1b2',
      startedAt: '2026-07-26T13:00:00.000Z',
    });

    const jobs = listJobs(cwd);
    assert.deepEqual(jobs.map((j) => j.slug), [
      'solo-meadow-a1b2',
      'rapid-fox-x7q2',
      'wise-pine-e904',
    ]);
  });
});
