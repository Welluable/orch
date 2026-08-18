import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, formatStatus, runDetached } from '../main.js';
import { jobPaths, readJob, writeJob, patchJob as realPatchJob } from '../lib/jobs.js';
import {
  askSessionPaths,
  readAskSession,
  writeAskSession,
} from '../lib/ask-session.js';
import { writeConfig, localConfigPath } from '../lib/config.js';
import * as agentLib from '../lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

/** A fresh, isolated `.orch`-owning directory for real-disk job-record
 * assertions (mirrors test/headless.test.js's makeTmpCwd). */
function makeTmpCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const PINNED_BRANCH_PREFIX = 'long_running_session';

function pinLocalBranchPrefix(cwd, prefix = PINNED_BRANCH_PREFIX) {
  writeConfig(localConfigPath(cwd), { branchPrefix: prefix });
  return prefix;
}

/** runPipeline creates at process.cwd(); pin/chdir against that, not jobCwd. */
async function withChdirAndIsolatedHome(dir, fn) {
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-home-'));
  process.env.HOME = isolatedHome;
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

/** Wraps a captured-calls patchJob mock so it *also* writes through to the
 * real lib/jobs.js patchJob against a real tmp `.orch` dir — giving both the
 * precise ordered-call assertions the existing tests rely on, and a real
 * run.json on disk to read back afterward (the stronger, established pattern
 * from test/headless.test.js's runPipeline job-phase-tracking tests). */
function realDiskPatchJobSpy(patchCalls) {
  return mock.fn((cwd, slug, fields) => {
    patchCalls.push({ cwd, slug, fields });
    realPatchJob(cwd, slug, fields);
  });
}

/** Seeds a real run.json on disk in the "foreground/non-detached, already
 * running" shape allocateJob is expected to write (state:"running", a real
 * pid, no branch/worktree/rounds concept yet) — the exact starting point the
 * Commander action's non-detached branch would hand off to runPipeline. */
function seedForegroundJob(tmpCwd, slug, task) {
  writeJob(tmpCwd, slug, {
    slug,
    task,
    agent: 'claude',
    maxRounds: null,
    cwd: tmpCwd,
    pauseRequested: false,
    branch: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logPath: jobPaths(tmpCwd, slug).logPath,
    pid: process.pid,
    state: 'running',
    phase: null,
    stage: null,
    round: null,
  });
}

function runCli(args, { cwd = path.join(__dirname, '..'), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Minimal fake detach spawn used by --pr/--base argv-forwarding checks. */
function fakeDetachSpawn(pid) {
  return mock.fn(() => {
    const child = {
      pid,
      unref() {},
    };
    return child;
  });
}

describe('main.js CLI', () => {
  it('prints help for --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /The Orchestrator/);
    assert.match(stdout, /<task\.\.\.>/);
  });

  it('--help lists agn and opencode alongside cursor and claude', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /cursor/);
    assert.match(stdout, /claude/);
    assert.match(stdout, /agn/);
    assert.match(stdout, /opencode/);
  });

  it('help output mentions --agent, --verbose, --dry-run, --max-rounds, --ask, --quick, --pr, and --base', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--verbose/);
    assert.match(stdout, /--agent/);
    assert.match(stdout, /--dry-run/);
    assert.match(stdout, /--max-rounds/);
    assert.match(stdout, /--ask/);
    assert.match(stdout, /--quick/);
    assert.match(stdout, /--pr/);
    assert.match(stdout, /--base/);
  });

  it('--dry-run reports readiness without running the pipeline', async () => {
    // Isolate HOME so a developer/global ~/.orch/config cannot change the
    // effective agent when --agent is omitted.
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dry-home-'));
    const { code, stdout, stderr } = await runCli(['noop', '--dry-run'], {
      env: { ...process.env, HOME: isolatedHome },
    });
    assert.match(stdout, /cwd:/);
    assert.match(stdout, /agent:\s+cursor/);
    assert.match(stdout, /^(pass|fail)$/m);
    assert.doesNotMatch(stdout, /triage|research|planner|test-writer|code-writer/i);
    assert.doesNotMatch(stdout, /model:/);
    if (code === 0) {
      assert.match(stdout, /^pass$/m);
    } else {
      assert.equal(code, 1);
      assert.match(stdout, /^fail$/m);
      assert.match(stderr, /agent not found/i);
    }
  });

  it('--dry-run never creates a worktree even with a pinned local branchPrefix', async () => {
    const cwd = makeTmpCwd('orch-dry-prefix-');
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dry-home-'));
    try {
      pinLocalBranchPrefix(cwd);
      const { stdout } = await runCli(['noop', '--dry-run', '--agent', 'claude'], {
        cwd,
        env: { ...process.env, HOME: isolatedHome },
      });
      assert.match(stdout, /^(pass|fail)$/m);
      assert.doesNotMatch(stdout, /triage|research|planner|test-writer|code-writer/i);
      const siblingPrefix = `${path.basename(cwd)}-`;
      const siblings = fs.readdirSync(path.dirname(cwd)).filter((name) => name.startsWith(siblingPrefix));
      assert.deepEqual(siblings, [], `dry-run must not create sibling worktrees, created: ${siblings.join(',')}`);
      const orchDir = path.join(cwd, '.orch');
      const orchEntries = fs.existsSync(orchDir) ? fs.readdirSync(orchDir) : [];
      assert.deepEqual(
        orchEntries.filter((entry) => entry !== 'config'),
        [],
        'dry-run must not allocate a job directory',
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it('--agent agn --dry-run prints agent: agn and resolves the agn binary', async () => {
    const { code, stdout, stderr } = await runCli(['noop', '--dry-run', '--agent', 'agn']);
    assert.match(stdout, /cwd:/);
    assert.match(stdout, /agent:\s+agn/);
    assert.match(stdout, /^(pass|fail)$/m);
    assert.doesNotMatch(stdout, /model:/);
    if (code === 0) {
      assert.match(stdout, /^pass$/m);
    } else {
      assert.equal(code, 1);
      assert.match(stdout, /^fail$/m);
      assert.match(stderr, /agn not found/i);
    }
  });

  it('reports the agn-specific install hint when the agn binary is not on PATH', async () => {
    // Force a PATH with no binaries at all, so `which agn` deterministically
    // fails regardless of whether the local dev machine has agn installed.
    const { code, stdout, stderr } = await runCli(
      ['noop', '--dry-run', '--agent', 'agn'],
      { env: { ...process.env, PATH: '/nonexistent-empty-path-for-tests' } },
    );
    assert.equal(code, 1);
    assert.match(stdout, /^fail$/m);
    assert.match(stderr, /agn not found/i);
    assert.match(stderr, /npm install -g @welluable\/agn-cli/);
  });

  it('--agent opencode --dry-run prints agent: opencode and resolves the opencode binary', async () => {
    const { code, stdout, stderr } = await runCli(['noop', '--dry-run', '--agent', 'opencode']);
    assert.match(stdout, /cwd:/);
    assert.match(stdout, /agent:\s+opencode/);
    assert.match(stdout, /^(pass|fail)$/m);
    assert.doesNotMatch(stdout, /model:/);
    if (code === 0) {
      assert.match(stdout, /^pass$/m);
    } else {
      assert.equal(code, 1);
      assert.match(stdout, /^fail$/m);
      assert.match(stderr, /opencode not found/i);
    }
  });

  it('reports the opencode-specific install hint when the opencode binary is not on PATH', async () => {
    const { code, stdout, stderr } = await runCli(
      ['noop', '--dry-run', '--agent', 'opencode'],
      { env: { ...process.env, PATH: '/nonexistent-empty-path-for-tests' } },
    );
    assert.equal(code, 1);
    assert.match(stdout, /^fail$/m);
    assert.match(stderr, /opencode not found/i);
    assert.match(stderr, /opencode\.ai/);
  });

  it('rejects missing task argument', async () => {
    const { code, stderr } = await runCli([]);
    assert.notEqual(code, 0);
    assert.match(stderr, /missing required argument/i);
  });

  it('rejects empty task argument', async () => {
    const { code, stderr } = await runCli(['']);
    assert.equal(code, 1);
    assert.match(stderr, /task cannot be empty/i);
  });

  it('rejects whitespace-only task argument', async () => {
    const { code, stderr } = await runCli(['   ']);
    assert.equal(code, 1);
    assert.match(stderr, /task cannot be empty/i);
  });

  it('rejects invalid --agent value', async () => {
    const { code, stderr } = await runCli(['some text', '--agent', 'foo']);
    assert.notEqual(code, 0);
    assert.match(stderr, /cursor/);
    assert.match(stderr, /claude/);
    assert.match(stderr, /agn/);
    assert.match(stderr, /opencode/);
  });

  it('accepts a multi-word positional task argument without an argument-parsing error', async () => {
    const { code, stderr } = await runCli(['fix', 'the', 'typo', '--agent', 'foo']);
    assert.notEqual(code, 0);
    assert.doesNotMatch(stderr, /missing required argument/i);
    assert.match(stderr, /cursor/);
    assert.match(stderr, /claude/);
    assert.match(stderr, /agn/);
    assert.match(stderr, /opencode/);
  });

  it('does not create .orch merely from being invoked, in either the install dir or the invocation cwd', async () => {
    // Copies main.js/lib/package.json into a fresh "install dir" (symlinking
    // node_modules instead of copying it) so this test can detect a
    // `.orch` directory created relative to the package's own location
    // (e.g. via __dirname), which the real repo's pre-existing `.orch`
    // would otherwise mask.
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-install-'));
    const invocationCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-invocation-'));
    const repoRoot = path.join(__dirname, '..');
    try {
      fs.copyFileSync(path.join(repoRoot, 'main.js'), path.join(installDir, 'main.js'));
      fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(installDir, 'package.json'));
      fs.cpSync(path.join(repoRoot, 'lib'), path.join(installDir, 'lib'), { recursive: true });
      const agentsSrc = path.join(repoRoot, 'agents');
      if (fs.existsSync(agentsSrc)) {
        fs.cpSync(agentsSrc, path.join(installDir, 'agents'), { recursive: true });
      }
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(installDir, 'node_modules'), 'dir');

      const { code } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(installDir, 'main.js'), '--help'], {
          cwd: invocationCwd,
          env: process.env,
        });
        let code = null;
        child.on('error', reject);
        child.on('close', (c) => {
          code = c;
          resolve({ code });
        });
      });

      assert.equal(code, 0);
      assert.equal(fs.existsSync(path.join(installDir, '.orch')), false);
      assert.equal(fs.existsSync(path.join(invocationCwd, '.orch')), false);
    } finally {
      fs.rmSync(installDir, { recursive: true, force: true });
      fs.rmSync(invocationCwd, { recursive: true, force: true });
    }
  });
});

/** Strip an optional ` k/N` round suffix from an agent spinner name. */
function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

/** Escape a string for safe embedding in a `new RegExp(...)` pattern. */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches the titled/bulleted block printStageSummary emits for a given
 * label + summary paragraph: a `label` title line followed by a `• summary`
 * bullet line. */
function stageSummaryBlockRegex(label, summary) {
  return new RegExp(` ${escapeRegex(label)} \\n─+\\n {2}• ${escapeRegex(summary)}`);
}

/** Builds a fake `AgentClass` that records construction order (and, per
 * instance, the options/prompt it was constructed with) and resolves
 * per-name canned results, so `runPipeline`'s branching can be tested without
 * spawning real agent CLIs. `order`, if given, is a shared array that also
 * receives a push for every construction — used to interleave agent
 * construction with createRunContext/createWorktree calls.
 *
 * Behaviors may be a single result object, or an array queue consumed in order
 * (needed for multi-round critic/runner loops). Lookup matches the full name
 * or the role without a `k/N` suffix. */
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
      // When main wires a fileTracker onto writers, simulate a completed Write so
      // printStageSummary can exercise the Files (N) section end-to-end.
      if (
        this.options?.fileTracker
        && typeof this.options.fileTracker.record === 'function'
        && (role === 'test-writer' || role === 'code-writer')
      ) {
        const filePath = role === 'test-writer' ? 'test/example.test.js' : 'lib/example.js';
        const callId = `${role}-sim`;
        this.options.fileTracker.record({
          name: 'Write',
          args: { path: filePath },
          phase: 'started',
          callId,
        });
        this.options.fileTracker.record({
          name: 'Write',
          args: { path: filePath },
          phase: 'completed',
          callId,
        });
      }
      const behavior = behaviors[this.name] ?? behaviors[role];
      if (Array.isArray(behavior)) {
        if (!(role in queues)) {
          queues[role] = behavior.slice();
        }
        if (queues[role].length > 0) {
          return queues[role].shift();
        }
        return behavior[behavior.length - 1] ?? { ok: true, result: '' };
      }
      return behavior ?? { ok: true, result: '' };
    }
  }

  MockAgent.instances = instances;
  return MockAgent;
}

const SUMMARY_DELIM = '<<<SUMMARY>>>';

/** Appends a `<<<SUMMARY>>>` block with a distinct fixture paragraph to a
 * stage's canned result, mirroring what agents/*.js instructs each stage to
 * append after its required final message/JSON/path. */
function withSummary(content, summary) {
  return `${content}\n${SUMMARY_DELIM}\n${summary}`;
}

const TRIAGE_SUMMARY = 'Triage judged the request too involved for a quick fix and routed it to the research pipeline.';
const SIMPLE_TRIAGE_SUMMARY = 'Triage judged the request a safe one-file typo fix and routed it straight to quick-fix.';
const QUICK_FIX_SUMMARY = 'Quick-fix applied the smallest edit needed to resolve the typo.';
const RESEARCH_SUMMARY = 'Research walked the codebase and wrote its findings to the research doc.';
const PLANNER_SUMMARY = 'Planner turned the research findings into a step-by-step task checklist.';
const TEST_WRITER_SUMMARY = 'Test writer added coverage for the new behavior and recorded a verification plan in status.md.';
const TEST_CRITIC_SUMMARY = 'Test critic reviewed the new tests and judged the coverage adequate to freeze.';
const FAIL_CRITIC_SUMMARY = 'Test critic found the tests missing coverage for the max-rounds edge case.';
const CODE_WRITER_SUMMARY = 'Code writer implemented the checklist against the frozen verification.';
const TEST_RUNNER_SUMMARY = 'Test runner executed the suite and confirmed every test passed.';
const FAIL_RUNNER_SUMMARY = 'Test runner executed the suite and found that parseVerdict was missing.';
const ASK_SUMMARY = 'Ask agent explained where the CLI entrypoint lives without changing any files.';

