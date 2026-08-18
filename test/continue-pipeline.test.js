import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runContinuePipeline } from '../main.js';
import { readJob, writeJob, reopenJob } from '../lib/jobs.js';
import { validateContinue, snapshotPriorOutcome } from '../lib/continue.js';
import { writeConfig, localConfigPath } from '../lib/config.js';

/**
 * Contract this file pins down for `runContinuePipeline` — the net-new
 * pipeline entrypoint behind `orch continue <slug> <task...>` (see
 * `.spec/continue.md` "Pipeline" / "Prior-outcome injection" / "Commit
 * message" and `.orch/sunny-oasis-a761/task.md` section 6). It does not
 * exist yet as of this test-writing round; this describes the contract the
 * next implementation round must satisfy. It deliberately mirrors
 * `runPipeline`/`runWorkerPipeline`'s existing dependency-injection shape
 * (`options.xFn ?? realX`) so tests need no real git/agent processes.
 *
 * `runContinuePipeline(prompt, options)` — `prompt` is the *new* task text
 * for this continue iteration (not yet augmented with prior-outcome text).
 * `options`:
 *   - `agent`, `maxRounds` (default 5), `verbose`, `AgentClass`
 *   - `cwd` (invocation cwd, default `process.cwd()`)
 *   - `slug` — the existing job slug being continued
 *   - `worktreePath`, `branch` — the *existing* worktree/branch (from
 *     `run.json`); `createWorktree` is never called
 *   - `role` (`undefined` | `'worker'`), `parentSlug`, `workerId` — worker
 *     linkage, when continuing a fan-out worker slug
 *   - `priorOutcome` — the prior-outcome snapshot object to inject
 *   - `continuation` — the new continuation number (>= 2)
 *   - `createRunContext`, `commitWorktree`, `collectWorktreeChanges`,
 *     `patchWorker`, `recordChangedFiles`, `execFile`, `base` — same
 *     injectable seams as `runWorkerPipeline`
 *   - `jobSlug` (default `slug`), `jobCwd` (default `cwd`), `patchJob`,
 *     `checkpointPause`, `pausePollIntervalMs` — same universal-job seams as
 *     `runPipeline`/`runWorkerPipeline`
 *
 * Behavior:
 *   - Skips triage. Skips `createWorktree` entirely — writers/critics/runner
 *     run against `options.worktreePath` / `options.branch` unchanged.
 *   - Calls `createRunContext({ cwd, slug })` with the *existing* slug (never
 *     generates a new one).
 *   - Builds `[Prior run outcome]` text from `priorOutcome` (+ `parentSlug`/
 *     `workerId` when set) and passes `` `${block}\n\nUser follow-up:\n${prompt}` ``
 *     as the `prompt` given to `researchAgentArgs`/`plannerAgentArgs` only.
 *     Test-writer / test-critic / code-writer / test-runner receive the
 *     plain, unaugmented `prompt` (no duplicate block — the spec explicitly
 *     does not require one for implementer stages).
 *   - Appends (never overwrites) a `## Continue <continuation>` section to
 *     `status.md` with a nested `### Prior outcome` sub-section, present
 *     even when `priorOutcome.state === 'done'`.
 *   - Runs test-writer ⇄ test-critic then code-writer ⇄ test-runner exactly
 *     like `runPipeline`/`runWorkerPipeline`.
 *   - Commits with message `` orch: <slug> (continue <continuation>): <first line> ``
 *     (always the continue-suffixed form — this entrypoint is never used
 *     for `continuation === 1`).
 *   - On terminal (`done` or `failed`), `jobPatch`es the usual terminal
 *     fields *and* a fresh top-level `lastOutcome` for this iteration.
 *   - When `role === 'worker'` and the run reaches `done` with a committed
 *     SHA, calls `patchWorker(cwd, parentSlug, workerId, { state: 'done',
 *     sha, changedFiles })` (same call shape `runWorkerPipeline` already
 *     uses) and prints a `orch --integrate <parentSlug>` hint to stdout.
 *     On worker failure, `patchWorker` gets `{ state: 'failed' }` instead,
 *     and no integrate hint is printed. When `role` is unset, `patchWorker`
 *     is never called.
 *   - On a thrown stage error, prints to stderr, patches `state: 'failed'`
 *     (+ `lastOutcome`), and `process.exit(1)`s — identical shape to
 *     `runPipeline`'s catch block.
 */

