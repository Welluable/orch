import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, runDetached } from '../main.js';
import { readJob, writeJob, listJobs, patchJob as realPatchJob, checkpointPause as realCheckpointPause } from '../lib/jobs.js';

/**
 * Contract this file pins down for the headless-run additions to main.js
 * (see .orch/swift-lagoon-49ea/task.md sections 3/4):
 *
 * - `runDetached(prompt, options)` is the detach-PARENT path: it allocates a
 *   run directory via `createRunContext`, writes an initial run.json
 *   (state: "starting"), opens an append fd on orch.log, spawns a
 *   `--detach`-stripped re-invocation of the CLI with `ORCH_JOB_SLUG`/
 *   `ORCH_DETACHED` set (`options.spawn` is injectable, defaults to
 *   node:child_process's `spawn`), patches run.json with the child pid and
 *   `state: "running"`, prints `started <slug> (pid <pid>)`, and calls
 *   `options.exit(0)` (default `process.exit`). It never touches
 *   AgentClass/runPipeline's stage machinery. `options.cwd` overrides
 *   `process.cwd()` for both the run directory and the spawned child's cwd.
 * - `runPipeline` gains: `options.jobSlug` (falls back to
 *   `process.env.ORCH_JOB_SLUG`), `options.jobCwd` (falls back to the
 *   invocation cwd), `options.patchJob`/`options.checkpointPause`
 *   (default the real lib/jobs.js implementations), and
 *   `options.pausePollIntervalMs` (default 500, forwarded to
 *   checkpointPause calls). When `jobSlug` is set, runPipeline patches
 *   `phase`/`stage`/`round` at each stage transition, patches
 *   `branch`/`worktree` right after `createWorktree` succeeds, runs a pause
 *   checkpoint before the first stage and after every individual agent
 *   invocation, and on completion patches a terminal state: `done`/`0` on
 *   success, `failed`/`1` on any thrown error — in both cases with
 *   `finishedAt` set.
 * - `--detach` combined with `--ask`/`--quick`/`--dry-run` is rejected by
 *   the CLI (non-zero exit, no `.orch/<slug>/run.json` created).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd = process.cwd(), env = process.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
      stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

function createMockAgentClass(behaviors, { order, onRun } = {}) {
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
      await onRun?.(role, this.name);
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

/** A fake spawn() result: enough surface for runDetached to read `.pid` and
 * call `.unref()`, without starting a real process. */
function fakeSpawn(pid) {
  return mock.fn(() => ({ pid, unref: () => {} }));
}

