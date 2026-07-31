import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJob, readJob, patchJob, reconcileJob } from '../lib/jobs.js';

/**
 * Contract for desktop notifications on terminal job states
 * (`.spec/notify.md` / task checklist).
 *
 * `lib/notify.js` (net-new):
 *   - `notifyJob({ slug, state, task, enabled, spawn?, platform? })`
 *     - no-op when `enabled === false` or `state` not in
 *       `done|failed|stopped|crashed`
 *     - title `orch · <slug>`; body `<state> — <short-task>` (~80 char
 *       truncate with `…`) or just `<state>` when task empty/missing
 *     - darwin → `osascript -e 'display notification …'` with
 *       JSON.stringify-safe AppleScript string literals (quotes/backslashes
 *       must not throw or break `-e`)
 *     - linux → `notify-send -- <title> <body>` when on PATH; else no-op
 *     - other platforms → no-op
 *     - fire-and-forget: `stdio: 'ignore'`, `detached: true`, `unref()`;
 *       swallow all spawn/errors
 *     - `spawn` / `platform` are injectable for tests (default real
 *       `child_process.spawn` / `process.platform`)
 *   - `setNotifyEnabled(boolean)` / `getNotifyEnabled()` — process-level
 *     gate (same idea as `setJobSlug`); default off until main resolves
 *     config so unit tests that patch jobs do not fire OS notifications
 *
 * Wiring (preferred: terminal `state` writes):
 *   - `lib/jobs.js` exports `setNotifyJob(fn)` / `resetNotifyHooks()` so
 *     tests can inject a mock. When `getNotifyEnabled()` is true and a
 *     write transitions previous non-terminal → terminal, call
 *     `notifyJob({ slug, state, task, enabled: true })` once.
 *   - `reconcileJob` first dead-pid → `crashed` notifies once; a second
 *     reconcile on already-`crashed` does not.
 *   - Stage-only / pause patches never notify.
 *   - `runPipeline` also accepts `options.notifyJob` when the pipeline
 *     itself calls the helper (either path is fine if terminal transitions
 *     notify exactly once).
 *   - Dry-run never notifies (no lifecycle / force-disabled).
 *   - `runDetached` parent must not notify on allocate/spawn; child argv
 *     must forward `--notify` / `--no-notify` when the parent had them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

async function loadNotify() {
  return import('../lib/notify.js');
}

async function loadJobsHooks() {
  const jobs = await import('../lib/jobs.js');
  assert.equal(typeof jobs.setNotifyJob, 'function', 'lib/jobs.js must export setNotifyJob');
  assert.equal(typeof jobs.resetNotifyHooks, 'function', 'lib/jobs.js must export resetNotifyHooks');
  return jobs;
}

function makeTmp(prefix = 'orch-notify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeNotifierSpawn() {
  return mock.fn(() => ({
    unref() {},
    on() {},
  }));
}

function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
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

const PASS_CRITIC = { ok: true, result: JSON.stringify({ passed: true, summary: 'tests adequate' }) };
const PASS_RUNNER = { ok: true, result: JSON.stringify({ passed: true, summary: 'suite green' }) };

function complexPassBehaviors(overrides = {}) {
  return {
    triage: { ok: true, result: JSON.stringify({ simple: false, why: 'needs research' }) },
    research: { ok: true, result: 'research-output' },
    planner: { ok: true, result: 'planner-output' },
    'test-writer': { ok: true, result: 'tests written' },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: 'implemented' },
    'test-runner': PASS_RUNNER,
    ...overrides,
  };
}

function baseRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    slug: 'stub-stub-0000',
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
    logPath: '/tmp/wherever/.orch/stub-stub-0000/orch.log',
    pid: process.pid,
    state: 'running',
    phase: 'test-loop',
    stage: 'test-writer',
    round: 1,
    ...overrides,
  };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return pid;
}

function runCli(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function fakeDetachSpawn(pid = 4242) {
  return mock.fn(() => ({ pid, unref: () => {} }));
}

describe('notifyJob', () => {
  it('no-ops when enabled is false', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    notifyJob({
      slug: 'quirky-oasis-906b',
      state: 'done',
      task: 'ship it',
      enabled: false,
      spawn: spawnMock,
      platform: 'darwin',
    });
    assert.equal(spawnMock.mock.calls.length, 0);
  });

  it('no-ops for non-terminal states', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    for (const state of ['running', 'starting', 'pausing', 'paused']) {
      notifyJob({
        slug: 'quirky-oasis-906b',
        state,
        task: 'ship it',
        enabled: true,
        spawn: spawnMock,
        platform: 'darwin',
      });
    }
    assert.equal(spawnMock.mock.calls.length, 0);
  });

  it('spawns osascript on darwin with title and body', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    notifyJob({
      slug: 'quirky-oasis-906b',
      state: 'done',
      task: 'add a --verbose flag that streams agent output',
      enabled: true,
      spawn: spawnMock,
      platform: 'darwin',
    });
    assert.equal(spawnMock.mock.calls.length, 1);
    const [cmd, args, opts] = spawnMock.mock.calls[0].arguments;
    assert.equal(cmd, 'osascript');
    assert.ok(args.includes('-e'));
    const script = args[args.indexOf('-e') + 1];
    assert.match(script, /display notification/);
    assert.match(script, /orch · quirky-oasis-906b/);
    assert.match(script, /done — add a --verbose flag that streams agent output/);
    assert.equal(opts.stdio, 'ignore');
    assert.equal(opts.detached, true);
  });

  it('body is just the state when task is empty or missing', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    notifyJob({
      slug: 'merry-elk-r4b1',
      state: 'stopped',
      task: '',
      enabled: true,
      spawn: spawnMock,
      platform: 'darwin',
    });
    const script = spawnMock.mock.calls[0].arguments[1][1];
    assert.match(script, /stopped/);
    assert.doesNotMatch(script, /stopped —/);
  });

  it('truncates long task bodies to ~80 chars with an ellipsis', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    const long = 'x'.repeat(120);
    notifyJob({
      slug: 'rapid-fox-x7q2',
      state: 'failed',
      task: long,
      enabled: true,
      spawn: spawnMock,
      platform: 'darwin',
    });
    const script = spawnMock.mock.calls[0].arguments[1][1];
    assert.match(script, /failed — .{1,80}…/);
    assert.doesNotMatch(script, new RegExp(`failed — ${'x'.repeat(100)}`));
  });

  it('escapes quotes and backslashes in AppleScript literals without throwing', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    assert.doesNotThrow(() => {
      notifyJob({
        slug: 'quote-slug-0001',
        state: 'done',
        task: 'fix "quotes" and \\ backslashes',
        enabled: true,
        spawn: spawnMock,
        platform: 'darwin',
      });
    });
    assert.equal(spawnMock.mock.calls.length, 1);
    const script = spawnMock.mock.calls[0].arguments[1][1];
    assert.match(script, /display notification/);
    assert.match(script, /orch · quote-slug-0001/);
  });

  it('uses notify-send on linux', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    notifyJob({
      slug: 'linux-slug-0001',
      state: 'done',
      task: 'ship it',
      enabled: true,
      spawn: spawnMock,
      platform: 'linux',
    });
    assert.equal(spawnMock.mock.calls.length, 1);
    const [cmd, args] = spawnMock.mock.calls[0].arguments;
    assert.equal(cmd, 'notify-send');
    assert.ok(args.includes('--'));
    assert.ok(args.includes('orch · linux-slug-0001'));
    assert.ok(args.includes('done — ship it'));
  });

  it('no-ops on unsupported platforms', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = fakeNotifierSpawn();
    notifyJob({
      slug: 'win-slug-0001',
      state: 'done',
      task: 'ship it',
      enabled: true,
      spawn: spawnMock,
      platform: 'win32',
    });
    assert.equal(spawnMock.mock.calls.length, 0);
  });

  it('swallows spawn errors', async () => {
    const { notifyJob } = await loadNotify();
    const spawnMock = mock.fn(() => {
      throw new Error('spawn ENOENT');
    });
    assert.doesNotThrow(() => {
      notifyJob({
        slug: 'err-slug-0001',
        state: 'done',
        task: 'ship it',
        enabled: true,
        spawn: spawnMock,
        platform: 'darwin',
      });
    });
  });
});

describe('setNotifyEnabled process gate', () => {
  it('defaults to disabled until set (safe for unit tests)', async () => {
    const { setNotifyEnabled, getNotifyEnabled } = await loadNotify();
    setNotifyEnabled(false);
    assert.equal(getNotifyEnabled(), false);
    setNotifyEnabled(true);
    assert.equal(getNotifyEnabled(), true);
    setNotifyEnabled(false);
  });
});

describe('terminal state writes notify once', () => {
  let notifyMock;
  let setNotifyJob;
  let resetNotifyHooks;
  let setNotifyEnabled;

  beforeEach(async () => {
    const notify = await loadNotify();
    const jobs = await loadJobsHooks();
    setNotifyEnabled = notify.setNotifyEnabled;
    setNotifyJob = jobs.setNotifyJob;
    resetNotifyHooks = jobs.resetNotifyHooks;
    notifyMock = mock.fn();
    setNotifyJob(notifyMock);
    setNotifyEnabled(true);
  });

  afterEach(() => {
    resetNotifyHooks?.();
    setNotifyEnabled?.(false);
  });

  it('patchJob to done from running notifies once with slug/state/task', () => {
    const tmpCwd = makeTmp('orch-notify-patch-');
    const record = baseRecord({ slug: 'patch-done-0000', state: 'running' });
    writeJob(tmpCwd, record.slug, record);

    patchJob(tmpCwd, record.slug, {
      state: 'done',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });

    assert.equal(notifyMock.mock.calls.length, 1);
    const arg = notifyMock.mock.calls[0].arguments[0];
    assert.equal(arg.slug, 'patch-done-0000');
    assert.equal(arg.state, 'done');
    assert.equal(arg.task, record.task);
    assert.equal(arg.enabled, true);
  });

  it('stage-only patches do not notify', () => {
    const tmpCwd = makeTmp('orch-notify-stage-');
    const record = baseRecord({ slug: 'patch-stage-0000', state: 'running' });
    writeJob(tmpCwd, record.slug, record);

    patchJob(tmpCwd, record.slug, { phase: 'code-loop', stage: 'code-writer', round: 2 });

    assert.equal(notifyMock.mock.calls.length, 0);
    assert.equal(readJob(tmpCwd, record.slug).state, 'running');
  });

  it('already-terminal patches do not re-notify', () => {
    const tmpCwd = makeTmp('orch-notify-reterm-');
    const record = baseRecord({
      slug: 'patch-reterm-0000',
      state: 'done',
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    writeJob(tmpCwd, record.slug, record);

    patchJob(tmpCwd, record.slug, { lastOutcome: { state: 'done' } });

    assert.equal(notifyMock.mock.calls.length, 0);
  });

  it('disabled gate suppresses notify even on terminal transition', () => {
    setNotifyEnabled(false);
    const tmpCwd = makeTmp('orch-notify-off-');
    const record = baseRecord({ slug: 'patch-off-0000', state: 'running' });
    writeJob(tmpCwd, record.slug, record);

    patchJob(tmpCwd, record.slug, { state: 'failed', exitCode: 1 });

    assert.equal(notifyMock.mock.calls.length, 0);
  });
});

describe('reconcileJob notifies on first crashed transition only', () => {
  let notifyMock;
  let setNotifyJob;
  let resetNotifyHooks;
  let setNotifyEnabled;

  beforeEach(async () => {
    const notify = await loadNotify();
    const jobs = await loadJobsHooks();
    setNotifyEnabled = notify.setNotifyEnabled;
    setNotifyJob = jobs.setNotifyJob;
    resetNotifyHooks = jobs.resetNotifyHooks;
    notifyMock = mock.fn();
    setNotifyJob(notifyMock);
    setNotifyEnabled(true);
  });

  afterEach(() => {
    resetNotifyHooks?.();
    setNotifyEnabled?.(false);
  });

  it('notifies once when dead-pid running → crashed', async () => {
    const tmpCwd = makeTmp('orch-notify-crash-');
    const pid = await deadPid();
    const record = baseRecord({ slug: 'crash-once-0000', state: 'running', pid });
    writeJob(tmpCwd, record.slug, record);

    const first = reconcileJob(tmpCwd, record.slug, record);
    assert.equal(first.state, 'crashed');
    assert.equal(notifyMock.mock.calls.length, 1);
    assert.equal(notifyMock.mock.calls[0].arguments[0].state, 'crashed');
    assert.equal(notifyMock.mock.calls[0].arguments[0].slug, 'crash-once-0000');

    const second = reconcileJob(tmpCwd, record.slug, first);
    assert.equal(second.state, 'crashed');
    assert.equal(notifyMock.mock.calls.length, 1, 'second reconcile must not re-notify');
  });
});

describe('runPipeline notifies once on terminal done, not on stage patches', () => {
  it('calls notifyJob once when the pipeline reaches done', async () => {
    const { runPipeline } = await import('../main.js');
    const notify = await loadNotify();
    const jobs = await loadJobsHooks();
    const tmpCwd = makeTmp('orch-notify-pipe-');
    const slug = 'pipe-done-0000';
    const runContext = fakeRunContext(tmpCwd, slug);
    fs.mkdirSync(runContext.artifactDir, { recursive: true });
    const worktree = fakeWorktree(tmpCwd, slug);

    writeJob(tmpCwd, slug, {
      slug,
      task: 'do something complex',
      agent: 'claude',
      maxRounds: 5,
      cwd: tmpCwd,
      pauseRequested: false,
      branch: null,
      worktree: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      logPath: path.join(runContext.artifactDir, 'orch.log'),
      pid: process.pid,
      state: 'running',
      phase: null,
      stage: null,
      round: null,
    });

    const notifyMock = mock.fn();
    jobs.setNotifyJob(notifyMock);
    notify.setNotifyEnabled(true);

    const MockAgentClass = createMockAgentClass(complexPassBehaviors());
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
        commitWorktree: mock.fn(() => ({
          committed: true,
          sha: 'deadbeefcafebabe0000000000000000000000',
          branch: worktree.branch,
        })),
        jobSlug: slug,
        jobCwd: tmpCwd,
        pausePollIntervalMs: 10,
        notifyJob: notifyMock,
      });
    } finally {
      logSpy.mock.restore();
      jobs.resetNotifyHooks();
      notify.setNotifyEnabled(false);
    }

    assert.equal(readJob(tmpCwd, slug).state, 'done');
    assert.equal(notifyMock.mock.calls.length, 1);
    const arg = notifyMock.mock.calls[0].arguments[0];
    assert.equal(arg.slug, slug);
    assert.equal(arg.state, 'done');
  });
});

describe('dry-run never notifies', () => {
  it('CLI --dry-run with --notify creates no job and exits without lifecycle', async () => {
    const home = makeTmp('orch-notify-dry-home-');
    const cwd = makeTmp('orch-notify-dry-cwd-');
    const { code, stdout, stderr } = await runCli(
      ['noop', '--dry-run', '--notify', '--agent', 'claude'],
      { cwd, env: { ...process.env, HOME: home, PATH: process.env.PATH } },
    );
    if (code === 0) {
      assert.match(stdout, /dry-run|agent:/i);
    } else {
      assert.match(stderr, /not found|PATH|claude|unknown|notify/i);
    }
    assert.equal(fs.existsSync(path.join(cwd, '.orch')), false);
  });

  it('runPipeline dryRun path never calls notifyJob', async () => {
    const { runPipeline } = await import('../main.js');
    const notify = await loadNotify();
    const jobs = await loadJobsHooks();
    const notifyMock = mock.fn();
    jobs.setNotifyJob(notifyMock);
    notify.setNotifyEnabled(true);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('noop', {
        agent: 'claude',
        dryRun: true,
        notifyJob: notifyMock,
        AgentClass: createMockAgentClass({}),
      });
    } catch {
      // dry-run may throw if binary missing; notify must still stay at zero
    } finally {
      logSpy.mock.restore();
      jobs.resetNotifyHooks();
      notify.setNotifyEnabled(false);
    }
    assert.equal(notifyMock.mock.calls.length, 0);
  });
});

describe('runDetached parent does not notify; forwards notify flags', () => {
  it('does not notify on allocate/spawn', async () => {
    const { runDetached } = await import('../main.js');
    const notify = await loadNotify();
    const jobs = await loadJobsHooks();
    const tmpCwd = makeTmp('orch-notify-detach-');
    const notifyMock = mock.fn();
    jobs.setNotifyJob(notifyMock);
    notify.setNotifyEnabled(true);

    const spawnMock = fakeDetachSpawn(55555);
    const exitMock = mock.fn();
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('do a trivial thing', {
        agent: 'claude',
        maxRounds: 5,
        cwd: tmpCwd,
        spawn: spawnMock,
        exit: exitMock,
        notify: true,
        notifyJob: notifyMock,
      });
    } finally {
      logSpy.mock.restore();
      jobs.resetNotifyHooks();
      notify.setNotifyEnabled(false);
    }

    assert.equal(notifyMock.mock.calls.length, 0);
    assert.equal(spawnMock.mock.calls.length, 1);
  });

  it('forwards --notify into child argv when parent had it', async () => {
    const { runDetached } = await import('../main.js');
    const tmpCwd = makeTmp('orch-notify-detach-fwd-');
    const spawnMock = fakeDetachSpawn(55556);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('do a trivial thing', {
        agent: 'claude',
        maxRounds: 5,
        cwd: tmpCwd,
        spawn: spawnMock,
        exit: mock.fn(),
        notify: true,
      });
    } finally {
      logSpy.mock.restore();
    }

    const [, args] = spawnMock.mock.calls[0].arguments;
    assert.ok(args.includes('--notify'), 'child must receive --notify');
    assert.ok(!args.includes('--no-notify'));
  });

  it('forwards --no-notify into child argv when parent had it', async () => {
    const { runDetached } = await import('../main.js');
    const tmpCwd = makeTmp('orch-notify-detach-nofwd-');
    const spawnMock = fakeDetachSpawn(55557);
    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runDetached('do a trivial thing', {
        agent: 'claude',
        maxRounds: 5,
        cwd: tmpCwd,
        spawn: spawnMock,
        exit: mock.fn(),
        notify: false,
      });
    } finally {
      logSpy.mock.restore();
    }

    const [, args] = spawnMock.mock.calls[0].arguments;
    assert.ok(args.includes('--no-notify'), 'child must receive --no-notify');
  });
});