function makeTmpCwd(prefix = 'orch-continue-pipeline-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pinLocalBranchPrefix(cwd, prefix = 'long_running_session') {
  writeConfig(localConfigPath(cwd), { branchPrefix: prefix });
  return prefix;
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
  const queues = Object.create(null);

  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
      instances.push(this);
    }

    async run() {
      const role = agentRole(this.name);
      const behavior = behaviors[role];
      if (Array.isArray(behavior)) {
        queues[role] = queues[role] ?? 0;
        const attempt = behavior[Math.min(queues[role], behavior.length - 1)];
        queues[role] += 1;
        return attempt;
      }
      if (!behavior) {
        throw new Error(`MockAgent: no scripted behavior for role "${role}"`);
      }
      return behavior;
    }
  }

  MockAgent.instances = instances;
  return MockAgent;
}

const RESEARCH_SUMMARY = 'Research walked the codebase and wrote its findings to the research doc.';
const PLANNER_SUMMARY = 'Planner turned the research findings into a step-by-step task checklist.';
const TEST_WRITER_SUMMARY = 'Test writer added coverage for the new behavior.';
const TEST_CRITIC_SUMMARY = 'Test critic judged the coverage adequate to freeze.';
const CODE_WRITER_SUMMARY = 'Code writer implemented the checklist against the frozen verification.';
const TEST_RUNNER_SUMMARY = 'Test runner executed the suite and confirmed every test passed.';

const PASS_CRITIC = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), TEST_CRITIC_SUMMARY) };
const PASS_RUNNER = { ok: true, result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), TEST_RUNNER_SUMMARY) };