const COMPLEX_TRIAGE = {
  ok: true,
  result: withSummary(JSON.stringify({ simple: false, why: 'needs research' }), TRIAGE_SUMMARY),
};
const SIMPLE_TRIAGE = {
  ok: true,
  result: withSummary(JSON.stringify({ simple: true, why: 'typo' }), SIMPLE_TRIAGE_SUMMARY),
};
const PASS_CRITIC = {
  ok: true,
  result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), TEST_CRITIC_SUMMARY),
};
const PASS_RUNNER = {
  ok: true,
  result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), TEST_RUNNER_SUMMARY),
};
const FAIL_CRITIC = {
  ok: true,
  result: withSummary(
    JSON.stringify({
      passed: false,
      summary: 'missing coverage',
      failures: ['no assert for max-rounds'],
    }),
    FAIL_CRITIC_SUMMARY,
  ),
};
const FAIL_RUNNER = {
  ok: true,
  result: withSummary(
    JSON.stringify({
      passed: false,
      summary: 'tests failed',
      failures: ['parseVerdict missing'],
    }),
    FAIL_RUNNER_SUMMARY,
  ),
};

/** Default stubs for a complex path that passes both loops in one round. */
function complexPassBehaviors(overrides = {}) {
  return {
    triage: COMPLEX_TRIAGE,
    research: { ok: true, result: withSummary('research-output', RESEARCH_SUMMARY) },
    planner: { ok: true, result: withSummary('planner-output', PLANNER_SUMMARY) },
    'test-writer': { ok: true, result: withSummary('tests written', TEST_WRITER_SUMMARY) },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: withSummary('done', CODE_WRITER_SUMMARY) },
    'test-runner': PASS_RUNNER,
    ...overrides,
  };
}

/** A stand-in for `createRunContext({ cwd })`'s return value, matching the
 * shape orch itself would produce for a given invocation cwd/slug. */
function fakeRunContext(cwd, slug = 'stub-stub-0000') {
  const artifactDir = path.join(cwd, '.orch', slug);
  return {
    slug,
    artifactDir,
    researchPath: path.join(artifactDir, 'research.md'),
    taskPath: path.join(artifactDir, 'task.md'),
    statusPath: path.join(artifactDir, 'status.md'),
  };
}

