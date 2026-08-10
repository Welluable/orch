import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runContinuePipeline } from '../main.js';
import { readJob, writeJob } from '../lib/jobs.js';
import { readFanout, writeFanout } from '../lib/fanout.js';
import { validateContinue } from '../lib/continue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

/**
 * Contract this file pins down for fan-out **worker** continue — the
 * `role: "worker"` slice of `.spec/continue.md` decisions 15–18 ("Fan-out
 * worker continue") and `.orch/sunny-oasis-a761/task.md` section 7. Builds
 * on the pipeline-wiring contract in test/continue-pipeline.test.js, but
 * exercises the real `lib/fanout.js` `readFanout`/`writeFanout`/`patchWorker`
 * primitives (not a mock) so a sibling worker's untouched entry is a
 * meaningful assertion, and adds the CLI-level role-gate + worker-acceptance
 * checks that don't fit test/continue.test.js's lib/continue.js-focused
 * suite.
 */

function makeTmpCwd(prefix = 'orch-continue-worker-') {
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

function seedPriorStatusMd(runContext, slug, branch, worktreePath) {
  fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
  fs.writeFileSync(
    runContext.statusPath,
    `# Status\n\n- Slug: \`${slug}\`\n- Branch: \`${branch}\`\n- Worktree: \`${worktreePath}\`\n- Parent: \`wise-pine-e904\`\n- Worker: \`02-invoices\`\n`,
  );
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
    state: 'failed',
    workers: [
      baseWorker({ id: '01-scaffold', scaffold: true, branch: 'orch/rapid-fox-x7q2', state: 'done' }),
      baseWorker({
        id: '02-invoices',
        title: 'invoice endpoints',
        area: 'src/billing/invoices/',
        owns: ['src/billing/invoices/'],
        dependsOn: ['01-scaffold'],
        branch: 'orch/merry-elk-r4b1',
        state: 'failed',
      }),
      baseWorker({
        id: '03-charges',
        title: 'charge endpoints (never started)',
        area: 'src/billing/charges/',
        owns: ['src/billing/charges/'],
        dependsOn: ['01-scaffold'],
        branch: null,
        slug: null,
        state: 'skipped',
      }),
    ],
    integration: {
      slug: null, pid: null, branch: null, worktree: null,
      candidates: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1'],
      merged: [], skipped: [], overlappingFiles: [], state: 'pending', sha: null,
    },
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function seedWorkerJob(cwd, slug, overrides = {}) {
  const worktreePath = overrides.worktree === undefined
    ? path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`)
    : overrides.worktree;
  if (worktreePath) fs.mkdirSync(worktreePath, { recursive: true });
  writeJob(cwd, slug, {
    slug,
    task: 'Implement create and list invoice endpoints.',
    agent: 'claude',
    maxRounds: 5,
    cwd,
    pauseRequested: false,
    branch: worktreePath ? `orch/${slug}` : null,
    worktree: worktreePath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    pid: process.pid,
    state: 'failed',
    phase: 'code-loop',
    stage: 'test-runner',
    round: 1,
    parent: 'wise-pine-e904',
    role: 'worker',
    workerId: '02-invoices',
    lastOutcome: {
      state: 'failed', phase: 'code-loop', stage: 'test-runner', round: 1, exitCode: 1,
      finishedAt: new Date().toISOString(), task: 'Implement create and list invoice endpoints.',
      summary: 'invoice tests failed', error: 'test-runner failed; stopping before commit',
    },
    ...overrides,
  });
  return worktreePath;
}

describe('worker continue — real fanout.json bookkeeping (patchWorker, not mocked)', () => {
  it('on done+commit, flips only the continued worker to done+sha+changedFiles; siblings (incl. skipped) are untouched', async () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    const worktreePath = seedWorkerJob(cwd, workerSlug);
    const runContext = fakeRunContext(cwd, workerSlug);
    seedPriorStatusMd(runContext, workerSlug, `orch/${workerSlug}`, worktreePath);
    const MockAgentClass = createMockAgentClass(workerPassBehaviors());
    const sha = 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeed';

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('fix the failing invoice tests and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug: workerSlug,
        worktreePath,
        branch: `orch/${workerSlug}`,
        role: 'worker',
        parentSlug: doc.parentSlug,
        workerId: '02-invoices',
        continuation: 2,
        priorOutcome: readJob(cwd, workerSlug).lastOutcome,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => ({ committed: true, sha, branch: `orch/${workerSlug}` })),
        recordChangedFiles: mock.fn(() => ['src/billing/invoices/create.ts', 'src/billing/invoices/list.ts']),
        jobSlug: workerSlug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const updated = readFanout(cwd, doc.parentSlug);
    const invoiceWorker = updated.workers.find((w) => w.id === '02-invoices');
    assert.equal(invoiceWorker.state, 'done');
    assert.equal(invoiceWorker.sha, sha);
    assert.deepEqual(invoiceWorker.changedFiles, ['src/billing/invoices/create.ts', 'src/billing/invoices/list.ts']);

    // Sibling that was already done stays done; the never-started/skipped
    // sibling is not retroactively spawned or flipped to pending.
    const scaffoldWorker = updated.workers.find((w) => w.id === '01-scaffold');
    assert.equal(scaffoldWorker.state, 'done');
    const chargesWorker = updated.workers.find((w) => w.id === '03-charges');
    assert.equal(chargesWorker.state, 'skipped');
    assert.equal(chargesWorker.slug, null);

    // The coordinator's own run.json is not touched by a worker continue.
    assert.equal(readJob(cwd, doc.parentSlug), null);
  });
});

describe('worker continue — CLI role gate + acceptance', () => {
  it('accepts a terminal, worktree-backed role:"worker" slug (--dry-run exits 0, no mutation)', async () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    seedWorkerJob(cwd, workerSlug, {
      state: 'done',
      exitCode: 0,
      lastOutcome: {
        state: 'done', phase: 'commit', stage: 'commit', round: null, exitCode: 0,
        finishedAt: new Date().toISOString(),
        task: 'Implement create and list invoice endpoints.',
        summary: 'done', error: null,
      },
    });
    const before = readJob(cwd, workerSlug);

    const { code } = await runCli(
      ['continue', workerSlug, 'follow-up polish on invoices', '--dry-run', '--agent', 'claude'],
      { cwd },
    );

    assert.equal(code, 0);
    assert.deepEqual(readJob(cwd, workerSlug), before);
  });

  it('accepts a terminal, worktree-backed role:"worker" slug that is "failed" (issue #11: worker continue is no longer done-only)', async () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const workerSlug = 'merry-elk-r4b1';
    // seedWorkerJob defaults to state: 'failed' with a real worktree on disk.
    seedWorkerJob(cwd, workerSlug);
    const before = readJob(cwd, workerSlug);

    const { code, stderr } = await runCli(
      ['continue', workerSlug, 'fix the failing invoice tests and finish', '--dry-run', '--agent', 'claude'],
      { cwd },
    );

    assert.equal(code, 0, stderr);
    assert.deepEqual(readJob(cwd, workerSlug), before);
  });

  it('refuses a skipped worker (no worktree ever allocated) with the no-worktree error when state is done, and does not create one', async () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);
    const skippedSlug = 'tidy-heron-m2p9';
    seedWorkerJob(cwd, skippedSlug, {
      worktree: null,
      branch: null,
      state: 'done',
      exitCode: 0,
      workerId: '03-charges',
      lastOutcome: {
        state: 'done', phase: null, stage: null, round: null, exitCode: 0,
        finishedAt: new Date().toISOString(), task: 'skipped',
        summary: '', error: null,
      },
    });

    assert.throws(
      () => validateContinue(cwd, skippedSlug, { task: 'do it anyway' }),
      new RegExp(`${skippedSlug} has no worktree; continue only applies to complex runs`),
    );
    assert.equal(readJob(cwd, skippedSlug).worktree, null);
  });
});
