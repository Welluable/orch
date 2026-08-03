import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, runDetached } from '../main.js';
import { readJob, writeJob, listJobs, patchJob as realPatchJob, checkpointPause as realCheckpointPause } from '../lib/jobs.js';
import { createWorktree } from '../lib/worktree.js';

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
 * - Job records are universal, not just `--detach`: the Commander `.action()`
 *   callback itself (not just `runPipeline`'s injectable `jobSlug`/`jobCwd`
 *   seam) allocates a job and threads the slug through for every
 *   non-detached invocation kind (plain/full pipeline, `--ask`, `--quick`).
 *   The "Commander action wiring" describe block below proves this against
 *   a real, unmocked `node main.js ...` subprocess (using a fake `claude`
 *   binary on `PATH` so no real agent CLI is required) — a regression that
 *   pre-injecting `jobSlug`/`jobCwd` into direct `runPipeline(...)` calls
 *   (as the rest of this file and test/main.test.js do) cannot catch, since
 *   that seam is a no-op if the CLI action never calls the allocator at all.
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

/** Foreground CLI env: drop inherited job slug so allocate tests are not vacuous under an orch worker. */
function foregroundCliEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.ORCH_JOB_SLUG;
  delete env.ORCH_DETACHED;
  return env;
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

/**
 * Writes a minimal, fake `claude` CLI binary that speaks just enough of the
 * `-p --output-format stream-json` protocol (lib/agent-claude.js /
 * lib/agent.js) to let a *real*, unmocked `node main.js ...` subprocess run
 * an ask/quick-fix/triage stage to completion without a real agent CLI
 * installed. Each invocation emits one `result` event whose `result` string
 * is the next entry from `responses` (queue position tracked via a small
 * counter file so successive stages — e.g. triage then quick-fix — get
 * different canned answers), then exits 0.
 */