function fakeWorktree(cwd, slug = 'stub-stub-0000') {
  return {
    repoRoot: cwd,
    worktreePath: path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`),
    branch: `orch/${slug}`,
  };
}

/** A stand-in for `commitWorktree(...)`'s return value on a successful,
 * non-empty commit. */
function fakeCommitResult(branch, sha = 'deadbeefcafebabe0000000000000000000000') {
  return { committed: true, sha, branch };
}

describe('runPipeline nested implementer stages', () => {
  it('constructs test-writer → test-critic → code-writer → test-runner after planner', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors({
      'test-writer': { ok: true, result: 'worktree: /tmp/foo' },
    }));

    const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['triage', 'research', 'planner', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
    assert.equal(commitWorktreeMock.mock.calls.length, 1);
  });

  it('labels implementer agents with roundLabel N/M suffixes (default maxRounds=5)', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const names = MockAgentClass.instances.map((i) => i.name);
    assert.deepEqual(
      names.filter((n) => /^(test-writer|test-critic|code-writer|test-runner)\b/.test(n)),
      ['test-writer 1/5', 'test-critic 1/5', 'code-writer 1/5', 'test-runner 1/5'],
    );
    // Static roles stay unsuffixed.
    assert.ok(names.includes('triage'));
    assert.ok(names.includes('research'));
    assert.ok(names.includes('planner'));
    assert.equal(names.includes('triage 1/5'), false);
  });

  it('skips critic/code loop and exits non-zero when test-writer resolves ok:false', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors({
      'test-writer': { ok: false, result: 'not a git repository' },
    }));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => agentRole(i.name)),
      ['triage', 'research', 'planner', 'test-writer'],
    );
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });
});

describe('runPipeline cwd-scoped artifacts and orch-owned worktrees', () => {
  it('quick-fix creates no run context and no worktree', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { triage: SIMPLE_TRIAGE, 'quick-fix': { ok: true, result: 'fixed' } },
      { order },
    );
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage', 'quick-fix']);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });

  it('creates one run context and one worktree, in order, between planner and test-writer', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const order = [];

    const createRunContextMock = mock.fn((opts) => {
      order.push('createRunContext');
      assert.equal(opts.cwd, invocationCwd);
      return runContext;
    });
    const createWorktreeMock = mock.fn((opts) => {
      order.push('createWorktree');
      assert.equal(opts.cwd, invocationCwd);
      assert.equal(opts.slug, runContext.slug);
      return worktree;
    });
    const commitWorktreeMock = mock.fn((opts) => {
      order.push('commitWorktree');
      assert.equal(opts.worktreePath, worktree.worktreePath);
      assert.equal(opts.branch, worktree.branch);
      return fakeCommitResult(worktree.branch);
    });

    const MockAgentClass = createMockAgentClass(complexPassBehaviors(), { order });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, [
      'triage',
      'createRunContext',
      'research',
      'planner',
      'createWorktree',
      'test-writer',
      'test-critic',
      'code-writer',
      'test-runner',
      'commitWorktree',
    ]);
    assert.equal(createRunContextMock.mock.calls.length, 1);
    assert.equal(createWorktreeMock.mock.calls.length, 1);
    assert.equal(commitWorktreeMock.mock.calls.length, 1);

    const byRole = Object.fromEntries(
      MockAgentClass.instances.map((i) => [agentRole(i.name), i]),
    );
    assert.equal(byRole.research.options?.cwd, invocationCwd);
    assert.equal(byRole.planner.options?.cwd, invocationCwd);
    assert.equal(byRole['test-writer'].options?.cwd, worktree.worktreePath);
    assert.equal(byRole['test-critic'].options?.cwd, worktree.worktreePath);
    assert.equal(byRole['code-writer'].options?.cwd, worktree.worktreePath);
    assert.equal(byRole['test-runner'].options?.cwd, worktree.worktreePath);
  });

  it('passes the pinned local branchPrefix into createWorktree on the complex path', async () => {
    const tmpCwd = makeTmpCwd('orch-prefix-complex-');
    const prefix = pinLocalBranchPrefix(tmpCwd);
    try {
      await withChdirAndIsolatedHome(tmpCwd, async () => {
        const slug = 'prefix-complex-0000';
        seedForegroundJob(tmpCwd, slug, 'do something complex');
        const runContext = fakeRunContext(tmpCwd, slug);
        const worktree = fakeWorktree(tmpCwd, slug);
        const createWorktreeMock = mock.fn(() => worktree);
        const MockAgentClass = createMockAgentClass(complexPassBehaviors());
        const logSpy = mock.method(console, 'log', () => {});
        try {
          await runPipeline('do something complex', {
            agent: 'claude',
            AgentClass: MockAgentClass,
            createRunContext: mock.fn(() => runContext),
            createWorktree: createWorktreeMock,
            commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
            jobSlug: slug,
            jobCwd: tmpCwd,
            patchJob: realDiskPatchJobSpy([]),
          });
        } finally {
          logSpy.mock.restore();
        }

        assert.equal(createWorktreeMock.mock.calls.length, 1);
        assert.equal(createWorktreeMock.mock.calls[0].arguments[0].slug, slug);
        assert.equal(createWorktreeMock.mock.calls[0].arguments[0].cwd, process.cwd());
        assert.equal(createWorktreeMock.mock.calls[0].arguments[0].branchPrefix, prefix);
      });
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('dry-run never calls createWorktree even with a pinned local branchPrefix', async () => {
    const tmpCwd = makeTmpCwd('orch-prefix-dry-');
    pinLocalBranchPrefix(tmpCwd);
    try {
      await withChdirAndIsolatedHome(tmpCwd, async () => {
        const createWorktreeMock = mock.fn(() => fakeWorktree(tmpCwd));
        const logSpy = mock.method(console, 'log', () => {});
        const exitSpy = mock.method(process, 'exit', () => {});
        try {
          await runPipeline('noop', {
            agent: 'claude',
            dryRun: true,
            AgentClass: createMockAgentClass(complexPassBehaviors()),
            createWorktree: createWorktreeMock,
          });
        } finally {
          logSpy.mock.restore();
          exitSpy.mock.restore();
        }
        assert.equal(createWorktreeMock.mock.calls.length, 0);
      });
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('research and planner prompts reference the exact absolute paths, not a <taskname> placeholder', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    const MockAgentClass = createMockAgentClass(complexPassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const [, research, planner] = MockAgentClass.instances;
    assert.ok(research.instructions.includes(runContext.researchPath));
    assert.ok(planner.instructions.includes(runContext.researchPath));
    assert.ok(planner.instructions.includes(runContext.taskPath));
    assert.doesNotMatch(research.instructions, /<taskname>/);
    assert.doesNotMatch(planner.instructions, /<taskname>/);

    const byRole = Object.fromEntries(
      MockAgentClass.instances.map((i) => [agentRole(i.name), i]),
    );
    for (const role of ['test-writer', 'test-critic', 'code-writer', 'test-runner']) {
      assert.ok(
        byRole[role].instructions.includes(runContext.researchPath),
        `${role} must receive researchPath`,
      );
      assert.match(
        byRole[role].instructions,
        /Do not re-search or re-document/i,
        `${role} must include the consumer hard rule`,
      );
    }
  });

  it('passes the structured worktree path/branch to code-writer instead of parsed test-writer prose', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    const MockAgentClass = createMockAgentClass(complexPassBehaviors({
      // Deliberately does not mention the worktree path or branch in its
      // prose result, so code-writer can only have gotten them structurally.
      'test-writer': { ok: true, result: 'tests written, see status.md' },
    }));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const codeWriter = MockAgentClass.instances.find((i) => agentRole(i.name) === 'code-writer');
    assert.ok(codeWriter.instructions.includes(worktree.worktreePath) || codeWriter.prompt.includes(worktree.worktreePath));
    assert.equal(codeWriter.options?.cwd, worktree.worktreePath);
  });

  it('writes status.md with the slug, branch, and worktree path before test-writer runs', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-status-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      let statusAtTestWriterStart = null;
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());

      const RecordingAgentClass = class extends MockAgentClass {
        async run(...args) {
          if (agentRole(this.name) === 'test-writer' && fs.existsSync(runContext.statusPath)) {
            statusAtTestWriterStart = fs.readFileSync(runContext.statusPath, 'utf8');
          }
          return super.run(...args);
        }
      };

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: RecordingAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.ok(statusAtTestWriterStart, 'status.md should exist by the time test-writer starts');
      assert.match(statusAtTestWriterStart, new RegExp(runContext.slug));
      assert.match(statusAtTestWriterStart, new RegExp(worktree.branch.replace('/', '\\/')));
      assert.match(statusAtTestWriterStart, new RegExp(worktree.worktreePath.replace(/[/\\]/g, '\\$&')));
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('a failed code-writer (ok: false) skips commitWorktree entirely', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const order = [];

    const MockAgentClass = createMockAgentClass(
      complexPassBehaviors({
        'code-writer': { ok: false, result: 'implementation failed' },
      }),
      { order },
    );
    const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, [
      'triage',
      'research',
      'planner',
      'test-writer',
      'test-critic',
      'code-writer',
    ]);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
  });

  it('a commitWorktree result of committed: false appends a "no changes" ## Commit section and exits 0', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-commit-noop-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const commitWorktreeMock = mock.fn(() => ({ committed: false, sha: null, branch: worktree.branch }));

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: commitWorktreeMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(commitWorktreeMock.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls.length, 0);

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Commit/);
      assert.match(status, /no changes/i);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('a commitWorktree throw exits non-zero without reporting false success in status.md', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-commit-fail-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const commitWorktreeMock = mock.fn(() => {
        throw new Error('git commit -m failed: hook declined');
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: commitWorktreeMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(commitWorktreeMock.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      assert.ok(
        errorSpy.mock.calls.some((call) => /hook declined/.test(call.arguments[0] ?? '')),
        'the commitWorktree error message should be surfaced via console.error',
      );

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.doesNotMatch(status, /## Commit/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('appends a ## Commit section with sha and branch to status.md without clobbering earlier content', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-commit-append-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const sha = 'deadbeefcafebabe0000000000000000000000';
      const commitWorktreeMock = mock.fn(() => ({ committed: true, sha, branch: worktree.branch }));

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: commitWorktreeMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      // Earlier content (written before test-writer runs) must survive the append.
      assert.match(status, new RegExp(runContext.slug));
      assert.match(status, new RegExp(worktree.branch.replace('/', '\\/')));
      assert.match(status, new RegExp(worktree.worktreePath.replace(/[/\\]/g, '\\$&')));
      // Appended commit section.
      assert.match(status, /## Commit/);
      assert.match(status, new RegExp(sha.slice(0, 7)));
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('a createWorktree failure prevents both test-writer and code-writer from running', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const order = [];

    const MockAgentClass = createMockAgentClass(
      {
        triage: COMPLEX_TRIAGE,
        research: { ok: true, result: 'research-output' },
        planner: { ok: true, result: 'planner-output' },
      },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => {
          throw new Error('not a git repository');
        }),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage', 'research', 'planner']);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
  });

  it('a createRunContext failure stops the pipeline before research', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { triage: COMPLEX_TRIAGE },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => {
          throw new Error('failed to create artifact directory');
        }),
        createWorktree: mock.fn(() => {
          throw new Error('should never be called');
        }),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage']);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
  });
});

describe('runPipeline implementer loops', () => {
  async function runComplex(behaviors, {
    maxRounds,
    commitWorktreeMock,
    runContext: givenRunContext,
    worktree: givenWorktree,
    order,
  } = {}) {
    const invocationCwd = process.cwd();
    const runContext = givenRunContext ?? fakeRunContext(invocationCwd);
    const worktree = givenWorktree ?? fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors(behaviors), { order });
    const commitMock = commitWorktreeMock ?? mock.fn(() => fakeCommitResult(worktree.branch));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        maxRounds,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: commitMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    return { MockAgentClass, commitMock, exitSpy, errorSpy, runContext, worktree };
  }

  it('defaults maxRounds to 5 when options.maxRounds is omitted', async () => {
    const order = [];
    const { MockAgentClass, commitMock, exitSpy } = await runComplex(
      { 'test-critic': FAIL_CRITIC },
      { order },
    );

    const writerCriticPairs = order.filter((n) => n === 'test-writer' || n === 'test-critic');
    // 5 rounds × (test-writer + test-critic)
    assert.equal(writerCriticPairs.length, 10);
    assert.deepEqual(
      order.filter((n) => n === 'code-writer' || n === 'test-runner'),
      [],
    );
    assert.equal(commitMock.mock.calls.length, 0);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
    assert.equal(
      MockAgentClass.instances.filter((i) => agentRole(i.name) === 'test-writer').length,
      5,
    );
  });

  it('stops the test loop after maxRounds critic failures with no code loop and no commit', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-loop-exhaust-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);
      const order = [];

      const { commitMock, exitSpy } = await runComplex(
        { 'test-critic': FAIL_CRITIC },
        { maxRounds: 2, order, runContext, worktree },
      );

      assert.deepEqual(
        order.filter((n) => !['triage', 'research', 'planner'].includes(n)),
        ['test-writer', 'test-critic', 'test-writer', 'test-critic'],
      );
      assert.equal(commitMock.mock.calls.length, 0);
      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Test loop/);
      assert.match(status, /Rounds:\s*2\/2/i);
      assert.match(status, /Result:\s*failed/i);
      assert.doesNotMatch(status, /## Code loop/);
      assert.doesNotMatch(status, /## Commit/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('respawns test-writer with [Test Critic Feedback] after a soft critic failure', async () => {
    const order = [];
    const { MockAgentClass, commitMock, exitSpy } = await runComplex(
      {
        'test-writer': [
          { ok: true, result: 'tests v1' },
          { ok: true, result: 'tests v2' },
        ],
        'test-critic': [FAIL_CRITIC, PASS_CRITIC],
      },
      { maxRounds: 3, order },
    );

    assert.deepEqual(
      order.filter((n) => !['triage', 'research', 'planner'].includes(n)),
      ['test-writer', 'test-critic', 'test-writer', 'test-critic', 'code-writer', 'test-runner'],
    );
    assert.equal(commitMock.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls.length, 0);

    const writers = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'test-writer');
    assert.equal(writers.length, 2);
    assert.equal(writers[0].name, 'test-writer 1/3');
    assert.equal(writers[1].name, 'test-writer 2/3');
    const critics = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'test-critic');
    assert.equal(critics[0].name, 'test-critic 1/3');
    assert.equal(critics[1].name, 'test-critic 2/3');
    const secondPrompt = `${writers[1].instructions}\n${writers[1].prompt}`;
    assert.match(secondPrompt, /\[Test Critic Feedback\]/);
    assert.match(secondPrompt, /missing coverage|no assert for max-rounds/);
    assert.doesNotMatch(`${writers[0].instructions}\n${writers[0].prompt}`, /\[Test Critic Feedback\]/);
  });

  it('injects [Accepted Verification] into round-1 code-writer and commits when runner passes', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-code-loop-pass-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      const { MockAgentClass, commitMock, exitSpy } = await runComplex(
        {
          'test-writer': { ok: true, result: 'npm test\ntest/main.test.js' },
          'test-critic': {
            ok: true,
            result: JSON.stringify({ passed: true, summary: 'verification accepted' }),
          },
        },
        { runContext, worktree },
      );

      assert.equal(commitMock.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls.length, 0);

      const codeWriter = MockAgentClass.instances.find((i) => agentRole(i.name) === 'code-writer');
      const codePrompt = `${codeWriter.instructions}\n${codeWriter.prompt}`;
      assert.match(codePrompt, /\[Accepted Verification\]/);
      assert.doesNotMatch(codePrompt, /\[Test Runner Feedback\]/);
      // code-writer must not be told to gate on running the suite itself
      assert.doesNotMatch(codeWriter.instructions, /finish regardless of failure/i);

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Test loop/);
      assert.match(status, /Result:\s*passed/i);
      assert.match(status, /## Code loop/);
      assert.match(status, /Result:\s*passed/i);
      assert.match(status, /## Commit/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('respawns code-writer with [Test Runner Feedback] after a soft runner failure, then commits on pass', async () => {
    const order = [];
    const { MockAgentClass, commitMock, exitSpy } = await runComplex(
      {
        'code-writer': [
          { ok: true, result: 'impl v1' },
          { ok: true, result: 'impl v2' },
        ],
        'test-runner': [FAIL_RUNNER, PASS_RUNNER],
      },
      { maxRounds: 3, order },
    );

    assert.deepEqual(
      order.filter((n) => !['triage', 'research', 'planner', 'test-writer', 'test-critic'].includes(n)),
      ['code-writer', 'test-runner', 'code-writer', 'test-runner'],
    );
    assert.equal(commitMock.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls.length, 0);

    const writers = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'code-writer');
    assert.equal(writers.length, 2);
    assert.equal(writers[0].name, 'code-writer 1/3');
    assert.equal(writers[1].name, 'code-writer 2/3');
    const runners = MockAgentClass.instances.filter((i) => agentRole(i.name) === 'test-runner');
    assert.equal(runners[0].name, 'test-runner 1/3');
    assert.equal(runners[1].name, 'test-runner 2/3');
    assert.match(`${writers[0].instructions}\n${writers[0].prompt}`, /\[Accepted Verification\]/);
    assert.match(`${writers[1].instructions}\n${writers[1].prompt}`, /\[Test Runner Feedback\]/);
    assert.match(`${writers[1].instructions}\n${writers[1].prompt}`, /parseVerdict missing|tests failed/);
  });

  it('exhausts the code loop without committing when the runner never passes', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-code-loop-exhaust-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);
      const order = [];

      const { commitMock, exitSpy } = await runComplex(
        { 'test-runner': FAIL_RUNNER },
        { maxRounds: 2, order, runContext, worktree },
      );

      assert.deepEqual(
        order.filter((n) => !['triage', 'research', 'planner', 'test-writer', 'test-critic'].includes(n)),
        ['code-writer', 'test-runner', 'code-writer', 'test-runner'],
      );
      assert.equal(commitMock.mock.calls.length, 0);
      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Test loop/);
      assert.match(status, /Result:\s*passed/i);
      assert.match(status, /## Code loop/);
      assert.match(status, /Rounds:\s*2\/2/i);
      assert.match(status, /Result:\s*failed/i);
      assert.doesNotMatch(status, /## Commit/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('hard-fails immediately when test-critic resolves ok:false (no further rounds)', async () => {
    const order = [];
    const { commitMock, exitSpy } = await runComplex(
      { 'test-critic': { ok: false, result: 'critic crashed' } },
      { maxRounds: 5, order },
    );

    assert.deepEqual(
      order.filter((n) => !['triage', 'research', 'planner'].includes(n)),
      ['test-writer', 'test-critic'],
    );
    assert.equal(commitMock.mock.calls.length, 0);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
  });

  it('treats an unparseable critic verdict as a soft fail that consumes a round', async () => {
    const order = [];
    const { commitMock, exitSpy } = await runComplex(
      {
        'test-writer': [
          { ok: true, result: 'v1' },
          { ok: true, result: 'v2' },
        ],
        'test-critic': [
          { ok: true, result: 'not a verdict at all' },
          PASS_CRITIC,
        ],
      },
      { maxRounds: 3, order },
    );

    assert.ok(order.includes('code-writer'));
    assert.equal(commitMock.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls.length, 0);
    assert.equal(order.filter((n) => n === 'test-writer').length, 2);
  });

  it('does not re-enter the test loop after the code loop starts', async () => {
    const order = [];
    await runComplex(
      {
        'code-writer': [
          { ok: true, result: 'impl v1' },
          { ok: true, result: 'impl v2' },
        ],
        'test-runner': [FAIL_RUNNER, PASS_RUNNER],
      },
      { maxRounds: 3, order },
    );

    const afterCode = order.slice(order.indexOf('code-writer'));
    assert.equal(afterCode.filter((n) => n === 'test-writer' || n === 'test-critic').length, 0);
  });
});

describe('runPipeline --ask (read-only Q&A)', () => {
  it('spawns only an ask agent — never triage, quick-fix, research, or implementers', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { ask: { ok: true, result: 'The entrypoint is main.js.' } },
      { order },
    );
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where is the CLI entrypoint?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['ask']);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });

  it('constructs the ask agent with cwd === invocationCwd and readOnly: true', async () => {
    const invocationCwd = process.cwd();
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: 'answer' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('what does Agent.run do?', {
        agent: 'cursor',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(invocationCwd)),
        createWorktree: mock.fn(() => fakeWorktree(invocationCwd)),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.equal(MockAgentClass.instances.length, 1);
    const askAgent = MockAgentClass.instances[0];
    assert.equal(askAgent.name, 'ask');
    assert.equal(askAgent.options?.cwd, invocationCwd);
    assert.equal(askAgent.options?.readOnly, true);
  });

  it('ask instructions require answering the question and forbid edits, orch artifacts, and worktrees', async () => {
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: 'answer' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('how does triage work?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    const { instructions } = MockAgentClass.instances[0];
    assert.match(instructions, /answer/i);
    assert.match(instructions, /do not edit|not edit|no edits|read-?only/i);
    assert.match(instructions, /orch|\.orch/i);
    assert.match(instructions, /worktree/i);
  });

  it('prints the ask agent result to stdout on success', async () => {
    const reply = 'The pipeline starts in runPipeline after CLI parse.';
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: reply },
    });

    const logs = [];
    const logSpy = mock.method(console, 'log', (...args) => {
      logs.push(args.map(String).join(' '));
    });
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('how does the pipeline start?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(
      logs.some((line) => line.includes(reply)),
      `expected stdout logs to include ask result; got: ${JSON.stringify(logs)}`,
    );
  });

  it('exits 1 and creates no artifacts when the ask agent fails', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { ask: { ok: false, result: 'agent crashed' } },
      { order },
    );
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('explain the slugger', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['ask']);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });

  it('--ask --dry-run only checks PATH and never constructs an ask agent', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { ask: { ok: true, result: 'should not run' } },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('noop', {
        agent: 'claude',
        ask: true,
        dryRun: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(),
        createWorktree: mock.fn(),
        commitWorktree: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, []);
    assert.equal(MockAgentClass.instances.length, 0);
  });

  it('without ask, triage still runs before quick-fix (regression)', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { triage: SIMPLE_TRIAGE, 'quick-fix': { ok: true, result: 'fixed' } },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        ask: false,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(),
        createWorktree: mock.fn(),
        commitWorktree: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage', 'quick-fix']);
  });

  it('patches phase:"ask" before running and terminal state:"done"/exitCode:0/finishedAt on success, when a job is active — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-job-');
    try {
      const slug = 'ask-job-0000';
      seedForegroundJob(tmpCwd, slug, 'where is the CLI entrypoint?');
      const MockAgentClass = createMockAgentClass({ ask: { ok: true, result: 'answer' } });
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('where is the CLI entrypoint?', {
          agent: 'claude',
          ask: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.ok(
        patchCalls.some((c) => c.fields.phase === 'ask'),
        `expected a phase:"ask" patch; got ${JSON.stringify(patchCalls)}`,
      );
      for (const call of patchCalls) {
        assert.equal(call.cwd, tmpCwd);
        assert.equal(call.slug, slug);
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'ask');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('on successful --ask with an active job, writes .orch/<slug>/ask.json with slug metadata + user/assistant turns (stripped content, not raw <<<SUMMARY>>>)', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-session-ok-');
    try {
      const slug = 'ask-session-ok-0000';
      const prompt = 'where is the CLI entrypoint?';
      const answer = 'The entrypoint is main.js.';
      const answerSummary = 'Named the CLI entrypoint after reading main.js.';
      seedForegroundJob(tmpCwd, slug, prompt);
      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: withSummary(answer, answerSummary) },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline(prompt, {
          agent: 'claude',
          ask: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      const session = readAskSession(tmpCwd, slug);
      assert.ok(session, 'expected ask.json beside run.json for a successful ask');
      assert.equal(session.slug, slug);
      assert.ok(session.createdAt);
      assert.ok(session.updatedAt);
      assert.equal(session.agent, 'claude');
      assert.equal(session.turns.length, 2);
      assert.equal(session.turns[0].role, 'user');
      assert.equal(session.turns[0].content, prompt);
      assert.equal(session.turns[1].role, 'assistant');
      assert.equal(session.turns[1].content, answer);
      assert.doesNotMatch(session.turns[1].content, /<<<SUMMARY>>>/);
      assert.doesNotMatch(session.turns[1].content, /Named the CLI entrypoint/);

      // Transcript stays in ask.json — run.json keeps lifecycle only.
      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'ask');
      assert.equal(record.state, 'done');
      assert.equal(record.turns, undefined);
      assert.equal('turns' in record, false);

      assert.equal(
        fs.existsSync(askSessionPaths(tmpCwd, slug).askJsonPath),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(jobPaths(tmpCwd, slug).dir, 'ask.json')),
        true,
        'ask.json must live under the same slug dir as run.json',
      );
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('failed --ask does not invent a successful assistant turn in ask.json (absent or unchanged, no fake answer)', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-session-fail-');
    try {
      const slug = 'ask-session-fail-0000';
      seedForegroundJob(tmpCwd, slug, 'explain the slugger');
      const MockAgentClass = createMockAgentClass({
        ask: { ok: false, result: 'agent crashed' },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('explain the slugger', {
          agent: 'claude',
          ask: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      const session = readAskSession(tmpCwd, slug);
      // Prefer leaving ask.json absent on a failed first ask. If a later
      // implementation records only the user turn, it must still not invent
      // a successful assistant answer from the failure payload.
      if (session == null) {
        assert.equal(fs.existsSync(askSessionPaths(tmpCwd, slug).askJsonPath), false);
      } else {
        const assistantTurns = session.turns.filter((t) => t.role === 'assistant');
        assert.equal(
          assistantTurns.length,
          0,
          'failed ask must not invent an assistant turn',
        );
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      assert.equal(record.exitCode, 1);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('successful --ask with no active job (jobSlug unset) does not write ask.json', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-session-nojobj-');
    try {
      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: 'answer' },
      });
      const prevJobSlug = process.env.ORCH_JOB_SLUG;
      delete process.env.ORCH_JOB_SLUG;

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('where is the CLI entrypoint?', {
          agent: 'claude',
          ask: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          patchJob: mock.fn(),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
        if (prevJobSlug === undefined) delete process.env.ORCH_JOB_SLUG;
        else process.env.ORCH_JOB_SLUG = prevJobSlug;
      }

      const orchDir = path.join(tmpCwd, '.orch');
      if (fs.existsSync(orchDir)) {
        for (const slug of fs.readdirSync(orchDir)) {
          assert.equal(
            readAskSession(tmpCwd, slug),
            null,
            `no-job ask must not create ask.json under ${slug}`,
          );
        }
      }
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('patches state:"failed"/exitCode:1/finishedAt when the ask agent fails, when a job is active — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-job-fail-');
    try {
      const slug = 'ask-job-fail-0000';
      seedForegroundJob(tmpCwd, slug, 'explain the slugger');
      const MockAgentClass = createMockAgentClass({ ask: { ok: false, result: 'agent crashed' } });
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('explain the slugger', {
          agent: 'claude',
          ask: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.ok(patchCalls.some((c) => c.fields.phase === 'ask'));

      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'ask');
      assert.equal(record.state, 'failed');
      assert.equal(record.exitCode, 1);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('never calls patchJob for --ask when no job is active (jobSlug unset) — existing no-job behavior is unchanged', async () => {
    const MockAgentClass = createMockAgentClass({ ask: { ok: true, result: 'answer' } });
    const patchJobMock = mock.fn();
    const prevJobSlug = process.env.ORCH_JOB_SLUG;
    delete process.env.ORCH_JOB_SLUG;

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where is the CLI entrypoint?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
        patchJob: patchJobMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
      if (prevJobSlug === undefined) delete process.env.ORCH_JOB_SLUG;
      else process.env.ORCH_JOB_SLUG = prevJobSlug;
    }

    assert.equal(patchJobMock.mock.calls.length, 0);
  });
});

/**
 * Unit 02-ask-continue-cli: `orch --ask --from <slug>` multiturn via the same
 * ask session (`.orch/<slug>/ask.json`). Distinct from write-pipeline
 * `orch continue` (which rejects `--ask`).
 *
 * `runPipeline(followUp, { ask: true, fromSlug, jobSlug: fromSlug, ... })`
 * loads prior turns with `readAskSession`, folds a short transcript into the
 * ask-agent prompt, keeps the agent read-only, and on success calls
 * `recordAskExchange` with the follow-up string only (never the
 * context-augmented blob). Missing/unknown sessions exit 1; failed asks leave
 * ask.json unchanged.
 */
describe('runPipeline --ask --from (ask-session continue)', () => {
  function seedAskSessionDoc(tmpCwd, slug, overrides = {}) {
    const now = '2026-08-05T10:00:00.000Z';
    const session = {
      slug,
      createdAt: now,
      updatedAt: now,
      agent: 'claude',
      turns: [
        { role: 'user', content: 'where is the CLI entrypoint?', at: now },
        { role: 'assistant', content: 'The entrypoint is main.js.', at: now },
      ],
      ...overrides,
    };
    writeAskSession(tmpCwd, slug, session);
    return session;
  }

  it('with fromSlug: prepends prior ask.json turns into the ask agent prompt, keeps readOnly, and appends only the follow-up Q&A on success', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-ok-');
    try {
      const slug = 'ask-from-ok-0000';
      const followUp = 'what about triage?';
      const answer = 'Triage lives in the triage agent stage.';
      const prior = seedAskSessionDoc(tmpCwd, slug);
      seedForegroundJob(tmpCwd, slug, prior.turns[0].content);

      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: withSummary(answer, 'Named the triage stage.') },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline(followUp, {
          agent: 'claude',
          ask: true,
          fromSlug: slug,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(exitSpy.mock.calls.length, 0);
      assert.equal(MockAgentClass.instances.length, 1);
      const askAgent = MockAgentClass.instances[0];
      assert.equal(askAgent.name, 'ask');
      assert.equal(askAgent.options?.readOnly, true);
      // Ask agent cwd is the invocation cwd (same as plain --ask); jobCwd is for ask.json I/O.
      assert.equal(askAgent.options?.cwd, process.cwd());

      // Prior transcript + follow-up are folded into the agent prompt string.
      assert.match(askAgent.prompt, /where is the CLI entrypoint/);
      assert.match(askAgent.prompt, /The entrypoint is main\.js/);
      assert.match(askAgent.prompt, /what about triage/);
      assert.match(askAgent.prompt, /user|assistant/i);

      const session = readAskSession(tmpCwd, slug);
      assert.ok(session);
      assert.equal(session.turns.length, 4);
      assert.deepEqual(
        session.turns.map((t) => ({ role: t.role, content: t.content })),
        [
          { role: 'user', content: 'where is the CLI entrypoint?' },
          { role: 'assistant', content: 'The entrypoint is main.js.' },
          { role: 'user', content: followUp },
          { role: 'assistant', content: answer },
        ],
      );
      // Stored user turn must be the follow-up only — never the context blob.
      assert.equal(session.turns[2].content, followUp);
      assert.doesNotMatch(session.turns[2].content, /The entrypoint is main\.js/);
      assert.doesNotMatch(session.turns[3].content, /<<<SUMMARY>>>/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with fromSlug: options.agent (CLI) wins over mismatched session.agent for the run and recordAskExchange', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-agent-cli-');
    try {
      const slug = 'ask-from-agent-cli-0000';
      const followUp = 'prefer the CLI agent';
      const answer = 'ran with claude, not session agn';
      seedAskSessionDoc(tmpCwd, slug, { agent: 'agn' });
      seedForegroundJob(tmpCwd, slug, 'prior');

      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: withSummary(answer, 'CLI agent preferred.') },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline(followUp, {
          agent: 'claude',
          ask: true,
          fromSlug: slug,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(exitSpy.mock.calls.length, 0);
      const printed = logSpy.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
      assert.match(printed, /agent:\s+claude/);
      assert.doesNotMatch(printed, /agent:\s+agn/);

      const session = readAskSession(tmpCwd, slug);
      assert.equal(
        session.agent,
        'claude',
        'recordAskExchange must store options.agent, not the prior session.agent',
      );
      assert.equal(session.turns[2].content, followUp);
      assert.equal(session.turns[3].content, answer);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with fromSlug: failed ask leaves ask.json unchanged (no invented assistant turn)', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-fail-');
    try {
      const slug = 'ask-from-fail-0000';
      const prior = seedAskSessionDoc(tmpCwd, slug);
      seedForegroundJob(tmpCwd, slug, prior.turns[0].content);
      const before = readAskSession(tmpCwd, slug);

      const MockAgentClass = createMockAgentClass({
        ask: { ok: false, result: 'agent crashed' },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('and how does planner work?', {
          agent: 'claude',
          ask: true,
          fromSlug: slug,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      assert.deepEqual(readAskSession(tmpCwd, slug), before);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with fromSlug: missing ask session exits 1 and never constructs an ask agent', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-miss-');
    try {
      const slug = 'ask-from-miss-0000';
      seedForegroundJob(tmpCwd, slug, 'unused');
      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: 'should not run' },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('follow-up', {
          agent: 'claude',
          ask: true,
          fromSlug: slug,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(MockAgentClass.instances.length, 0);
      assert.equal(exitSpy.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      const errText = errorSpy.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
      assert.match(errText, /ask\.json|unknown|no ask|session|not found/i);
      assert.equal(readAskSession(tmpCwd, slug), null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with fromSlug: malformed ask.json fails clearly without inventing turns', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-badjson-');
    try {
      const slug = 'ask-from-badjson-0000';
      seedForegroundJob(tmpCwd, slug, 'unused');
      const { dir, askJsonPath } = askSessionPaths(tmpCwd, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(askJsonPath, '{ not valid json');

      const MockAgentClass = createMockAgentClass({
        ask: { ok: true, result: 'should not run' },
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('follow-up', {
          agent: 'claude',
          ask: true,
          fromSlug: slug,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(MockAgentClass.instances.length, 0);
      assert.ok(
        exitSpy.mock.calls.length >= 1 || errorSpy.mock.calls.length >= 1,
        'malformed ask.json must surface as a failure',
      );
      if (exitSpy.mock.calls.length >= 1) {
        assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      }
      assert.equal(fs.readFileSync(askJsonPath, 'utf8'), '{ not valid json');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('without fromSlug, plain --ask still sends the raw prompt (regression)', async () => {
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: 'answer' },
    });
    const prompt = 'where is the CLI entrypoint?';

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline(prompt, {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.equal(MockAgentClass.instances[0].prompt, prompt);
  });
});

describe('CLI --ask --from gates', () => {
  it('rejects --ask --from with an empty follow-up prompt', async () => {
    const tmpCwd = makeTmpCwd('orch-ask-from-empty-');
    try {
      const slug = 'ask-from-empty-0000';
      writeAskSession(tmpCwd, slug, {
        slug,
        createdAt: '2026-08-05T10:00:00.000Z',
        updatedAt: '2026-08-05T10:00:00.000Z',
        agent: 'claude',
        turns: [
          { role: 'user', content: 'q1', at: '2026-08-05T10:00:00.000Z' },
          { role: 'assistant', content: 'a1', at: '2026-08-05T10:00:00.000Z' },
        ],
      });
      const { code, stderr } = await runCli(
        ['--ask', '--from', slug, '--agent', 'claude'],
        { cwd: tmpCwd },
      );
      assert.notEqual(code, 0);
      assert.match(stderr + '', /missing required argument|task cannot be empty|follow-?up|prompt/i);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  for (const conflicting of ['--detach', '--seq', '--fan-out']) {
    it(`rejects --ask --from combined with ${conflicting}`, async () => {
      const tmpCwd = makeTmpCwd('orch-ask-from-conflict-');
      try {
        const slug = 'ask-from-conflict-0000';
        writeAskSession(tmpCwd, slug, {
          slug,
          createdAt: '2026-08-05T10:00:00.000Z',
          updatedAt: '2026-08-05T10:00:00.000Z',
          agent: 'claude',
          turns: [],
        });
        const { code, stderr } = await runCli(
          ['follow-up', '--ask', '--from', slug, conflicting, '--agent', 'claude'],
          { cwd: tmpCwd },
        );
        assert.notEqual(code, 0);
        assert.match(stderr + '', /cannot be combined|Error:/i);
      } finally {
        fs.rmSync(tmpCwd, { recursive: true, force: true });
      }
    });
  }
});

describe('runPipeline --quick (skip triage → quick-fix)', () => {
  it('spawns only a quick-fix agent — never triage, ask, research, or implementers', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { 'quick-fix': { ok: true, result: 'fixed' } },
      { order },
    );
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('fix the typo in the README', {
        agent: 'claude',
        quick: true,
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['quick-fix']);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });

  it('constructs the quick-fix agent with cwd === invocationCwd and no fix_plan', async () => {
    const invocationCwd = process.cwd();
    const MockAgentClass = createMockAgentClass({
      'quick-fix': { ok: true, result: 'fixed' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'cursor',
        quick: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(invocationCwd)),
        createWorktree: mock.fn(() => fakeWorktree(invocationCwd)),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.equal(MockAgentClass.instances.length, 1);
    const quickFixAgent = MockAgentClass.instances[0];
    assert.equal(quickFixAgent.name, 'quick-fix');
    assert.equal(quickFixAgent.options?.cwd, invocationCwd);
    assert.doesNotMatch(quickFixAgent.instructions, /\[Triage Fix Plan\]/);
  });

  it('exits 1 and creates no artifacts when the quick-fix agent fails', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { 'quick-fix': { ok: false, result: 'agent crashed' } },
      { order },
    );
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        quick: true,
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, ['quick-fix']);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });

  it('--quick --dry-run only checks PATH and never constructs a quick-fix agent', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { 'quick-fix': { ok: true, result: 'should not run' } },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('noop', {
        agent: 'claude',
        quick: true,
        dryRun: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(),
        createWorktree: mock.fn(),
        commitWorktree: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(order, []);
    assert.equal(MockAgentClass.instances.length, 0);
  });

  it('without --quick, triage still runs before quick-fix (regression)', async () => {
    const order = [];
    const MockAgentClass = createMockAgentClass(
      { triage: SIMPLE_TRIAGE, 'quick-fix': { ok: true, result: 'fixed' } },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        quick: false,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(),
        createWorktree: mock.fn(),
        commitWorktree: mock.fn(),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage', 'quick-fix']);
  });

  it('patches phase:"quick-fix" before running and terminal state:"done"/exitCode:0/finishedAt on success, when a job is active — and still creates no run context/worktree/commit — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-quick-job-');
    try {
      const slug = 'quick-job-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo in the README');
      const createRunContextMock = mock.fn(() => fakeRunContext(tmpCwd));
      const createWorktreeMock = mock.fn(() => fakeWorktree(tmpCwd));
      const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));
      const MockAgentClass = createMockAgentClass({ 'quick-fix': { ok: true, result: 'fixed' } });
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('fix the typo in the README', {
          agent: 'claude',
          quick: true,
          AgentClass: MockAgentClass,
          createRunContext: createRunContextMock,
          createWorktree: createWorktreeMock,
          commitWorktree: commitWorktreeMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      // Job-record writes are additive — quick-fix still gets no run context,
      // worktree, or commit of its own.
      assert.equal(createRunContextMock.mock.calls.length, 0);
      assert.equal(createWorktreeMock.mock.calls.length, 0);
      assert.equal(commitWorktreeMock.mock.calls.length, 0);

      assert.ok(
        patchCalls.some((c) => c.fields.phase === 'quick-fix'),
        `expected a phase:"quick-fix" patch; got ${JSON.stringify(patchCalls)}`,
      );
      for (const call of patchCalls) {
        assert.equal(call.cwd, tmpCwd);
        assert.equal(call.slug, slug);
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'quick-fix');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
      assert.equal(record.branch, null);
      assert.equal(record.worktree, null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('patches state:"failed"/exitCode:1/finishedAt when the quick-fix agent fails, when a job is active — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-quick-job-fail-');
    try {
      const slug = 'quick-job-fail-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo');
      const MockAgentClass = createMockAgentClass({ 'quick-fix': { ok: false, result: 'agent crashed' } });
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('fix the typo', {
          agent: 'claude',
          quick: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => fakeRunContext(tmpCwd)),
          createWorktree: mock.fn(() => fakeWorktree(tmpCwd)),
          commitWorktree: mock.fn(() => fakeCommitResult('orch/stub-stub-0000')),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.ok(patchCalls.some((c) => c.fields.phase === 'quick-fix'));

      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'quick-fix');
      assert.equal(record.state, 'failed');
      assert.equal(record.exitCode, 1);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('never calls patchJob for --quick when no job is active (jobSlug unset)', async () => {
    const createRunContextMock = mock.fn(() => fakeRunContext(process.cwd()));
    const createWorktreeMock = mock.fn(() => fakeWorktree(process.cwd()));
    const commitWorktreeMock = mock.fn(() => fakeCommitResult('orch/stub-stub-0000'));
    const MockAgentClass = createMockAgentClass({ 'quick-fix': { ok: true, result: 'fixed' } });
    const patchJobMock = mock.fn();
    const prevJobSlug = process.env.ORCH_JOB_SLUG;
    delete process.env.ORCH_JOB_SLUG;

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('fix the typo in the README', {
        agent: 'claude',
        quick: true,
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
        commitWorktree: commitWorktreeMock,
        patchJob: patchJobMock,
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
      if (prevJobSlug === undefined) delete process.env.ORCH_JOB_SLUG;
      else process.env.ORCH_JOB_SLUG = prevJobSlug;
    }

    assert.equal(patchJobMock.mock.calls.length, 0);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(commitWorktreeMock.mock.calls.length, 0);
  });
});

describe('runPipeline per-stage summary output (<<<SUMMARY>>> paragraphs)', () => {
  /** Spy on console.log, returning the captured lines and a restore fn. */
  function collectLogs() {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.map(String).join(' ')));
    return { logs, restore: () => restore.mock.restore() };
  }

  it('--ask prints an "ask" summary block and the exact stripped answer, never leaking the raw delimiter', async () => {
    const answer = 'The entrypoint is main.js.';
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: withSummary(answer, ASK_SUMMARY) },
    });

    const { logs, restore } = collectLogs();
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where is the CLI entrypoint?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    const joined = logs.join('\n');
    assert.doesNotMatch(joined, /<<<SUMMARY>>>/);
    assert.ok(
      logs.some((line) => line.trim() === answer),
      `expected the exact stripped answer among logs; got: ${JSON.stringify(logs)}`,
    );
    assert.match(joined, stageSummaryBlockRegex('ask', ASK_SUMMARY));
  });

  it('--ask with a canned result that omits the delimiter still prints a fallback ask summary box', async () => {
    const answer = 'The entrypoint is main.js.';
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: answer },
    });

    const { logs, restore } = collectLogs();
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where is the CLI entrypoint?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    const joined = logs.join('\n');
    assert.ok(
      logs.some((line) => line.trim() === answer),
      `expected the (unchanged) full answer among logs; got: ${JSON.stringify(logs)}`,
    );
    assert.doesNotMatch(joined, /<<<SUMMARY>>>/);
    assert.match(joined, stageSummaryBlockRegex('ask', answer));
  });

  it('quick-fix path prints [triage] and [quick-fix] summary blocks and still routes off the stripped JSON', async () => {
    const MockAgentClass = createMockAgentClass({
      triage: SIMPLE_TRIAGE,
      'quick-fix': { ok: true, result: withSummary('fixed the typo', QUICK_FIX_SUMMARY) },
    });

    const { logs, restore } = collectLogs();
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub-stub-0000')),
      });
    } finally {
      restore();
    }

    assert.deepEqual(MockAgentClass.instances.map((i) => agentRole(i.name)), ['triage', 'quick-fix']);
    const joined = logs.join('\n');
    assert.match(joined, stageSummaryBlockRegex('triage', SIMPLE_TRIAGE_SUMMARY));
    assert.match(joined, stageSummaryBlockRegex('quick-fix', QUICK_FIX_SUMMARY));
    assert.doesNotMatch(joined, /<<<SUMMARY>>>/);
  });

  it('complex path prints a distinct summary block per stage, using roundLabel for looped stages', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    const behaviors = complexPassBehaviors({
      research: { ok: true, result: withSummary(runContext.researchPath, RESEARCH_SUMMARY) },
      planner: { ok: true, result: withSummary(runContext.taskPath, PLANNER_SUMMARY) },
    });
    const MockAgentClass = createMockAgentClass(behaviors);

    const { logs, restore } = collectLogs();
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      restore();
    }

    const joined = logs.join('\n');
    const expectations = [
      ['triage', TRIAGE_SUMMARY],
      ['research', RESEARCH_SUMMARY],
      ['planner', PLANNER_SUMMARY],
      ['test-writer 1/5', TEST_WRITER_SUMMARY],
      ['test-critic 1/5', TEST_CRITIC_SUMMARY],
      ['code-writer 1/5', CODE_WRITER_SUMMARY],
      ['test-runner 1/5', TEST_RUNNER_SUMMARY],
    ];
    for (const [label, summary] of expectations) {
      assert.match(
        joined,
        stageSummaryBlockRegex(label, summary),
        `expected a summary block for ${label}; got logs: ${JSON.stringify(logs)}`,
      );
    }
    assert.doesNotMatch(joined, /<<<SUMMARY>>>/);
  });

  it('strips the summary before forwarding content downstream (research→planner, test-writer→test-critic, code-writer→test-runner)', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    const testWriterContent = 'npm test\ntest/main.test.js';
    const codeWriterContent = 'moved factories under agents/';

    const behaviors = complexPassBehaviors({
      research: { ok: true, result: withSummary(runContext.researchPath, RESEARCH_SUMMARY) },
      planner: { ok: true, result: withSummary(runContext.taskPath, PLANNER_SUMMARY) },
      'test-writer': { ok: true, result: withSummary(testWriterContent, TEST_WRITER_SUMMARY) },
      'code-writer': { ok: true, result: withSummary(codeWriterContent, CODE_WRITER_SUMMARY) },
    });
    const MockAgentClass = createMockAgentClass(behaviors);

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      logSpy.mock.restore();
    }

    const byRole = Object.fromEntries(MockAgentClass.instances.map((i) => [agentRole(i.name), i]));

    // Planner must receive the exact research path, never the raw delimiter or
    // the research stage's summary paragraph (footer marker in instructions is fine).
    const plannerPrompt = `${byRole.planner.instructions}\n${byRole.planner.prompt}`;
    assert.ok(plannerPrompt.includes(runContext.researchPath));
    assert.doesNotMatch(byRole.planner.prompt, /<<<SUMMARY>>>/);
    assert.doesNotMatch(plannerPrompt, new RegExp(escapeRegex(RESEARCH_SUMMARY)));
    const researchBlock = byRole.planner.instructions.match(
      /\[Research Agent Output\]([\s\S]*?)\[\/Research Agent Output\]/,
    )?.[1] ?? '';
    assert.doesNotMatch(researchBlock, /<<<SUMMARY>>>/);

    // test-critic must receive the exact test-writer content, not its summary paragraph.
    const criticPrompt = `${byRole['test-critic'].instructions}\n${byRole['test-critic'].prompt}`;
    assert.ok(criticPrompt.includes(testWriterContent));
    assert.doesNotMatch(byRole['test-critic'].prompt, /<<<SUMMARY>>>/);
    assert.doesNotMatch(criticPrompt, new RegExp(escapeRegex(TEST_WRITER_SUMMARY)));
    const writerBlock = byRole['test-critic'].instructions.match(
      /\[Test Writer Output\]([\s\S]*?)\[\/Test Writer Output\]/,
    )?.[1] ?? '';
    assert.doesNotMatch(writerBlock, /<<<SUMMARY>>>/);

    // test-runner must receive the exact code-writer content, not its summary paragraph.
    const runnerPrompt = `${byRole['test-runner'].instructions}\n${byRole['test-runner'].prompt}`;
    assert.ok(runnerPrompt.includes(codeWriterContent));
    assert.doesNotMatch(byRole['test-runner'].prompt, /<<<SUMMARY>>>/);
    assert.doesNotMatch(runnerPrompt, new RegExp(escapeRegex(CODE_WRITER_SUMMARY)));
    const codeBlock = byRole['test-runner'].instructions.match(
      /\[Code Writer Output\]([\s\S]*?)\[\/Code Writer Output\]/,
    )?.[1] ?? '';
    assert.doesNotMatch(codeBlock, /<<<SUMMARY>>>/);
  });

  it('parseTriageJson/parseVerdict still parse correctly and status.md is unaffected by the appended summary block', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-summary-status-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));

      const logSpy = mock.method(console, 'log', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: commitWorktreeMock,
        });
      } finally {
        logSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(exitSpy.mock.calls.length, 0);
      assert.equal(commitWorktreeMock.mock.calls.length, 1);

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Test loop/);
      assert.match(status, /Result:\s*passed/i);
      assert.match(status, /## Code loop/);
      assert.match(status, /## Commit/);
      // The JSON verdict's own "summary" field (a short, unrelated string) must
      // still show up unmangled by the appended paragraph delimiter/text.
      assert.match(status, /Summary:\s*tests adequate/);
      assert.match(status, /Summary:\s*suite green/);
      assert.doesNotMatch(status, /<<<SUMMARY>>>/);
      assert.doesNotMatch(status, new RegExp(escapeRegex(TEST_CRITIC_SUMMARY)));
      assert.doesNotMatch(status, new RegExp(escapeRegex(TEST_RUNNER_SUMMARY)));
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('a canned result that omits the delimiter mid-pipeline still prints a fallback summary box for that stage', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    // research/planner deliberately omit the delimiter; every other stage keeps it.
    const researchContent = 'research-output-no-summary';
    const plannerContent = 'planner-output-no-summary';
    const behaviors = complexPassBehaviors({
      research: { ok: true, result: researchContent },
      planner: { ok: true, result: plannerContent },
    });
    const MockAgentClass = createMockAgentClass(behaviors);

    const { logs, restore } = collectLogs();
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
      });
    } finally {
      restore();
    }

    const joined = logs.join('\n');
    assert.match(joined, stageSummaryBlockRegex('research', researchContent));
    assert.match(joined, stageSummaryBlockRegex('planner', plannerContent));
    assert.doesNotMatch(joined, /<<<SUMMARY>>>/);
    // Other stages, which still include the delimiter, keep printing normally.
    assert.match(joined, stageSummaryBlockRegex('triage', TRIAGE_SUMMARY));
    assert.match(joined, stageSummaryBlockRegex('test-writer 1/5', TEST_WRITER_SUMMARY));

    // Fallback is print-only — forwarded research content must not gain an invented delimiter.
    const byRole = Object.fromEntries(MockAgentClass.instances.map((i) => [agentRole(i.name), i]));
    assert.ok(byRole.planner.instructions.includes(researchContent));
    const researchBlock = byRole.planner.instructions.match(
      /\[Research Agent Output\]([\s\S]*?)\[\/Research Agent Output\]/,
    )?.[1] ?? '';
    assert.doesNotMatch(researchBlock, /<<<SUMMARY>>>/);
    assert.ok(researchBlock.includes(researchContent));
  });

  it('--ask with empty content and no delimiter still prints no summary block', async () => {
    const MockAgentClass = createMockAgentClass({
      ask: { ok: true, result: '' },
    });

    const { logs, restore } = collectLogs();
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where is the CLI entrypoint?', {
        agent: 'claude',
        ask: true,
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(() => fakeCommitResult('orch/stub')),
      });
    } finally {
      restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.ok(
      !logs.some((line) => line.includes('•')),
      `expected no summary block when content is empty; got: ${JSON.stringify(logs)}`,
    );
  });
});

describe('runPipeline file-change trails (writers + commit rollup)', () => {
  function collectLogs() {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.map(String).join(' ')));
    return { logs, restore: () => restore.mock.restore() };
  }

  it('wires fileTracker only onto test-writer and code-writer constructions', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        collectWorktreeChanges: mock.fn(() => null),
      });
    } finally {
      logSpy.mock.restore();
    }

    const byRole = Object.fromEntries(
      MockAgentClass.instances.map((i) => [agentRole(i.name), i]),
    );

    assert.ok(byRole['test-writer'].options?.fileTracker, 'test-writer should receive fileTracker');
    assert.ok(byRole['code-writer'].options?.fileTracker, 'code-writer should receive fileTracker');

    for (const role of ['triage', 'research', 'planner', 'test-critic', 'test-runner']) {
      assert.equal(
        byRole[role].options?.fileTracker,
        undefined,
        `${role} must not receive fileTracker`,
      );
      assert.equal(
        byRole[role].options?.onFileChange,
        undefined,
        `${role} must not receive onFileChange`,
      );
    }
  });

  it('prints Files (N) under writer summaries and never under critic/runner summaries', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors());

    const { logs, restore } = collectLogs();
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        collectWorktreeChanges: mock.fn(() => null),
      });
    } finally {
      restore();
    }

    const joined = logs.join('\n');
    assert.match(joined, / test-writer 1\/5 [\s\S]*?Files \(1\)[\s\S]*?\+ test\/example\.test\.js/);
    assert.match(joined, / code-writer 1\/5 [\s\S]*?Files \(1\)[\s\S]*?\+ lib\/example\.js/);

    // Critic/runner blocks keep their prose bullet and must not grow a Files section.
    assert.match(joined, stageSummaryBlockRegex('test-critic 1/5', TEST_CRITIC_SUMMARY));
    assert.match(joined, stageSummaryBlockRegex('test-runner 1/5', TEST_RUNNER_SUMMARY));
    assert.doesNotMatch(
      joined,
      / test-critic 1\/5 \n─+\n(?: {2}• .+\n)* {2}Files \(/,
    );
    assert.doesNotMatch(
      joined,
      / test-runner 1\/5 \n─+\n(?: {2}• .+\n)* {2}Files \(/,
    );
  });

  it('prints the files changed rollup before the commit line when the tree is dirty', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors());

    const collectWorktreeChangesMock = mock.fn(() => ({
      files: [
        { status: 'A', path: 'lib/file-tracker.js' },
        { status: 'M', path: 'lib/agent.js' },
      ],
      shortstat: '2 files changed, 40 insertions(+), 3 deletions(-)',
    }));

    const { logs, restore } = collectLogs();
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        collectWorktreeChanges: collectWorktreeChangesMock,
      });
    } finally {
      restore();
    }

    assert.equal(collectWorktreeChangesMock.mock.calls.length, 1);
    assert.equal(
      collectWorktreeChangesMock.mock.calls[0].arguments[0].worktreePath,
      worktree.worktreePath,
    );

    const joined = logs.join('\n');
    assert.match(joined, / files changed /);
    assert.match(joined, /A {2}lib\/file-tracker\.js/);
    assert.match(joined, /M {2}lib\/agent\.js/);
    assert.match(joined, /2 files changed, 40 insertions\(\+\), 3 deletions\(-\)/);
    assert.match(joined, /commit: deadbee on /);

    const rollupIdx = joined.indexOf(' files changed ');
    const commitIdx = joined.indexOf('commit: deadbee');
    assert.ok(rollupIdx >= 0 && commitIdx > rollupIdx, 'rollup must print before commit:');
  });

  it('skips the files changed rollup on a clean tree and keeps commit: no changes', async () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rollup-clean-'));
    try {
      const runContext = fakeRunContext(tmpCwd);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const collectWorktreeChangesMock = mock.fn(() => null);

      const { logs, restore } = collectLogs();
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => ({ committed: false, sha: null, branch: worktree.branch })),
          collectWorktreeChanges: collectWorktreeChangesMock,
        });
      } finally {
        restore();
        exitSpy.mock.restore();
      }

      assert.equal(collectWorktreeChangesMock.mock.calls.length, 1);
      const joined = logs.join('\n');
      assert.doesNotMatch(joined, / files changed /);
      assert.match(joined, new RegExp(`commit: no changes on ${escapeRegex(worktree.branch)}`));
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('does not wire fileTracker on the ask path but does on the quick-fix path', async () => {
    const askMock = createMockAgentClass({
      ask: { ok: true, result: withSummary('answer', ASK_SUMMARY) },
    });
    const quickMock = createMockAgentClass({
      triage: SIMPLE_TRIAGE,
      'quick-fix': { ok: true, result: withSummary('fixed', QUICK_FIX_SUMMARY) },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('where?', {
        agent: 'claude',
        ask: true,
        AgentClass: askMock,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(),
        collectWorktreeChanges: mock.fn(() => {
          throw new Error('rollup must not run on ask');
        }),
      });
      await runPipeline('fix typo', {
        agent: 'claude',
        AgentClass: quickMock,
        createRunContext: mock.fn(() => fakeRunContext(process.cwd())),
        createWorktree: mock.fn(() => fakeWorktree(process.cwd())),
        commitWorktree: mock.fn(),
        collectWorktreeChanges: mock.fn(() => {
          throw new Error('rollup must not run on quick-fix');
        }),
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    for (const agent of askMock.instances) {
      assert.equal(agent.options?.fileTracker, undefined);
    }
    const quickFixInstance = quickMock.instances.find((i) => agentRole(i.name) === 'quick-fix');
    assert.ok(quickFixInstance.options?.fileTracker, 'quick-fix should receive fileTracker');
  });
});

/**
 * Contract this section pins down: job records are now universal, not just
 * for `--detach`. Once `main.js`'s Commander action allocates a job (via the
 * shared `allocateJob` helper) for every non-detached invocation — plain
 * pipeline included — and passes the slug through as `options.jobSlug`,
 * `runPipeline`'s existing `jobPatch` (already exercised for the detached
 * child in test/headless.test.js) stops being a no-op for foreground runs
 * too. These tests exercise that same `jobSlug`/`jobCwd`/`patchJob` seam
 * directly against the plain/full pipeline, mirroring the --ask/--quick
 * coverage above.
 */
describe('runPipeline job-record patching for the plain/full pipeline (universal job records, not just --detach)', () => {
  it('patches phase through triage → research → plan → worktree → test-loop → code-loop → commit, then terminal state:"done", when a job is active — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-full-pipeline-job-');
    try {
      const slug = 'full-pipeline-job-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      const phases = patchCalls.filter((c) => c.fields.phase).map((c) => c.fields.phase);
      assert.deepEqual(
        phases,
        ['triage', 'research', 'plan', 'worktree', 'test-loop', 'test-loop', 'code-loop', 'code-loop', 'commit'],
      );

      const worktreePatch = patchCalls.find((c) => c.fields.branch);
      assert.equal(worktreePatch.fields.branch, worktree.branch);
      assert.equal(worktreePatch.fields.worktree, worktree.worktreePath);

      for (const call of patchCalls) {
        assert.equal(call.cwd, tmpCwd);
        assert.equal(call.slug, slug);
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
      assert.equal(record.branch, worktree.branch);
      assert.equal(record.worktree, worktree.worktreePath);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('routes to quick-fix and still patches phase:"quick-fix"/terminal state through the full-pipeline entrypoint when triage judges the task simple — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-full-pipeline-quickfix-');
    try {
      const slug = 'full-pipeline-quickfix-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo');
      const MockAgentClass = createMockAgentClass({
        triage: SIMPLE_TRIAGE,
        'quick-fix': { ok: true, result: 'fixed' },
      });
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('fix the typo', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => { throw new Error('createRunContext must not be called on the quick-fix route'); }),
          createWorktree: mock.fn(() => { throw new Error('createWorktree must not be called on the quick-fix route'); }),
          commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called on the quick-fix route'); }),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.ok(patchCalls.some((c) => c.fields.phase === 'triage'));
      assert.ok(patchCalls.some((c) => c.fields.phase === 'quick-fix'));

      const record = readJob(tmpCwd, slug);
      assert.equal(record.phase, 'quick-fix');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('patches state:"failed"/exitCode:1/finishedAt when a stage throws, when a job is active — verified via a real run.json on disk', async () => {
    const tmpCwd = makeTmpCwd('orch-full-pipeline-fail-');
    try {
      const slug = 'full-pipeline-fail-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors({
        'code-writer': { ok: false, result: 'implementation failed' },
      }));
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      assert.equal(record.exitCode, 1);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('never calls patchJob for the plain pipeline when no job is active (jobSlug unset) — regression guard', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass(complexPassBehaviors());
    const patchJobMock = mock.fn();
    const prevJobSlug = process.env.ORCH_JOB_SLUG;
    delete process.env.ORCH_JOB_SLUG;

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
        patchJob: patchJobMock,
      });
    } finally {
      logSpy.mock.restore();
      if (prevJobSlug === undefined) delete process.env.ORCH_JOB_SLUG;
      else process.env.ORCH_JOB_SLUG = prevJobSlug;
    }

    assert.equal(patchJobMock.mock.calls.length, 0);
  });
});

/**
 * Contract this section pins down for `lastOutcome` capture (net-new field
 * on every terminal `jobPatch`, see `.spec/continue.md` "lastOutcome
 * (written on every terminal transition)" and
 * `.orch/sunny-oasis-a761/task.md` section 1). It does not exist yet as of
 * this test-writing round.
 *
 * On every terminal `runPipeline` write (`done` or `failed`), the same
 * `patchJob` call (or one immediately following it, still before any
 * `process.exit`) must also include a `lastOutcome` object:
 * `{ state, phase, stage, round, exitCode, finishedAt, task, summary,
 * error }`.
 *   - `state`/`exitCode`/`finishedAt` mirror the terminal fields written
 *     alongside it.
 *   - `phase`/`stage`/`round` mirror the record's live values at that
 *     terminal moment (code-loop/test-runner/<last round> on a code-loop
 *     failure or success; commit/commit/null on a clean `done`).
 *   - `task` is the prompt for this pipeline invocation.
 *   - `summary` is best-effort: on a successful `done`, the final
 *     code-loop verdict's summary (`codeAccepted.verdict.summary`, e.g.
 *     "suite green" for the `PASS_RUNNER` fixture used across this suite).
 *   - `error` points at `failure.log` after a successful flush (unit
 *     01-failure-log); the thrown `Error.message` is preserved in the
 *     failure.log header instead of dumping stage verbose to the terminal.
 *     Omitted/`null` on a clean `done`.
 */
describe('runPipeline lastOutcome capture on terminal states', () => {
  it('writes lastOutcome.state:"done" with the final code-loop verdict summary on a clean success', async () => {
    const tmpCwd = makeTmpCwd('orch-lastoutcome-done-');
    try {
      const slug = 'lastoutcome-done-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
      assert.equal(record.lastOutcome.state, 'done');
      assert.equal(record.lastOutcome.exitCode, 0);
      assert.equal(record.lastOutcome.finishedAt, record.finishedAt);
      assert.equal(record.lastOutcome.task, 'do something complex');
      assert.equal(record.lastOutcome.summary, 'suite green');
      assert.ok(record.lastOutcome.error == null, 'error should be omitted/null on a clean done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('writes lastOutcome.state:"failed" with phase/stage/round and the thrown error message', async () => {
    const tmpCwd = makeTmpCwd('orch-lastoutcome-failed-');
    try {
      const slug = 'lastoutcome-failed-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors({
        'test-runner': { ok: false, result: 'test runner crashed' },
      }));
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called after a failed code loop'); }),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      assert.ok(record.lastOutcome, 'expected a lastOutcome object on the terminal record');
      assert.equal(record.lastOutcome.state, 'failed');
      assert.equal(record.lastOutcome.exitCode, 1);
      assert.equal(record.lastOutcome.phase, 'code-loop');
      assert.equal(record.lastOutcome.stage, 'test-runner');
      assert.equal(record.lastOutcome.task, 'do something complex');
      assert.equal(typeof record.lastOutcome.error, 'string');
      assert.match(
        record.lastOutcome.error,
        /failure\.log/,
        'failed lastOutcome.error should be a pointer to failure.log, not a verbose dump',
      );
      assert.equal(record.failureLogPath, jobPaths(tmpCwd, slug).failureLogPath);
      assert.equal(fs.existsSync(record.failureLogPath), true);
      const failureBody = fs.readFileSync(record.failureLogPath, 'utf8');
      assert.match(failureBody, /=== orch failure ===/);
      assert.match(failureBody, /test-runner/);
      // Durable forensic header keeps the real reason; lastOutcome.error is only a pointer.
      assert.match(
        failureBody,
        /error:\s*test-runner failed; stopping before commit/,
        'failure.log header error: must retain err.message for recover',
      );
      assert.match(failureBody, /task:\s*do something complex/);
      assert.match(failureBody, /finishedAt:\s*\d{4}-\d{2}-\d{2}T/);
      assert.equal(record.lastOutcome.finishedAt, record.finishedAt);
      assert.doesNotMatch(
        record.lastOutcome.error,
        /test-runner failed; stopping before commit/,
        'lastOutcome.error must not duplicate the durable header reason',
      );
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

/**
 * Contract for unit 01-failure-log (.spec/resume.md § Failure log): a
 * pipeline `failed` write without `-v` still flushes `.orch/<slug>/failure.log`
 * (header + stage verbose buffer), sets `run.json.failureLogPath`, prints a
 * one-line pointer (not stage verbose), and appends on a later failure.
 */
describe('runPipeline failure.log persistence without -v', () => {
  function requireBufferApis() {
    assert.equal(typeof agentLib.beginStageCapture, 'function', 'beginStageCapture must be exported');
    assert.equal(typeof agentLib.appendVerbose, 'function', 'appendVerbose must be exported');
    assert.equal(typeof agentLib.setJobSlug, 'function');
    assert.equal(typeof agentLib.resetShutdownState, 'function');
  }

  it('writes failure.log with header + stage verbose and prints a pointer, not verbose, on failed', async () => {
    requireBufferApis();
    const tmpCwd = makeTmpCwd('orch-failure-log-failed-');
    try {
      const slug = 'failure-log-failed-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      agentLib.resetShutdownState();
      if (typeof agentLib.resetFailureLogState === 'function') {
        agentLib.resetFailureLogState();
      }
      agentLib.setJobSlug(slug);

      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);

      // Mock that seeds the stage buffer during the failing test-runner stage.
      const BaseMock = createMockAgentClass(complexPassBehaviors({
        'test-runner': { ok: false, result: 'test runner crashed' },
      }));
      class BufferingMock extends BaseMock {
        async run(opts) {
          if (agentRole(this.name) === 'test-runner') {
            agentLib.beginStageCapture({
              phase: 'code-loop',
              stage: 'test-runner',
              round: 1,
            });
            agentLib.appendVerbose('pipeline-stage-verbose-without-v\n');
          }
          return super.run(opts);
        }
      }

      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);
      const logSpy = mock.method(console, 'log', () => {});
      const errorLines = [];
      const errorSpy = mock.method(console, 'error', (...args) => {
        errorLines.push(args.map(String).join(' '));
      });
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: BufferingMock,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => {
            throw new Error('commitWorktree must not be called after a failed code loop');
          }),
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
          verbose: false,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
        agentLib.resetShutdownState();
      }

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      const expectedPath = jobPaths(tmpCwd, slug).failureLogPath;
      assert.equal(record.failureLogPath, expectedPath);
      assert.equal(fs.existsSync(expectedPath), true);

      const body = fs.readFileSync(expectedPath, 'utf8');
      assert.match(body, /=== orch failure ===/);
      assert.match(body, new RegExp(`slug:\\s*${slug}`));
      assert.match(body, /state:\s*failed/);
      assert.match(body, /phase:\s*code-loop/);
      assert.match(body, /stage:\s*test-runner/);
      assert.match(body, /exitCode:\s*1/);
      assert.match(body, /finishedAt:\s*\d{4}-\d{2}-\d{2}T/);
      assert.match(body, /task:\s*do something complex/);
      // Locked shape: real err.message lives in the header; lastOutcome.error is the pointer.
      assert.match(
        body,
        /error:\s*test-runner failed; stopping before commit/,
        'failure.log header must keep err.message after lastOutcome.error became a pointer',
      );
      assert.match(body, /=== stage verbose/);
      assert.match(body, /pipeline-stage-verbose-without-v/);
      assert.match(body, /test-runner/);

      assert.match(String(record.lastOutcome?.error ?? ''), /failure\.log/);
      assert.doesNotMatch(
        String(record.lastOutcome?.error ?? ''),
        /test-runner failed; stopping before commit/,
      );
      const joinedErrors = errorLines.join('\n');
      assert.match(joinedErrors, /failure\.log/);
      assert.doesNotMatch(joinedErrors, /pipeline-stage-verbose-without-v/);

      const statusText = formatStatus(tmpCwd, record);
      assert.match(statusText, /failure\.log/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('appends a second failure section when the same slug fails again', async () => {
    requireBufferApis();
    const tmpCwd = makeTmpCwd('orch-failure-log-append-');
    try {
      const slug = 'failure-log-append-0000';
      seedForegroundJob(tmpCwd, slug, 'do something complex');
      agentLib.resetShutdownState();
      if (typeof agentLib.resetFailureLogState === 'function') {
        agentLib.resetFailureLogState();
      }
      agentLib.setJobSlug(slug);

      const runContext = fakeRunContext(tmpCwd);
      const worktree = fakeWorktree(tmpCwd);
      const BaseMock = createMockAgentClass(complexPassBehaviors({
        'test-runner': { ok: false, result: 'test runner crashed' },
      }));
      let failGeneration = 0;
      class BufferingMock extends BaseMock {
        async run(opts) {
          if (agentRole(this.name) === 'test-runner') {
            failGeneration += 1;
            agentLib.beginStageCapture({
              phase: 'code-loop',
              stage: 'test-runner',
              round: 1,
            });
            agentLib.appendVerbose(`pipeline-fail-generation-${failGeneration}\n`);
          }
          return super.run(opts);
        }
      }

      const runOnce = async () => {
        const patchCalls = [];
        const patchJobMock = realDiskPatchJobSpy(patchCalls);
        const logSpy = mock.method(console, 'log', () => {});
        const errorSpy = mock.method(console, 'error', () => {});
        const exitSpy = mock.method(process, 'exit', () => {});
        try {
          await runPipeline('do something complex', {
            agent: 'claude',
            AgentClass: BufferingMock,
            createRunContext: mock.fn(() => runContext),
            createWorktree: mock.fn(() => worktree),
            commitWorktree: mock.fn(() => {
              throw new Error('commitWorktree must not be called after a failed code loop');
            }),
            jobSlug: slug,
            jobCwd: tmpCwd,
            patchJob: patchJobMock,
            verbose: false,
          });
        } finally {
          logSpy.mock.restore();
          errorSpy.mock.restore();
          exitSpy.mock.restore();
        }
      };

      await runOnce();
      const failurePath = jobPaths(tmpCwd, slug).failureLogPath;
      assert.equal([...fs.readFileSync(failurePath, 'utf8').matchAll(/=== orch failure ===/g)].length, 1);

      // Simulate resume reopen: clear terminal fields, keep failure.log on disk.
      writeJob(tmpCwd, slug, {
        ...readJob(tmpCwd, slug),
        state: 'running',
        finishedAt: null,
        exitCode: null,
        lastOutcome: null,
        phase: null,
        stage: null,
        round: null,
        pid: process.pid,
      });
      agentLib.resetShutdownState();
      if (typeof agentLib.resetFailureLogState === 'function') {
        agentLib.resetFailureLogState();
      }
      agentLib.setJobSlug(slug);

      await runOnce();

      const body = fs.readFileSync(failurePath, 'utf8');
      assert.equal([...body.matchAll(/=== orch failure ===/g)].length, 2);
      assert.match(body, /pipeline-fail-generation-1/);
      assert.match(body, /pipeline-fail-generation-2/);
    } finally {
      agentLib.resetShutdownState();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('does not write failure.log when jobSlug is absent', async () => {
    const tmpCwd = makeTmpCwd('orch-failure-log-noslug-');
    try {
      const runContext = fakeRunContext(tmpCwd, 'noslug-run-0000');
      // Ensure artifact dir exists the way a real createRunContext would, so
      // the assertion below is specifically about failure.log — not .orch.
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, 'noslug-run-0000');
      const MockAgentClass = createMockAgentClass(complexPassBehaviors({
        'test-runner': { ok: false, result: 'test runner crashed' },
      }));

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('do something complex', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => {
            throw new Error('commitWorktree must not be called');
          }),
          // no jobSlug / jobCwd / patchJob
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(
        fs.existsSync(path.join(runContext.artifactDir, 'failure.log')),
        false,
        'no job slug → no failure.log',
      );
      assert.equal(
        fs.existsSync(path.join(runContext.artifactDir, 'run.json')),
        false,
        'no job slug → no run.json touch for this feature',
      );
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

/**
 * Contract for `.spec/publish.md` (unit 01-publish): `--pr` / `--base` flags,
 * publish DI after commit, skip/failure rules, merge-hint suppression, status
 * rows, detach argv forwarding, and startup `gh` validation.
 * Simple triage + `--pr` must take the abbreviated worktree→commit→publish path
 * (no research/planner); without `--pr`, simple stays in-place quick-fix.
 */
describe('runPipeline publish (--pr)', () => {
  function collectLogs() {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.map(String).join(' ')));
    return { logs, restore: () => restore.mock.restore() };
  }

  const sampleChanges = {
    files: [
      { status: 'M', path: 'main.js' },
      { status: 'A', path: 'lib/publish.js' },
    ],
    shortstat: '2 files changed, 118 insertions(+), 3 deletions(-)',
  };

  it('with --pr: publish runs after commit; run.json gains pushedAt/prUrl/prNumber; status.md gains a PR section; merge hint is suppressed', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-pr-');
    try {
      const prefix = pinLocalBranchPrefix(tmpCwd);
      const slug = 'publish-pr-ok-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.taskPath, '- [ ] wire --pr\n', 'utf8');
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const patchCalls = [];
      const patchJobMock = realDiskPatchJobSpy(patchCalls);
      const publishMock = mock.fn(() => ({
        url: 'https://github.com/owner/repo/pull/42',
        number: 42,
      }));
      const createWorktreeMock = mock.fn(() => worktree);
      const resolveBaseBranchMock = mock.fn(() => 'main');
      const fetchBaseMock = mock.fn(() => {});

      const { logs, restore } = collectLogs();
      try {
        await withChdirAndIsolatedHome(tmpCwd, () => runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: createWorktreeMock,
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: resolveBaseBranchMock,
          fetchBase: fetchBaseMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: patchJobMock,
        }));
      } finally {
        restore();
      }

      assert.equal(resolveBaseBranchMock.mock.calls.length, 1);
      assert.equal(fetchBaseMock.mock.calls.length, 1);
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].base, 'origin/main');
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].branchPrefix, prefix);

      assert.equal(publishMock.mock.calls.length, 1);
      const publishArg = publishMock.mock.calls[0].arguments[0];
      assert.equal(publishArg.worktreePath, worktree.worktreePath);
      assert.equal(publishArg.branch, worktree.branch);
      assert.equal(publishArg.base, 'main');
      assert.ok(publishArg.bodyPath?.endsWith(`${path.sep}pr.md`) || publishArg.bodyPath?.endsWith('/pr.md'));

      const prMdPath = path.join(runContext.artifactDir, 'pr.md');
      assert.equal(fs.existsSync(prMdPath), true, 'pr.md must be written under the run dir');

      const phases = patchCalls.filter((c) => c.fields.phase).map((c) => c.fields.phase);
      assert.ok(phases.includes('publish'), `expected publish phase in ${JSON.stringify(phases)}`);
      assert.ok(
        phases.indexOf('publish') > phases.indexOf('commit'),
        'publish must follow commit',
      );

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.equal(record.base, 'main');
      assert.equal(record.remote, 'origin');
      assert.equal(record.prUrl, 'https://github.com/owner/repo/pull/42');
      assert.equal(record.prNumber, 42);
      assert.ok(record.pushedAt, 'pushedAt must be set');

      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## (Pull request|PR)/i);
      assert.match(status, /github\.com\/owner\/repo\/pull\/42/);

      const joined = logs.join('\n');
      assert.match(joined, /pr:\s+https:\/\/github\.com\/owner\/repo\/pull\/42/);
      assert.doesNotMatch(joined, /merge:\s+git merge/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('without --pr: no publish call, merge hint still printed, no pr.md, no PR fields in run.json', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-nopr-');
    try {
      const slug = 'publish-nopr-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const publishMock = mock.fn(() => {
        throw new Error('publish must not be called without --pr');
      });
      const resolveBaseBranchMock = mock.fn(() => {
        throw new Error('resolveBaseBranch must not run without --pr/--base');
      });

      const { logs, restore } = collectLogs();
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: resolveBaseBranchMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        restore();
      }

      assert.equal(publishMock.mock.calls.length, 0);
      assert.equal(resolveBaseBranchMock.mock.calls.length, 0);
      assert.equal(fs.existsSync(path.join(runContext.artifactDir, 'pr.md')), false);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.prUrl, undefined);
      assert.equal(record.prNumber, undefined);
      assert.equal(record.pushedAt, undefined);
      assert.equal(record.base, undefined);

      const joined = logs.join('\n');
      assert.match(joined, new RegExp(`merge:\\s+git merge ${escapeRegex(worktree.branch)}`));
      assert.doesNotMatch(joined, /^pr:/m);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with --base alone: worktree starts at origin/<base> but publish is not invoked', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-base-only-');
    try {
      const slug = 'publish-base-only-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const createWorktreeMock = mock.fn(() => worktree);
      const fetchBaseMock = mock.fn(() => {});
      const publishMock = mock.fn(() => {
        throw new Error('publish must not run for --base without --pr');
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          base: 'develop',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: createWorktreeMock,
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          collectWorktreeChanges: mock.fn(() => null),
          fetchBase: fetchBaseMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.equal(fetchBaseMock.mock.calls.length, 1);
      assert.equal(fetchBaseMock.mock.calls[0].arguments[0].base, 'develop');
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].base, 'origin/develop');
      assert.equal(publishMock.mock.calls.length, 0);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with --pr and explicit --base: skips resolveBaseBranch; origin/<base> and PR base use the flag', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-pr-base-');
    try {
      const slug = 'publish-pr-base-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const createWorktreeMock = mock.fn(() => worktree);
      const resolveBaseBranchMock = mock.fn(() => {
        throw new Error('resolveBaseBranch must not run when --base is explicit');
      });
      const fetchBaseMock = mock.fn(() => {});
      const publishMock = mock.fn(() => ({
        url: 'https://github.com/owner/repo/pull/11',
        number: 11,
      }));

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          base: 'develop',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: createWorktreeMock,
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: resolveBaseBranchMock,
          fetchBase: fetchBaseMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.equal(resolveBaseBranchMock.mock.calls.length, 0);
      assert.equal(fetchBaseMock.mock.calls.length, 1);
      assert.equal(fetchBaseMock.mock.calls[0].arguments[0].base, 'develop');
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].base, 'origin/develop');
      assert.equal(publishMock.mock.calls.length, 1);
      assert.equal(publishMock.mock.calls[0].arguments[0].base, 'develop');

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.base, 'develop');
      assert.equal(record.prUrl, 'https://github.com/owner/repo/pull/11');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('simple + --pr: worktree + commit + publish (no research/planner); logs pr url; job gains PR fields', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-simple-pr-');
    try {
      const prefix = pinLocalBranchPrefix(tmpCwd);
      const slug = 'publish-simple-pr-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, slug);
      const order = [];
      const MockAgentClass = createMockAgentClass({
        triage: SIMPLE_TRIAGE,
        'quick-fix': { ok: true, result: withSummary('fixed', QUICK_FIX_SUMMARY) },
        research: { ok: true, result: 'must not run' },
        planner: { ok: true, result: 'must not run' },
      }, { order });
      const createRunContextMock = mock.fn(() => runContext);
      const createWorktreeMock = mock.fn(() => worktree);
      const commitWorktreeMock = mock.fn(() => fakeCommitResult(worktree.branch));
      const collectWorktreeChangesMock = mock.fn(() => sampleChanges);
      const publishMock = mock.fn(() => ({
        url: 'https://github.com/owner/repo/pull/77',
        number: 77,
      }));
      const resolveBaseBranchMock = mock.fn(() => 'main');
      const fetchBaseMock = mock.fn(() => {});
      const patchCalls = [];

      const { logs, restore } = collectLogs();
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await withChdirAndIsolatedHome(tmpCwd, () => runPipeline('fix the typo', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: createRunContextMock,
          createWorktree: createWorktreeMock,
          commitWorktree: commitWorktreeMock,
          collectWorktreeChanges: collectWorktreeChangesMock,
          resolveBaseBranch: resolveBaseBranchMock,
          fetchBase: fetchBaseMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy(patchCalls),
        }));
      } finally {
        restore();
        exitSpy.mock.restore();
      }

      assert.deepEqual(order, ['triage', 'quick-fix']);
      assert.equal(createRunContextMock.mock.calls.length, 1);
      assert.equal(createWorktreeMock.mock.calls.length, 1);
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].base, 'origin/main');
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].slug, slug);
      assert.equal(createWorktreeMock.mock.calls[0].arguments[0].branchPrefix, prefix);
      assert.equal(commitWorktreeMock.mock.calls.length, 1);
      assert.equal(commitWorktreeMock.mock.calls[0].arguments[0].worktreePath, worktree.worktreePath);
      assert.equal(publishMock.mock.calls.length, 1);
      assert.equal(publishMock.mock.calls[0].arguments[0].worktreePath, worktree.worktreePath);
      assert.equal(publishMock.mock.calls[0].arguments[0].branch, worktree.branch);
      assert.equal(publishMock.mock.calls[0].arguments[0].base, 'main');

      const quickFix = MockAgentClass.instances.find((i) => agentRole(i.name) === 'quick-fix');
      assert.ok(quickFix, 'quick-fix agent must run');
      assert.equal(quickFix.options?.cwd, worktree.worktreePath);
      assert.ok(quickFix.options?.fileTracker, 'quick-fix should receive fileTracker on worktree cwd');
      assert.equal(quickFix.options.fileTracker.cwd, path.resolve(worktree.worktreePath));

      const joined = logs.join('\n');
      assert.match(joined, /pr:\s+https:\/\/github\.com\/owner\/repo\/pull\/77/);
      assert.doesNotMatch(joined, /pr:\s+skipped \(quick fix, no branch\)/);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.equal(record.prUrl, 'https://github.com/owner/repo/pull/77');
      assert.equal(record.prNumber, 77);
      assert.ok(record.pushedAt, 'pushedAt must be set');
      assert.equal(record.branch, worktree.branch);
      assert.equal(record.worktree, worktree.worktreePath);
      assert.equal(record.base, 'main');

      assert.equal(fs.existsSync(path.join(runContext.artifactDir, 'pr.md')), true);
      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## (Pull request|PR)/i);
      assert.match(status, /github\.com\/owner\/repo\/pull\/77/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('simple without --pr: still in-place quick-fix — no worktree, commit, or publish', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-simple-nopr-');
    try {
      const slug = 'publish-simple-nopr-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo');
      const order = [];
      const MockAgentClass = createMockAgentClass({
        triage: SIMPLE_TRIAGE,
        'quick-fix': { ok: true, result: withSummary('fixed', QUICK_FIX_SUMMARY) },
      }, { order });
      const createRunContextMock = mock.fn(() => {
        throw new Error('createRunContext must not run for simple without --pr');
      });
      const createWorktreeMock = mock.fn(() => {
        throw new Error('createWorktree must not run for simple without --pr');
      });
      const commitWorktreeMock = mock.fn(() => {
        throw new Error('commitWorktree must not run for simple without --pr');
      });
      const publishMock = mock.fn(() => {
        throw new Error('publish must not run for simple without --pr');
      });

      const { logs, restore } = collectLogs();
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('fix the typo', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: createRunContextMock,
          createWorktree: createWorktreeMock,
          commitWorktree: commitWorktreeMock,
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        restore();
        exitSpy.mock.restore();
      }

      assert.deepEqual(order, ['triage', 'quick-fix']);
      assert.equal(createRunContextMock.mock.calls.length, 0);
      assert.equal(createWorktreeMock.mock.calls.length, 0);
      assert.equal(commitWorktreeMock.mock.calls.length, 0);
      assert.equal(publishMock.mock.calls.length, 0);

      const quickFix = MockAgentClass.instances.find((i) => agentRole(i.name) === 'quick-fix');
      assert.equal(quickFix.options?.cwd, process.cwd());

      const joined = logs.join('\n');
      assert.doesNotMatch(joined, /^pr:/m);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.equal(record.prUrl, undefined);
      assert.equal(record.prNumber, undefined);
      assert.equal(record.pushedAt, undefined);
      // Seeded as null and left untouched on the in-place simple path.
      assert.equal(record.branch, null);
      assert.equal(record.worktree, null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('skip: simple + --pr with committed: false prints no-changes skip and does not publish', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-simple-pr-clean-');
    try {
      const slug = 'publish-simple-pr-clean-0000';
      seedForegroundJob(tmpCwd, slug, 'fix the typo');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, slug);
      const order = [];
      const MockAgentClass = createMockAgentClass({
        triage: SIMPLE_TRIAGE,
        'quick-fix': { ok: true, result: withSummary('fixed', QUICK_FIX_SUMMARY) },
      }, { order });
      const publishMock = mock.fn(() => {
        throw new Error('publish must not run when there is nothing to commit');
      });
      const createRunContextMock = mock.fn(() => runContext);
      const createWorktreeMock = mock.fn(() => worktree);
      const commitWorktreeMock = mock.fn(() => ({
        committed: false,
        sha: null,
        branch: worktree.branch,
      }));

      const { logs, restore } = collectLogs();
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('fix the typo', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: createRunContextMock,
          createWorktree: createWorktreeMock,
          commitWorktree: commitWorktreeMock,
          collectWorktreeChanges: mock.fn(() => null),
          resolveBaseBranch: mock.fn(() => 'main'),
          fetchBase: mock.fn(() => {}),
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        restore();
        exitSpy.mock.restore();
      }

      assert.deepEqual(order, ['triage', 'quick-fix']);
      assert.equal(createRunContextMock.mock.calls.length, 1);
      assert.equal(createWorktreeMock.mock.calls.length, 1);
      assert.equal(commitWorktreeMock.mock.calls.length, 1);
      assert.equal(publishMock.mock.calls.length, 0);
      assert.match(logs.join('\n'), /pr:\s+skipped \(no changes\)/);
      assert.doesNotMatch(logs.join('\n'), /pr:\s+skipped \(quick fix, no branch\)/);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.equal(record.prUrl, undefined);
      assert.equal(fs.existsSync(path.join(runContext.artifactDir, 'pr.md')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('skip: committed: false with --pr prints a skip line and ends done', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-skip-clean-');
    try {
      const slug = 'publish-skip-clean-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const publishMock = mock.fn(() => {
        throw new Error('publish must not run when there is nothing to commit');
      });

      const { logs, restore } = collectLogs();
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => ({ committed: false, sha: null, branch: worktree.branch })),
          collectWorktreeChanges: mock.fn(() => null),
          resolveBaseBranch: mock.fn(() => 'main'),
          fetchBase: mock.fn(() => {}),
          publish: publishMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        restore();
        exitSpy.mock.restore();
      }

      assert.equal(publishMock.mock.calls.length, 0);
      assert.match(logs.join('\n'), /pr:\s+skipped \(no changes\)/);
      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.equal(fs.existsSync(path.join(runContext.artifactDir, 'pr.md')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('failure: throwing pushBranch leaves state failed at phase publish with commit SHA intact', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-fail-push-');
    try {
      const slug = 'publish-fail-push-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const sha = 'deadbeefcafebabe0000000000000000000000';
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const pushBranchMock = mock.fn(() => {
        throw new Error('git push -u origin orch/publish-fail-push-0000 failed: remote rejected');
      });
      const findOpenPullRequestMock = mock.fn(() => null);
      const createPullRequestMock = mock.fn(() => {
        throw new Error('createPullRequest must not run after pushBranch throws');
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => ({ committed: true, sha, branch: worktree.branch })),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: mock.fn(() => 'main'),
          fetchBase: mock.fn(() => {}),
          // Real publish orchestration — inject the failing step, not an opaque publish().
          pushBranch: pushBranchMock,
          findOpenPullRequest: findOpenPullRequestMock,
          createPullRequest: createPullRequestMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(pushBranchMock.mock.calls.length, 1);
      assert.equal(findOpenPullRequestMock.mock.calls.length, 0);
      assert.equal(createPullRequestMock.mock.calls.length, 0);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      assert.equal(record.phase, 'publish');
      assert.equal(record.exitCode, 1);
      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Commit/);
      assert.match(status, new RegExp(sha.slice(0, 7)));
      assert.equal(record.prUrl ?? null, null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('failure: throwing createPullRequest leaves state failed at phase publish with commit SHA intact', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-fail-create-');
    try {
      const slug = 'publish-fail-create-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const sha = 'cafebabedeadbeef0000000000000000000001';
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const pushBranchMock = mock.fn(() => {});
      const findOpenPullRequestMock = mock.fn(() => null);
      const createPullRequestMock = mock.fn(() => {
        throw new Error('gh pr create failed: GraphQL: Resource not accessible');
      });

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => ({ committed: true, sha, branch: worktree.branch })),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: mock.fn(() => 'main'),
          fetchBase: mock.fn(() => {}),
          pushBranch: pushBranchMock,
          findOpenPullRequest: findOpenPullRequestMock,
          createPullRequest: createPullRequestMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      assert.equal(pushBranchMock.mock.calls.length, 1);
      assert.equal(findOpenPullRequestMock.mock.calls.length, 1);
      assert.equal(createPullRequestMock.mock.calls.length, 1);
      assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'failed');
      assert.equal(record.phase, 'publish');
      assert.equal(record.exitCode, 1);
      const status = fs.readFileSync(runContext.statusPath, 'utf8');
      assert.match(status, /## Commit/);
      assert.match(status, new RegExp(sha.slice(0, 7)));
      assert.equal(record.prUrl ?? null, null);
      // Push may have recorded pushedAt before create failed; PR fields must stay unset.
      assert.equal(record.prNumber ?? null, null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('existing PR: push → non-empty findOpenPullRequest skips createPullRequest and reports the URL', async () => {
    const tmpCwd = makeTmpCwd('orch-publish-reuse-');
    try {
      const slug = 'publish-reuse-0000';
      seedForegroundJob(tmpCwd, slug, 'Add publish phase');
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      fs.writeFileSync(runContext.statusPath, `# Status\n\n- Slug: \`${slug}\`\n`, 'utf8');
      const worktree = fakeWorktree(tmpCwd, slug);
      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
      const existingUrl = 'https://github.com/owner/repo/pull/99';
      const pushBranchMock = mock.fn(() => {});
      const findOpenPullRequestMock = mock.fn(() => ({ url: existingUrl, number: 99 }));
      const createPullRequestMock = mock.fn(() => {
        throw new Error('createPullRequest must not run when an open PR already exists');
      });

      const { logs, restore } = collectLogs();
      try {
        await runPipeline('Add publish phase', {
          agent: 'claude',
          pr: true,
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          collectWorktreeChanges: mock.fn(() => sampleChanges),
          resolveBaseBranch: mock.fn(() => 'main'),
          fetchBase: mock.fn(() => {}),
          // Orchestration via injectable steps — not a mocked publish() return value.
          pushBranch: pushBranchMock,
          findOpenPullRequest: findOpenPullRequestMock,
          createPullRequest: createPullRequestMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          patchJob: realDiskPatchJobSpy([]),
        });
      } finally {
        restore();
      }

      assert.equal(pushBranchMock.mock.calls.length, 1);
      assert.equal(findOpenPullRequestMock.mock.calls.length, 1);
      assert.equal(createPullRequestMock.mock.calls.length, 0);
      const record = readJob(tmpCwd, slug);
      assert.equal(record.state, 'done');
      assert.equal(record.prUrl, existingUrl);
      assert.equal(record.prNumber, 99);
      assert.match(logs.join('\n'), new RegExp(`pr:\\s+${escapeRegex(existingUrl)}`));
      assert.doesNotMatch(logs.join('\n'), /merge:\s+git merge/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('formatStatus — publish fields', () => {
  it('prints pr: and base: rows when present on the record', () => {
    const tmpCwd = makeTmpCwd('orch-format-pr-');
    try {
      const slug = 'format-pr-0000';
      writeJob(tmpCwd, slug, {
        slug,
        task: 'Add publish',
        agent: 'claude',
        maxRounds: null,
        cwd: tmpCwd,
        pauseRequested: false,
        branch: 'orch/format-pr-0000',
        worktree: path.join(tmpCwd, 'wt'),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        logPath: jobPaths(tmpCwd, slug).logPath,
        pid: process.pid,
        state: 'done',
        phase: 'publish',
        stage: 'publish',
        round: null,
        base: 'main',
        remote: 'origin',
        prUrl: 'https://github.com/owner/repo/pull/42',
        prNumber: 42,
        pushedAt: new Date().toISOString(),
      });
      const out = formatStatus(tmpCwd, readJob(tmpCwd, slug));
      assert.match(out, /base:\s+main/);
      assert.match(out, /pr:\s+https:\/\/github\.com\/owner\/repo\/pull\/42/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('omits pr: and base: when those fields are absent', () => {
    const tmpCwd = makeTmpCwd('orch-format-nopr-');
    try {
      const slug = 'format-nopr-0000';
      writeJob(tmpCwd, slug, {
        slug,
        task: 'plain run',
        agent: 'claude',
        maxRounds: null,
        cwd: tmpCwd,
        pauseRequested: false,
        branch: 'orch/format-nopr-0000',
        worktree: path.join(tmpCwd, 'wt'),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        logPath: jobPaths(tmpCwd, slug).logPath,
        pid: process.pid,
        state: 'done',
        phase: 'commit',
        stage: 'commit',
        round: null,
      });
      const out = formatStatus(tmpCwd, readJob(tmpCwd, slug));
      assert.doesNotMatch(out, /^base:/m);
      assert.doesNotMatch(out, /^pr:/m);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('--pr flag guards and startup gh check', () => {
  for (const conflicting of ['--ask', '--quick', '--dry-run']) {
    it(`rejects --pr combined with ${conflicting} before any job is created`, async () => {
      const tmpCwd = makeTmpCwd('orch-pr-guard-');
      try {
        const { code, stderr } = await runCli(
          ['a trivial task', '--pr', conflicting],
          { cwd: tmpCwd },
        );
        assert.notEqual(code, 0);
        assert.match(stderr, /--pr cannot be combined/i);
        assert.equal(fs.existsSync(path.join(tmpCwd, '.orch')), false);
      } finally {
        fs.rmSync(tmpCwd, { recursive: true, force: true });
      }
    });
  }

  it('missing gh with --pr exits non-zero and creates no job', async () => {
    const tmpCwd = makeTmpCwd('orch-pr-nogh-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pr-fake-bin-'));
    try {
      // Agent binary present so the failure is specifically about gh, not the agent.
      const agentPath = path.join(binDir, 'claude');
      fs.writeFileSync(agentPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const { code, stderr } = await runCli(
        ['Add publish phase', '--pr', '--agent', 'claude'],
        {
          cwd: tmpCwd,
          env: { ...process.env, PATH: binDir },
        },
      );

      assert.equal(code, 1);
      assert.match(stderr, /gh/i);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('unauthenticated gh with --pr exits non-zero and creates no job', async () => {
    const tmpCwd = makeTmpCwd('orch-pr-unauth-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pr-unauth-bin-'));
    try {
      fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(binDir, 'gh'),
        '#!/bin/sh\nif [ "$1" = "auth" ]; then echo "not logged in" >&2; exit 1; fi\nexit 0\n',
        { mode: 0o755 },
      );

      const { code, stderr } = await runCli(
        ['Add publish phase', '--pr', '--agent', 'claude'],
        {
          cwd: tmpCwd,
          env: { ...process.env, PATH: binDir },
        },
      );

      assert.equal(code, 1);
      assert.match(stderr, /gh|auth|authenticated|login/i);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('runDetached forwards --pr and --base', () => {
  it('includes --pr and --base <branch> in the child argv when set', async () => {
    const tmpCwd = makeTmpCwd('orch-detach-pr-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-detach-pr-bin-'));
    const prevPath = process.env.PATH;
    try {
      // Detach with --pr must validate gh before allocate/spawn (same as foreground).
      fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(binDir, 'gh'),
        '#!/bin/sh\nif [ "$1" = "auth" ]; then exit 0; fi\nexit 0\n',
        { mode: 0o755 },
      );
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

      const spawnMock = fakeDetachSpawn(424242);
      const exitMock = mock.fn();
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runDetached('Add publish phase', {
          agent: 'claude',
          maxRounds: 5,
          cwd: tmpCwd,
          pr: true,
          base: 'develop',
          spawn: spawnMock,
          exit: exitMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.equal(spawnMock.mock.calls.length, 1);
      const [, args] = spawnMock.mock.calls[0].arguments;
      assert.ok(args.includes('--pr'), 'child must receive --pr');
      const baseIdx = args.indexOf('--base');
      assert.ok(baseIdx >= 0, 'child must receive --base');
      assert.equal(args[baseIdx + 1], 'develop');
      assert.ok(!args.includes('--detach'));
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