function continuePassBehaviors(overrides = {}) {
  return {
    research: { ok: true, result: withSummary('research-output', RESEARCH_SUMMARY) },
    planner: { ok: true, result: withSummary('planner-output', PLANNER_SUMMARY) },
    'test-writer': { ok: true, result: withSummary('tests written', TEST_WRITER_SUMMARY) },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: withSummary('done', CODE_WRITER_SUMMARY) },
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

function fakeCommitResult(branch, sha = 'deadbeefcafebabe0000000000000000000000') {
  return { committed: true, sha, branch };
}

function seedPriorStatusMd(runContext, slug, branch, worktreePath) {
  fs.mkdirSync(path.dirname(runContext.statusPath), { recursive: true });
  fs.writeFileSync(
    runContext.statusPath,
    `# Status\n\n- Slug: \`${slug}\`\n- Branch: \`${branch}\`\n- Worktree: \`${worktreePath}\`\n\n## Commit\n\n- SHA: \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`\n- Branch: \`${branch}\`\n`,
  );
}

const FAILED_PRIOR_OUTCOME = {
  state: 'failed',
  phase: 'code-loop',
  stage: 'test-runner',
  round: 3,
  exitCode: 1,
  finishedAt: '2026-07-27T10:00:00.000Z',
  task: 'implement the billing endpoint',
  summary: 'tests failed on round 3',
  error: 'test-runner failed; stopping before commit',
};

function seedForegroundContinueJob(cwd, slug, task) {
  writeJob(cwd, slug, {
    slug,
    task,
    agent: 'claude',
    maxRounds: 5,
    cwd,
    pauseRequested: false,
    branch: `orch/${slug}`,
    worktree: path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    pid: process.pid,
    state: 'running',
    phase: 'research',
    stage: null,
    round: null,
    continuation: 2,
    lastOutcome: null,
  });
}

describe('runContinuePipeline — skips triage and worktree creation', () => {
  it('constructs research → planner → test-writer → test-critic → code-writer → test-runner, with no triage', async () => {
    const cwd = makeTmpCwd();
    pinLocalBranchPrefix(cwd);
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const createWorktreeSpy = mock.fn(() => { throw new Error('createWorktree must not be called by runContinuePipeline'); });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        createWorktree: createWorktreeSpy,
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['research', 'planner', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
    assert.equal(createWorktreeSpy.mock.calls.length, 0);
  });

  it('calls createRunContext with the existing slug (never generates a new one)', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'follow-up polish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const createRunContextSpy = mock.fn(() => runContext);

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('follow-up polish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: createRunContextSpy,
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(createRunContextSpy.mock.calls.length, 1);
    const [callArgs] = createRunContextSpy.mock.calls[0].arguments;
    assert.equal(callArgs.slug, slug);
  });
});

/**
 * Contract this section pins down: since `runContinuePipeline` never calls
 * `createWorktree`, every agent stage must run with `options.cwd` pointed at
 * the *existing* worktree (`options.worktreePath`), never at the outer
 * invocation `cwd` (the repo root passed into `runContinuePipeline` itself).
 * This is the repo's established way of proving a stage actually ran
 * against the reused worktree rather than a freshly allocated one (see the
 * `researchAgentArgs`/`plannerAgentArgs`/`testWriterAgentArgs`/etc.
 * `options: { cwd }` shape in agents/*.js — `cwd` there always becomes the
 * literal `options.cwd` on the constructed agent instance). `runPipeline`
 * gives research/planner `cwd: invocationCwd` because no worktree exists yet
 * at that point in a fresh run; `runContinuePipeline` has no such excuse —
 * the worktree already exists before research/planner ever run — so
 * research/planner must get `worktreePath` too, same as test-writer/
 * test-critic/code-writer/test-runner (which get it "for free" via the
 * shared `runTestLoop`/`runCodeLoop` helpers `runPipeline` already uses).
 * Asserted separately per group since research/planner are wired directly
 * by `runContinuePipeline` itself while the other four go through the
 * shared, already-correct loop helpers — a naive port of `runPipeline`'s
 * research/planner wiring would silently pass the wrong cwd for just those
 * two.
 */
describe('runContinuePipeline — options.cwd wiring per role', () => {
  it('passes the existing worktreePath as cwd to research/planner and to test-writer/test-critic/code-writer/test-runner alike, never the outer invocation cwd', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.notEqual(cwd, worktreePath, 'fixture sanity: outer cwd and worktreePath must actually differ for this assertion to mean anything');

    const byRole = Object.fromEntries(MockAgentClass.instances.map((i) => [agentRole(i.name), i]));
    for (const role of ['research', 'planner']) {
      assert.equal(byRole[role].options.cwd, worktreePath, `expected ${role} to run against the existing worktree, not the outer invocation cwd`);
      assert.notEqual(byRole[role].options.cwd, cwd, `${role} must not fall back to runPipeline's "no worktree yet" cwd:invocationCwd behavior`);
    }
    for (const role of ['test-writer', 'test-critic', 'code-writer', 'test-runner']) {
      assert.equal(byRole[role].options.cwd, worktreePath, `expected ${role} to run against the existing worktree`);
    }
  });
});

describe('runContinuePipeline — prior-outcome prompt injection', () => {
  it('prepends [Prior run outcome] to the research and planner prompts, but not to test-writer/code-writer', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failure and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('fix the failure and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const byRole = Object.fromEntries(MockAgentClass.instances.map((i) => [agentRole(i.name), i]));
    assert.match(byRole.research.prompt, /\[Prior run outcome\]/);
    assert.match(byRole.research.prompt, /Prior state: failed/);
    assert.match(byRole.research.prompt, /fix the failure and finish/);
    assert.match(byRole.planner.prompt, /\[Prior run outcome\]/);
    assert.match(byRole.planner.prompt, /Prior stage: test-runner/);

    assert.equal(byRole['test-writer'].prompt.includes('[Prior run outcome]'), false);
    assert.equal(byRole['code-writer'].prompt.includes('[Prior run outcome]'), false);
  });

  it('still includes ### Prior outcome / prompt block when the prior state was "done" (not failure-only)', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'also wire job records for --ask');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const donePrior = {
      state: 'done', phase: 'commit', stage: 'commit', round: null, exitCode: 0,
      finishedAt: '2026-07-27T09:00:00.000Z', task: 'implement the billing endpoint',
      summary: 'suite green', error: null,
    };

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('also wire job records for --ask', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: donePrior,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const research = MockAgentClass.instances.find((i) => agentRole(i.name) === 'research');
    assert.match(research.prompt, /Prior state: done/);

    const statusContent = fs.readFileSync(runContext.statusPath, 'utf8');
    assert.match(statusContent, /### Prior outcome/);
    assert.match(statusContent, /done/);
  });

  it('for a worker continue, extends the block with Fan-out parent / Worker id', async () => {
    const cwd = makeTmpCwd();
    const slug = 'merry-elk-r4b1';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failing invoice tests and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('fix the failing invoice tests and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        role: 'worker',
        parentSlug: 'wise-pine-e904',
        workerId: '02-invoices',
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        patchWorker: mock.fn(() => {}),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const research = MockAgentClass.instances.find((i) => agentRole(i.name) === 'research');
    assert.match(research.prompt, /Fan-out parent: wise-pine-e904/);
    assert.match(research.prompt, /Worker id: 02-invoices/);
  });
});

describe('runContinuePipeline — status.md appends, never overwrites', () => {
  it('preserves prior status.md content and appends ## Continue N + ### Prior outcome', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failure and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('fix the failure and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const statusContent = fs.readFileSync(runContext.statusPath, 'utf8');
    assert.match(statusContent, /- SHA: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`/);
    assert.match(statusContent, /## Continue 2/);
    assert.match(statusContent, /### Prior outcome/);
    assert.match(statusContent, /test-runner/);
    assert.match(statusContent, /tests failed on round 3/);
  });
});

describe('runContinuePipeline — commit message and terminal state', () => {
  it('commits once with the continue-N message shape: "orch: <slug> (continue <N>): <first line>"', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const commitWorktreeMock = mock.fn(() => fakeCommitResult(branch));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests\nmore detail on the second line', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: commitWorktreeMock,
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(commitWorktreeMock.mock.calls.length, 1);
    const [{ message }] = commitWorktreeMock.mock.calls[0].arguments;
    assert.equal(message, `orch: ${slug} (continue 2): tighten the file-tracker tests`);
  });

  it('on success, patches state:"done"/exitCode:0 and writes a fresh lastOutcome', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const record = readJob(cwd, slug);
    assert.equal(record.state, 'done');
    assert.equal(record.exitCode, 0);
    assert.ok(record.finishedAt);
    assert.ok(record.lastOutcome);
    assert.equal(record.lastOutcome.state, 'done');
    assert.equal(record.lastOutcome.task, 'tighten the file-tracker tests');
  });

  it('a clean tree (no changes) skips the commit and still exits 0 with state:"done"', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => ({ committed: false, sha: null, branch })),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    const record = readJob(cwd, slug);
    assert.equal(record.state, 'done');
    assert.equal(record.exitCode, 0);
  });

  it('a failed code loop exits non-zero, preserves the worktree, and writes a fresh terminal lastOutcome', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failure and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors({
      'test-runner': { ok: false, result: 'test runner crashed' },
    }));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runContinuePipeline('fix the failure and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called after a failed code loop'); }),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(exitSpy.mock.calls.some((c) => c.arguments[0] === 1));
    const record = readJob(cwd, slug);
    assert.equal(record.state, 'failed');
    assert.equal(record.exitCode, 1);
    assert.ok(record.lastOutcome);
    assert.equal(record.lastOutcome.state, 'failed');
    assert.equal(typeof record.lastOutcome.error, 'string');
    assert.ok(fs.existsSync(worktreePath), 'worktree must be preserved on failure, never deleted');
  });
});

describe('runContinuePipeline — fan-out worker bookkeeping', () => {
  it('on done+commit with role:"worker", patches parent fanout.json worker to done and prints an --integrate hint', async () => {
    const cwd = makeTmpCwd();
    const slug = 'merry-elk-r4b1';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failing invoice tests and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const sha = 'c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6c3d4e5f6';
    const patchWorkerMock = mock.fn(() => {});

    const logs = [];
    const logSpy = mock.method(console, 'log', (line) => { logs.push(String(line)); });
    try {
      await runContinuePipeline('fix the failing invoice tests and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        role: 'worker',
        parentSlug: 'wise-pine-e904',
        workerId: '02-invoices',
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch, sha)),
        recordChangedFiles: mock.fn(() => ['src/billing/invoices/create.ts']),
        patchWorker: patchWorkerMock,
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(patchWorkerMock.mock.calls.length, 1);
    const [callCwd, parentSlug, workerId, patch] = patchWorkerMock.mock.calls[0].arguments;
    assert.equal(callCwd, cwd);
    assert.equal(parentSlug, 'wise-pine-e904');
    assert.equal(workerId, '02-invoices');
    assert.equal(patch.state, 'done');
    assert.equal(patch.sha, sha);
    assert.deepEqual(patch.changedFiles, ['src/billing/invoices/create.ts']);

    assert.ok(logs.some((line) => line.includes('orch --integrate wise-pine-e904')));
  });

  it('on worker continue failure, patches the worker to "failed" and does not print an --integrate hint', async () => {
    const cwd = makeTmpCwd();
    const slug = 'merry-elk-r4b1';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'fix the failing invoice tests and finish');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors({
      'test-runner': { ok: false, result: 'test runner crashed' },
    }));
    const patchWorkerMock = mock.fn(() => {});

    const logs = [];
    const logSpy = mock.method(console, 'log', (line) => { logs.push(String(line)); });
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runContinuePipeline('fix the failing invoice tests and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        role: 'worker',
        parentSlug: 'wise-pine-e904',
        workerId: '02-invoices',
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called after a failed code loop'); }),
        patchWorker: patchWorkerMock,
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.equal(patchWorkerMock.mock.calls.length, 1);
    const [, , , patch] = patchWorkerMock.mock.calls[0].arguments;
    assert.equal(patch.state, 'failed');
    assert.equal(logs.some((line) => line.includes('--integrate')), false);
  });

  it('never calls patchWorker when role is unset (ordinary complex continue)', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    seedForegroundContinueJob(cwd, slug, 'tighten the file-tracker tests');
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());
    const patchWorkerMock = mock.fn(() => {});

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('tighten the file-tracker tests', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: 2,
        priorOutcome: FAILED_PRIOR_OUTCOME,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        patchWorker: patchWorkerMock,
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(patchWorkerMock.mock.calls.length, 0);
  });
});

/**
 * Issue #11 acceptance bullet: "at least one failure→continue pipeline
 * smoke" — exercised end-to-end through the real eligibility gate
 * (`validateContinue`) and the real reopen mechanics (`reopenJob`), not just
 * `runContinuePipeline` in isolation (every other describe block in this
 * file already calls `runContinuePipeline` directly with a hand-built
 * `failed`-shaped `priorOutcome`, which pins the pipeline's own contract but
 * not the gate that used to refuse this state before issue #11).
 */
describe('failed → continue: gate accepts, reopen bumps continuation, pipeline reaches done', () => {
  it('validateContinue no longer refuses a "failed" complex run; reopenJob + runContinuePipeline carry it to done', async () => {
    const cwd = makeTmpCwd();
    const slug = 'quirky-oasis-906b';
    const branch = `orch/${slug}`;
    const worktreePath = path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
    fs.mkdirSync(worktreePath, { recursive: true });

    writeJob(cwd, slug, {
      slug,
      task: 'implement the billing endpoint',
      agent: 'claude',
      maxRounds: 5,
      cwd,
      pauseRequested: false,
      branch,
      worktree: worktreePath,
      startedAt: '2026-07-27T09:00:00.000Z',
      finishedAt: '2026-07-27T10:00:00.000Z',
      exitCode: 1,
      pid: process.pid,
      state: 'failed',
      phase: 'code-loop',
      stage: 'test-runner',
      round: 3,
      role: null,
      parent: null,
      workerId: null,
      lastOutcome: FAILED_PRIOR_OUTCOME,
    });

    // 1. The gate itself: this used to throw "use: orch resume" pre-#11.
    const validated = validateContinue(cwd, slug, { task: 'fix the failure and finish' });
    assert.equal(validated.state, 'failed');

    // 2. Reopen in place: same slug/worktree/branch, continuation bumped,
    //    prior outcome carried forward.
    const prior = snapshotPriorOutcome(cwd, slug, validated);
    const reopened = reopenJob(cwd, slug, {
      task: 'fix the failure and finish',
      agent: validated.agent,
      maxRounds: validated.maxRounds,
      pid: process.pid,
      prior,
    });
    assert.equal(reopened.continuation, 2);
    assert.equal(reopened.state, 'running');
    assert.equal(reopened.phase, 'research');
    assert.equal(reopened.round, null);
    // No new job directory / worktree allocated for the reopen.
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.orch')), [slug]);

    const runContext = fakeRunContext(cwd, slug);
    seedPriorStatusMd(runContext, slug, branch, worktreePath);
    const MockAgentClass = createMockAgentClass(continuePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runContinuePipeline('fix the failure and finish', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        worktreePath,
        branch,
        continuation: reopened.continuation,
        priorOutcome: prior,
        createRunContext: mock.fn(() => runContext),
        commitWorktree: mock.fn(() => fakeCommitResult(branch)),
        jobSlug: slug,
        jobCwd: cwd,
      });
    } finally {
      logSpy.mock.restore();
    }

    // 3. Loops from round 1 with a fresh max-rounds budget, restarted from
    //    research, and lands on done — the prior failure carried context but
    //    did not block or truncate this attempt.
    const finalRecord = readJob(cwd, slug);
    assert.equal(finalRecord.state, 'done');
    assert.equal(finalRecord.exitCode, 0);
    assert.equal(finalRecord.continuation, 2);
    assert.ok(finalRecord.lastOutcome);
    assert.equal(finalRecord.lastOutcome.state, 'done');

    const research = MockAgentClass.instances.find((i) => agentRole(i.name) === 'research');
    assert.match(research.prompt, /\[Prior run outcome\]/);
    assert.match(research.prompt, /Prior state: failed/);
    assert.match(research.prompt, /Error: test-runner failed; stopping before commit/);
  });
});