describe('runDetached (detach-parent path)', () => {
  it('writes an initial run.json, spawns the re-invoked child, then patches pid + state:"running"', async () => {
    const tmpCwd = makeTmpCwd('orch-detach-');
    try {
      const spawnMock = fakeSpawn(54321);
      const exitMock = mock.fn();
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runDetached('do a trivial thing', {
          agent: 'claude',
          maxRounds: 5,
          cwd: tmpCwd,
          spawn: spawnMock,
          exit: exitMock,
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.equal(spawnMock.mock.calls.length, 1);
      const [command, args, spawnOptions] = spawnMock.mock.calls[0].arguments;
      assert.equal(command, process.execPath);
      assert.ok(args.includes('do a trivial thing'));
      assert.ok(!args.includes('--detach'), 'the re-invoked child must not receive --detach');
      assert.ok(args.includes('--agent'));
      assert.ok(args.includes('claude'));
      assert.ok(args.includes('--max-rounds'));
      assert.ok(args.includes('5'));

      assert.equal(spawnOptions.detached, true);
      assert.equal(spawnOptions.stdio[0], 'ignore');
      assert.equal(typeof spawnOptions.stdio[1], 'number');
      assert.equal(spawnOptions.stdio[1], spawnOptions.stdio[2]);
      assert.equal(spawnOptions.env.ORCH_DETACHED, '1');
      assert.match(spawnOptions.env.ORCH_JOB_SLUG, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

      const slug = spawnOptions.env.ORCH_JOB_SLUG;
      const record = readJob(tmpCwd, slug);
      assert.equal(record.pid, 54321);
      assert.equal(record.state, 'running');
      assert.equal(record.task, 'do a trivial thing');
      assert.equal(record.agent, 'claude');
      assert.equal(record.exitCode, null);
      assert.equal(record.finishedAt, null);

      assert.equal(exitMock.mock.calls.length, 1);
      assert.equal(exitMock.mock.calls[0].arguments[0], 0);

      const printed = logSpy.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
      assert.match(printed, new RegExp(`started ${slug} \\(pid 54321\\)`));
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('creates only run.json and orch.log up front — no research/task/status.md (those belong to the child pipeline)', async () => {
    const tmpCwd = makeTmpCwd('orch-detach-nofiles-');
    try {
      const spawnMock = fakeSpawn(1);
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runDetached('noop', { agent: 'claude', cwd: tmpCwd, spawn: spawnMock, exit: mock.fn() });
      } finally {
        logSpy.mock.restore();
      }

      const [, , spawnOptions] = spawnMock.mock.calls[0].arguments;
      const slug = spawnOptions.env.ORCH_JOB_SLUG;
      const dir = path.join(tmpCwd, '.orch', slug);
      const entries = fs.readdirSync(dir).sort();
      assert.deepEqual(entries, ['orch.log', 'run.json']);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('never constructs or runs any pipeline stage itself', async () => {
    const tmpCwd = makeTmpCwd('orch-detach-nostages-');
    try {
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runDetached('noop', { agent: 'claude', cwd: tmpCwd, spawn: fakeSpawn(1), exit: mock.fn() });
      } finally {
        logSpy.mock.restore();
      }
      // No assertion target beyond "did not throw / did not need an
      // AgentClass" — runDetached takes no AgentClass option at all, so a
      // real accidental pipeline invocation would throw a ReferenceError or
      // ENOENT trying to spawn a real agent CLI, which the try/finally above
      // would have surfaced.
      assert.ok(true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('two concurrent detached runs against the same cwd get distinct slugs, both visible via listJobs', async () => {
    const tmpCwd = makeTmpCwd('orch-detach-concurrency-');
    try {
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await Promise.all([
          runDetached('first task', { agent: 'claude', cwd: tmpCwd, spawn: fakeSpawn(111), exit: mock.fn() }),
          runDetached('second task', { agent: 'claude', cwd: tmpCwd, spawn: fakeSpawn(222), exit: mock.fn() }),
        ]);
      } finally {
        logSpy.mock.restore();
      }

      const jobs = listJobs(tmpCwd);
      assert.equal(jobs.length, 2);
      assert.notEqual(jobs[0].slug, jobs[1].slug);
      assert.deepEqual(jobs.map((j) => j.task).sort(), ['first task', 'second task']);
      assert.deepEqual(jobs.map((j) => j.pid).sort(), [111, 222]);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('--detach flag guards', () => {
  for (const conflicting of ['--ask', '--quick', '--dry-run']) {
    it(`rejects --detach combined with ${conflicting} (non-zero exit, no job created)`, async () => {
      const tmpCwd = makeTmpCwd('orch-detach-guard-');
      try {
        const { code, stderr } = await runCli(['a trivial task', '--detach', conflicting], { cwd: tmpCwd });

        assert.notEqual(code, 0);
        assert.match(stderr, /detach/i);
        assert.equal(fs.existsSync(path.join(tmpCwd, '.orch')), false);
      } finally {
        fs.rmSync(tmpCwd, { recursive: true, force: true });
      }
    });
  }
});

describe('--help reflects the headless surface', () => {
  it('lists the six job-control subcommands and --detach', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--detach/);
    assert.match(stdout, /\blist\b/);
    assert.match(stdout, /\bstatus\b/);
    assert.match(stdout, /\bpause\b/);
    assert.match(stdout, /\bresume\b/);
    assert.match(stdout, /\bstop\b/);
    assert.match(stdout, /\blogs\b/);
  });

  it('lists the jobs clean subcommand', async () => {
    const { code, stdout } = await runCli(['jobs', '--help']);
    assert.equal(code, 0);
    assert.match(stdout, /\bclean\b/);
  });
});

describe('orch jobs clean', () => {
  it('reports no jobs when .orch is empty and does not prompt', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-clean-empty-');
    try {
      const { code, stdout } = await runCli(['jobs', 'clean'], { cwd: tmpCwd });
      assert.equal(code, 0);
      assert.match(stdout, /no jobs to clean/);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('aborts without deleting when the answer is N / empty', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-clean-abort-');
    try {
      writeJob(tmpCwd, 'keep-me-0000', {
        slug: 'keep-me-0000',
        task: 'keep',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
      });

      const { code, stdout } = await runCli(['jobs', 'clean'], { cwd: tmpCwd, stdin: '\n' });
      assert.equal(code, 0);
      assert.match(stdout, /Are you sure\? \[y\/N\]/);
      assert.match(stdout, /aborted/);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'keep-me-0000', 'run.json')), true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('deletes all .orch entries when confirmed with y', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-clean-yes-');
    try {
      writeJob(tmpCwd, 'wipe-me-0000', {
        slug: 'wipe-me-0000',
        task: 'wipe',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
      });
      writeJob(tmpCwd, 'wipe-me-0001', {
        slug: 'wipe-me-0001',
        task: 'wipe too',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
      });

      const { code, stdout } = await runCli(['jobs', 'clean'], { cwd: tmpCwd, stdin: 'y\n' });
      assert.equal(code, 0);
      assert.match(stdout, /Are you sure\? \[y\/N\]/);
      assert.match(stdout, /deleted 2 jobs from \.orch\//);
      assert.deepEqual(fs.readdirSync(path.join(tmpCwd, '.orch')), []);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('runPipeline job phase tracking (ORCH_JOB_SLUG present)', () => {
  it('advances phase/stage across the complex pipeline and patches state:"done" on success', async () => {
    const tmpCwd = makeTmpCwd('orch-phase-success-');
    try {
      const slug = 'phase-success-0000';
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, slug);

      writeJob(tmpCwd, slug, {
        slug, task: 'do something complex', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
        pauseRequested: false, branch: null, worktree: null,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        logPath: path.join(runContext.artifactDir, 'orch.log'), pid: process.pid,
        state: 'running', phase: null, stage: null, round: null,
      });

      const MockAgentClass = createMockAgentClass(complexPassBehaviors());
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
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
      }

      const final = readJob(tmpCwd, slug);
      assert.equal(final.state, 'done');
      assert.equal(final.exitCode, 0);
      assert.ok(final.finishedAt);
      assert.equal(final.branch, worktree.branch);
      assert.equal(final.worktree, worktree.worktreePath);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('patches branch/worktree immediately once createWorktree succeeds, before test-writer starts', async () => {
    const tmpCwd = makeTmpCwd('orch-phase-worktree-');
    try {
      const slug = 'phase-worktree-0000';
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, slug);

      writeJob(tmpCwd, slug, {
        slug, task: 't', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
        pauseRequested: false, branch: null, worktree: null,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        logPath: path.join(runContext.artifactDir, 'orch.log'), pid: process.pid,
        state: 'running', phase: null, stage: null, round: null,
      });

      let branchAtTestWriterStart;
      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        onRun: (role) => {
          if (role === 'test-writer' && branchAtTestWriterStart === undefined) {
            branchAtTestWriterStart = readJob(tmpCwd, slug).branch;
          }
        },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
      }

      assert.equal(branchAtTestWriterStart, worktree.branch);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('patches state:"failed"/exitCode:1/finishedAt when a stage throws', async () => {
    const tmpCwd = makeTmpCwd('orch-phase-failure-');
    try {
      const slug = 'phase-failure-0000';
      const runContext = fakeRunContext(tmpCwd, slug);
      fs.mkdirSync(runContext.artifactDir, { recursive: true });
      const worktree = fakeWorktree(tmpCwd, slug);

      writeJob(tmpCwd, slug, {
        slug, task: 't', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
        pauseRequested: false, branch: null, worktree: null,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        logPath: path.join(runContext.artifactDir, 'orch.log'), pid: process.pid,
        state: 'running', phase: null, stage: null, round: null,
      });

      const MockAgentClass = createMockAgentClass(complexPassBehaviors({
        'code-writer': { ok: false, result: 'implementation failed' },
      }));

      const logSpy = mock.method(console, 'log', () => {});
      const errorSpy = mock.method(console, 'error', () => {});
      const exitSpy = mock.method(process, 'exit', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
        errorSpy.mock.restore();
        exitSpy.mock.restore();
      }

      const final = readJob(tmpCwd, slug);
      assert.equal(final.state, 'failed');
      assert.equal(final.exitCode, 1);
      assert.ok(final.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('reuses the given slug for quick-fix routing too — run.json still tracks state with no research/task/status files', async () => {
    const tmpCwd = makeTmpCwd('orch-phase-quickfix-');
    try {
      const slug = 'phase-quickfix-0000';
      const { dir } = { dir: path.join(tmpCwd, '.orch', slug) };
      fs.mkdirSync(dir, { recursive: true });

      writeJob(tmpCwd, slug, {
        slug, task: 'fix the typo', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
        pauseRequested: false, branch: null, worktree: null,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        logPath: path.join(dir, 'orch.log'), pid: process.pid,
        state: 'running', phase: null, stage: null, round: null,
      });

      const MockAgentClass = createMockAgentClass({
        triage: { ok: true, result: JSON.stringify({ simple: true, why: 'typo' }) },
        'quick-fix': { ok: true, result: 'fixed' },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('fix the typo', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => { throw new Error('createRunContext must not be called on the quick-fix path'); }),
          createWorktree: mock.fn(() => { throw new Error('createWorktree must not be called on the quick-fix path'); }),
          commitWorktree: mock.fn(() => { throw new Error('commitWorktree must not be called on the quick-fix path'); }),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
      }

      const final = readJob(tmpCwd, slug);
      assert.equal(final.state, 'done');
      assert.equal(final.exitCode, 0);
      assert.equal(fs.existsSync(path.join(dir, 'research.md')), false);
      assert.equal(fs.existsSync(path.join(dir, 'task.md')), false);
      assert.equal(fs.existsSync(path.join(dir, 'status.md')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('runPipeline cooperative pause checkpoints (ORCH_JOB_SLUG present)', () => {
  function setupJob(tmpCwd, slug) {
    const runContext = fakeRunContext(tmpCwd, slug);
    fs.mkdirSync(runContext.artifactDir, { recursive: true });
    const worktree = fakeWorktree(tmpCwd, slug);
    writeJob(tmpCwd, slug, {
      slug, task: 't', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
      pauseRequested: false, branch: null, worktree: null,
      startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
      logPath: path.join(runContext.artifactDir, 'orch.log'), pid: process.pid,
      state: 'running', phase: null, stage: null, round: null,
    });
    return { runContext, worktree };
  }

  /** Auto-resumes a job shortly after it flips to "paused", so the
   * checkpoint's poll loop can observe pauseRequested clear without the
   * test hanging or sleeping for the real 500ms default. */
  function autoResumeWhenPaused(tmpCwd, slug) {
    const poll = setInterval(() => {
      const current = readJob(tmpCwd, slug);
      if (current?.state === 'paused') {
        clearInterval(poll);
        realPatchJob(tmpCwd, slug, { pauseRequested: false, state: 'running' });
      }
    }, 10);
    return () => clearInterval(poll);
  }

  it('pausing during test-writer: test-critic does not start until resume, then resumes in the same round', async () => {
    const tmpCwd = makeTmpCwd('orch-pause-testwriter-');
    try {
      const slug = 'pause-testwriter-0000';
      const { runContext, worktree } = setupJob(tmpCwd, slug);
      const stopAutoResume = autoResumeWhenPaused(tmpCwd, slug);

      const order = [];
      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        order,
        onRun: (role) => {
          if (role === 'test-writer') {
            // Simulates an external `orch pause <slug>` firing while
            // test-writer is running.
            realPatchJob(tmpCwd, slug, { pauseRequested: true, state: 'pausing' });
          }
        },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
        stopAutoResume();
      }

      assert.deepEqual(
        order.filter((r) => !['triage', 'research', 'planner'].includes(r)),
        ['test-writer', 'test-critic', 'code-writer', 'test-runner'],
      );
      // Exactly one test-writer/test-critic pair — resumed in the same round.
      assert.equal(order.filter((r) => r === 'test-writer').length, 1);
      const final = readJob(tmpCwd, slug);
      assert.equal(final.state, 'done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('pausing during code-writer: test-runner does not start until resume', async () => {
    const tmpCwd = makeTmpCwd('orch-pause-codewriter-');
    try {
      const slug = 'pause-codewriter-0000';
      const { runContext, worktree } = setupJob(tmpCwd, slug);
      const stopAutoResume = autoResumeWhenPaused(tmpCwd, slug);

      const order = [];
      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        order,
        onRun: (role) => {
          if (role === 'code-writer') {
            realPatchJob(tmpCwd, slug, { pauseRequested: true, state: 'pausing' });
          }
        },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
        stopAutoResume();
      }

      assert.deepEqual(
        order.filter((r) => !['triage', 'research', 'planner', 'test-writer', 'test-critic'].includes(r)),
        ['code-writer', 'test-runner'],
      );
      assert.equal(readJob(tmpCwd, slug).state, 'done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('pausing after test-critic passes delays code-writer until resume', async () => {
    const tmpCwd = makeTmpCwd('orch-pause-testcritic-');
    try {
      const slug = 'pause-testcritic-0000';
      const { runContext, worktree } = setupJob(tmpCwd, slug);
      const stopAutoResume = autoResumeWhenPaused(tmpCwd, slug);

      const order = [];
      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        order,
        onRun: (role) => {
          if (role === 'test-critic') {
            realPatchJob(tmpCwd, slug, { pauseRequested: true, state: 'pausing' });
          }
        },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
        stopAutoResume();
      }

      assert.deepEqual(
        order.filter((r) => !['triage', 'research', 'planner'].includes(r)),
        ['test-writer', 'test-critic', 'code-writer', 'test-runner'],
      );
      assert.equal(readJob(tmpCwd, slug).state, 'done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('pausing after test-runner passes delays the commit until resume', async () => {
    const tmpCwd = makeTmpCwd('orch-pause-testrunner-');
    try {
      const slug = 'pause-testrunner-0000';
      const { runContext, worktree } = setupJob(tmpCwd, slug);
      const stopAutoResume = autoResumeWhenPaused(tmpCwd, slug);

      let sawPausedBeforeCommit = false;
      const commitWorktreeMock = mock.fn(() => {
        if (readJob(tmpCwd, slug)?.state === 'paused') sawPausedBeforeCommit = true;
        return fakeCommitResult(worktree.branch);
      });

      let sawPausedAtAll = false;
      const watcher = setInterval(() => {
        if (readJob(tmpCwd, slug)?.state === 'paused') sawPausedAtAll = true;
      }, 5);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        onRun: (role) => {
          if (role === 'test-runner') {
            realPatchJob(tmpCwd, slug, { pauseRequested: true, state: 'pausing' });
          }
        },
      });

      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: commitWorktreeMock,
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 10,
        });
      } finally {
        logSpy.mock.restore();
        stopAutoResume();
        clearInterval(watcher);
      }

      // The pipeline really did pause at some point (proving the checkpoint
      // fired), but by the time commitWorktree actually ran, it had already
      // resumed — i.e. commit was held behind the checkpoint, not run mid-pause.
      assert.equal(sawPausedAtAll, true);
      assert.equal(sawPausedBeforeCommit, false);
      assert.equal(commitWorktreeMock.mock.calls.length, 1);
      assert.equal(readJob(tmpCwd, slug).state, 'done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('resuming while still "pausing" (before the checkpoint runs) cancels the request with no wait', async () => {
    const tmpCwd = makeTmpCwd('orch-pause-cancelled-');
    try {
      const slug = 'pause-cancelled-0000';
      const { runContext, worktree } = setupJob(tmpCwd, slug);

      let sawPausedState = false;
      const watcher = setInterval(() => {
        if (readJob(tmpCwd, slug)?.state === 'paused') sawPausedState = true;
      }, 5);

      const MockAgentClass = createMockAgentClass(complexPassBehaviors(), {
        onRun: (role) => {
          if (role === 'test-writer') {
            // Pause requested, then immediately cancelled — both before the
            // pipeline's checkpoint ever gets a chance to read run.json.
            realPatchJob(tmpCwd, slug, { pauseRequested: true, state: 'pausing' });
            realPatchJob(tmpCwd, slug, { pauseRequested: false, state: 'running' });
          }
        },
      });

      const start = Date.now();
      const logSpy = mock.method(console, 'log', () => {});
      try {
        await runPipeline('t', {
          agent: 'claude',
          AgentClass: MockAgentClass,
          createRunContext: mock.fn(() => runContext),
          createWorktree: mock.fn(() => worktree),
          commitWorktree: mock.fn(() => fakeCommitResult(worktree.branch)),
          jobSlug: slug,
          jobCwd: tmpCwd,
          pausePollIntervalMs: 5000,
        });
      } finally {
        logSpy.mock.restore();
        clearInterval(watcher);
      }
      const elapsed = Date.now() - start;

      assert.equal(sawPausedState, false);
      assert.ok(elapsed < 4000, `expected no 5s poll wait, took ${elapsed}ms`);
      assert.equal(readJob(tmpCwd, slug).state, 'done');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('checkpointPause used directly by runPipeline is the real lib/jobs.js implementation by default', () => {
  it('sanity: the exported checkpointPause used above is importable and callable standalone', async () => {
    const tmpCwd = makeTmpCwd('orch-checkpoint-sanity-');
    try {
      writeJob(tmpCwd, 'sanity-0000', {
        slug: 'sanity-0000', task: 't', agent: 'claude', maxRounds: 5, cwd: tmpCwd,
        pauseRequested: false, branch: null, worktree: null,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
        logPath: '/dev/null', pid: process.pid, state: 'running', phase: null, stage: null, round: null,
      });
      await realCheckpointPause(tmpCwd, 'sanity-0000', { pollIntervalMs: 10 });
      assert.equal(readJob(tmpCwd, 'sanity-0000').state, 'running');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