function writeFakeAgentBinary(binDir, binName, stateFilePath, responses) {
  const scriptPath = path.join(binDir, binName);
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    `const stateFile = ${JSON.stringify(stateFilePath)};`,
    `const responses = ${JSON.stringify(responses)};`,
    'let n = 0;',
    'try { n = parseInt(fs.readFileSync(stateFile, "utf8"), 10) || 0; } catch {}',
    'const content = responses[Math.min(n, responses.length - 1)];',
    'fs.writeFileSync(stateFile, String(n + 1));',
    'process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: content, duration_ms: 1 }) + "\\n");',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
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

describe('Commander action wiring: job records are universal, not just --detach (real CLI subprocess, no injected test options)', () => {
  /**
   * These three tests spawn the *real* CLI (`node main.js ...`) with a fake
   * `claude` binary on PATH — no `jobSlug`/`jobCwd`/`patchJob` is ever
   * injected. They exist specifically because every other job-record test in
   * this file and test/main.test.js pre-injects `options.jobSlug`/`jobCwd`
   * into a direct `runPipeline(...)` call, which only proves runPipeline's
   * own patching seam works — it says nothing about whether the Commander
   * `.action()` callback (main.js's `.action(async (task, options) => {...})`)
   * actually calls the shared job-allocation helper and sets
   * `options.jobSlug` before invoking `runPipeline` for non-detached runs. An
   * implementation that wires `jobPatch` calls into --ask/--quick/the plain
   * pipeline correctly, but never allocates/threads the slug from the CLI
   * action itself, would leave every pre-injected test green while this one
   * fails (no `.orch/<slug>/run.json` ever appears on disk).
   */
  it('--ask: a real, unmocked CLI run creates and patches a real run.json (phase:"ask" → terminal state:"done")', async () => {
    const tmpCwd = makeTmpCwd('orch-action-ask-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fake-bin-'));
    try {
      writeFakeAgentBinary(binDir, 'claude', path.join(tmpCwd, '.fake-calls'), ['the entrypoint is main.js']);

      const { code, stdout } = await runCli(
        ['where is the CLI entrypoint?', '--agent', 'claude', '--ask'],
        { cwd: tmpCwd, env: foregroundCliEnv({ PATH: `${binDir}:${process.env.PATH}` }) },
      );

      assert.equal(code, 0);
      assert.match(stdout, /the entrypoint is main\.js/);

      const orchDir = path.join(tmpCwd, '.orch');
      assert.equal(fs.existsSync(orchDir), true, 'the Commander action must allocate a job for --ask too, not just --detach');
      const slugs = fs.readdirSync(orchDir);
      assert.equal(slugs.length, 1);
      const [slug] = slugs;

      const record = readJob(tmpCwd, slug);
      assert.ok(record, 'expected a real run.json readable via readJob');
      assert.equal(record.task, 'where is the CLI entrypoint?');
      assert.equal(record.agent, 'claude');
      assert.equal(record.phase, 'ask');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('--quick: a real, unmocked CLI run creates and patches a real run.json (phase:"quick-fix" → terminal state:"done"), with no run context/worktree', async () => {
    const tmpCwd = makeTmpCwd('orch-action-quick-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fake-bin-'));
    try {
      writeFakeAgentBinary(binDir, 'claude', path.join(tmpCwd, '.fake-calls'), ['fixed the typo']);

      const { code } = await runCli(
        ['fix the typo', '--agent', 'claude', '--quick'],
        { cwd: tmpCwd, env: foregroundCliEnv({ PATH: `${binDir}:${process.env.PATH}` }) },
      );

      assert.equal(code, 0);

      const orchDir = path.join(tmpCwd, '.orch');
      assert.equal(fs.existsSync(orchDir), true, 'the Commander action must allocate a job for --quick too, not just --detach');
      const [slug] = fs.readdirSync(orchDir);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.task, 'fix the typo');
      assert.equal(record.phase, 'quick-fix');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
      assert.equal(record.branch, null);
      assert.equal(record.worktree, null);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('plain invocation (no flags), triage-routed to quick-fix: a real, unmocked CLI run still creates and patches a real run.json', async () => {
    const tmpCwd = makeTmpCwd('orch-action-plain-');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fake-bin-'));
    try {
      writeFakeAgentBinary(binDir, 'claude', path.join(tmpCwd, '.fake-calls'), [
        JSON.stringify({ simple: true, fix_plan: 'apply the trivial fix' }),
        'fixed it',
      ]);

      const { code } = await runCli(
        ['fix the typo', '--agent', 'claude'],
        { cwd: tmpCwd, env: foregroundCliEnv({ PATH: `${binDir}:${process.env.PATH}` }) },
      );

      assert.equal(code, 0);

      const orchDir = path.join(tmpCwd, '.orch');
      assert.equal(fs.existsSync(orchDir), true, 'the Commander action must allocate a job for plain invocations too, not just --detach');
      const [slug] = fs.readdirSync(orchDir);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.task, 'fix the typo');
      assert.equal(record.phase, 'quick-fix');
      assert.equal(record.state, 'done');
      assert.equal(record.exitCode, 0);
      assert.ok(record.finishedAt);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('a real CLI run started foreground (no --detach) writes run.json with state:"running" immediately, before the agent binary even resolves', async () => {
    const tmpCwd = makeTmpCwd('orch-action-running-');
    try {
      const { code, stderr } = await runCli(
        ['a trivial task', '--agent', 'claude'],
        { cwd: tmpCwd, env: foregroundCliEnv({ PATH: '/nonexistent-empty-path-for-tests' }) },
      );

      assert.equal(code, 1);
      assert.match(stderr, /claude not found/i);

      const orchDir = path.join(tmpCwd, '.orch');
      assert.equal(fs.existsSync(orchDir), true, 'the Commander action must allocate a job before the binary-on-PATH check runs');
      const [slug] = fs.readdirSync(orchDir);

      const record = readJob(tmpCwd, slug);
      assert.equal(record.task, 'a trivial task');
      assert.equal(record.agent, 'claude');
      // Foreground (non-detached) runs have no separate child process to
      // wait on, so allocation starts them straight in "running" — unlike
      // runDetached's detach-parent, which starts in "starting".
      assert.equal(record.state, 'running');
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('with ORCH_JOB_SLUG already set, does not allocate a second run.json / orch list entry (detached child path)', async () => {
    // Mirrors --seq's ORCH_JOB_SLUG reuse and continue-detach's child-skip
    // pattern: parent owns allocateJob; the re-invoked child must only
    // setJobSlug/options.jobSlug and run the pipeline. Empty PATH fails
    // after the allocate decision so we can observe whether a second
    // slug appeared without needing a full agent run.
    const tmpCwd = makeTmpCwd('orch-action-reuse-slug-');
    try {
      const slug = 'preallocated-child-0000';
      const artifactDir = path.join(tmpCwd, '.orch', slug);
      fs.mkdirSync(artifactDir, { recursive: true });
      writeJob(tmpCwd, slug, {
        slug,
        task: 'a trivial task',
        agent: 'claude',
        maxRounds: 5,
        cwd: tmpCwd,
        pauseRequested: false,
        branch: null,
        worktree: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        logPath: path.join(artifactDir, 'orch.log'),
        pid: process.pid,
        state: 'running',
        phase: null,
        stage: null,
        round: null,
      });

      const before = listJobs(tmpCwd);
      assert.equal(before.length, 1);

      const { code, stderr } = await runCli(
        ['a trivial task', '--agent', 'claude'],
        {
          cwd: tmpCwd,
          env: {
            ...process.env,
            ORCH_JOB_SLUG: slug,
            ORCH_DETACHED: '1',
            PATH: '/nonexistent-empty-path-for-tests',
          },
        },
      );
      assert.equal(code, 1);
      assert.match(
        stderr,
        /claude not found/i,
        'must reach the agent PATH check; otherwise the no-second-allocate assertion is vacuous',
      );

      const after = listJobs(tmpCwd);
      assert.equal(
        after.length,
        1,
        'child with ORCH_JOB_SLUG set must not create a second run.json / orch list entry',
      );
      assert.equal(after[0].slug, slug);
      assert.deepEqual(
        fs.readdirSync(path.join(tmpCwd, '.orch')).filter((name) =>
          fs.statSync(path.join(tmpCwd, '.orch', name)).isDirectory(),
        ),
        [slug],
      );
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
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

  it('lists the jobs delete subcommand', async () => {
    const { code, stdout } = await runCli(['jobs', '--help']);
    assert.equal(code, 0);
    assert.match(stdout, /\bdelete\b/);
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

  it('refuses before the confirm prompt when a live-pid job exists (non-zero, dirs untouched)', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-clean-live-');
    try {
      writeJob(tmpCwd, 'live-clean-0000', {
        slug: 'live-clean-0000',
        task: 'still running',
        agent: 'claude',
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        pid: process.pid,
      });
      writeJob(tmpCwd, 'done-clean-0001', {
        slug: 'done-clean-0001',
        task: 'finished',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
      });

      const { code, stdout, stderr } = await runCli(['jobs', 'clean'], {
        cwd: tmpCwd,
        stdin: 'y\n',
      });

      assert.notEqual(code, 0);
      const combined = `${stdout}\n${stderr}`;
      assert.match(combined, /live-clean-0000/);
      assert.match(combined, /orch stop/);
      // Live-job check must run before the confirm prompt so we never ask
      // to wipe dirs that we are about to refuse to delete.
      assert.equal(/Are you sure\? \[y\/N\]/.test(stdout), false);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'live-clean-0000', 'run.json')), true);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'done-clean-0001', 'run.json')), true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});

describe('orch jobs delete', () => {
  it('shows usage for jobs delete --help including --yes', async () => {
    const { code, stdout } = await runCli(['jobs', 'delete', '--help']);
    assert.equal(code, 0);
    assert.match(stdout, /delete/);
    assert.match(stdout, /<slug>/);
    assert.match(stdout, /--yes|-y/);
  });

  it('exits non-zero for an unknown slug without prompting', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-delete-missing-');
    try {
      const { code, stdout, stderr } = await runCli(
        ['jobs', 'delete', 'nobody-here-0000'],
        { cwd: tmpCwd, stdin: 'y\n' },
      );
      assert.notEqual(code, 0);
      const combined = `${stdout}\n${stderr}`;
      assert.match(combined, /nobody-here-0000/);
      assert.equal(/Are you sure\? \[y\/N\]/.test(stdout), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('aborts without deleting when the answer is N / empty', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-delete-abort-');
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
        worktree: null,
        branch: null,
      });

      const { code, stdout } = await runCli(
        ['jobs', 'delete', 'keep-me-0000'],
        { cwd: tmpCwd, stdin: '\n' },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Are you sure\? \[y\/N\]/);
      assert.match(stdout, /aborted/);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'keep-me-0000', 'run.json')), true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('deletes the named job when confirmed with y and leaves siblings', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-delete-yes-');
    try {
      writeJob(tmpCwd, 'drop-me-0000', {
        slug: 'drop-me-0000',
        task: 'drop',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
        worktree: null,
        branch: null,
      });
      writeJob(tmpCwd, 'keep-me-0001', {
        slug: 'keep-me-0001',
        task: 'keep',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
        worktree: null,
        branch: null,
      });

      const { code, stdout } = await runCli(
        ['jobs', 'delete', 'drop-me-0000'],
        { cwd: tmpCwd, stdin: 'y\n' },
      );
      assert.equal(code, 0);
      assert.match(stdout, /Are you sure\? \[y\/N\]/);
      assert.match(stdout, /deleted.*drop-me-0000|drop-me-0000.*deleted/i);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'drop-me-0000')), false);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'keep-me-0001', 'run.json')), true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('skips the confirm prompt with --yes', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-delete-flag-yes-');
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
        worktree: null,
        branch: null,
      });

      const { code, stdout } = await runCli(
        ['jobs', 'delete', 'wipe-me-0000', '--yes'],
        { cwd: tmpCwd },
      );
      assert.equal(code, 0);
      assert.equal(/Are you sure\? \[y\/N\]/.test(stdout), false);
      assert.match(stdout, /deleted.*wipe-me-0000|wipe-me-0000.*deleted/i);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'wipe-me-0000')), false);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('refuses a live-pid job before the confirm prompt (non-zero, dir untouched)', async () => {
    const tmpCwd = makeTmpCwd('orch-jobs-delete-live-');
    try {
      writeJob(tmpCwd, 'live-delete-0000', {
        slug: 'live-delete-0000',
        task: 'still running',
        agent: 'claude',
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        pid: process.pid,
        worktree: null,
        branch: null,
      });

      const { code, stdout, stderr } = await runCli(
        ['jobs', 'delete', 'live-delete-0000'],
        { cwd: tmpCwd, stdin: 'y\n' },
      );

      assert.notEqual(code, 0);
      const combined = `${stdout}\n${stderr}`;
      assert.match(combined, /live-delete-0000/);
      assert.match(combined, /orch stop/);
      assert.equal(/Are you sure\? \[y\/N\]/.test(stdout), false);
      assert.equal(fs.existsSync(path.join(tmpCwd, '.orch', 'live-delete-0000', 'run.json')), true);
    } finally {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  function initTmpGitRepo(prefix) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const repoDir = path.join(parent, 'repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
    return { parent, repoDir };
  }

  it('force-removes the recorded worktree and orch/<slug> branch with --yes', async () => {
    const { parent, repoDir } = initTmpGitRepo('orch-jobs-delete-wt-');
    const slug = 'cli-wt-0000';
    try {
      const created = createWorktree({ cwd: repoDir, slug });
      assert.ok(fs.existsSync(created.worktreePath));

      writeJob(repoDir, slug, {
        slug,
        task: 'had a worktree',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
        cwd: repoDir,
        worktree: created.worktreePath,
        branch: created.branch,
      });

      const { code, stdout } = await runCli(
        ['jobs', 'delete', slug, '--yes'],
        { cwd: repoDir },
      );

      assert.equal(code, 0);
      assert.match(stdout, new RegExp(`deleted.*${slug}|${slug}.*deleted`, 'i'));
      assert.equal(fs.existsSync(path.join(repoDir, '.orch', slug)), false);
      assert.equal(fs.existsSync(created.worktreePath), false);

      const branchList = execFileSync('git', ['branch', '--list', `orch/${slug}`], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      assert.equal(branchList.trim(), '');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      const leftover = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-${slug}`);
      fs.rmSync(leftover, { recursive: true, force: true });
    }
  });

  it('force-removes an on-disk createWorktree sibling when record.worktree is null', async () => {
    const { parent, repoDir } = initTmpGitRepo('orch-jobs-delete-sib-');
    const slug = 'cli-sib-0000';
    try {
      const created = createWorktree({ cwd: repoDir, slug });
      assert.ok(fs.existsSync(created.worktreePath));

      // Stale/ask-shaped record: no worktree/branch fields, but sibling still on disk.
      writeJob(repoDir, slug, {
        slug,
        task: 'orphan sibling',
        agent: 'claude',
        state: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        pid: process.pid,
        cwd: repoDir,
        worktree: null,
        branch: null,
      });

      const { code, stdout } = await runCli(
        ['jobs', 'delete', slug, '--yes'],
        { cwd: repoDir },
      );

      assert.equal(code, 0);
      assert.match(stdout, new RegExp(`deleted.*${slug}|${slug}.*deleted`, 'i'));
      assert.equal(fs.existsSync(path.join(repoDir, '.orch', slug)), false);
      assert.equal(fs.existsSync(created.worktreePath), false);

      const branchList = execFileSync('git', ['branch', '--list', `orch/${slug}`], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      assert.equal(branchList.trim(), '');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      const leftover = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-${slug}`);
      fs.rmSync(leftover, { recursive: true, force: true });
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
