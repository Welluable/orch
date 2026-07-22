import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function runCli(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd: path.join(__dirname, '..'),
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

describe('main.js CLI', () => {
  it('prints help for --help', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /The Orchestrator/);
    assert.match(stdout, /<task\.\.\.>/);
  });

  it('--help lists agn alongside cursor and claude', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /cursor/);
    assert.match(stdout, /claude/);
    assert.match(stdout, /agn/);
  });

  it('prints version for --version', async () => {
    const { code, stdout } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '1.0.0');
  });

  it('help output mentions --agent, --verbose, --dry-run, --max-rounds, --ask, and --quick', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--verbose/);
    assert.match(stdout, /--agent/);
    assert.match(stdout, /--dry-run/);
    assert.match(stdout, /--max-rounds/);
    assert.match(stdout, /--ask/);
    assert.match(stdout, /--quick/);
  });

  it('--dry-run reports readiness without running the pipeline', async () => {
    const { code, stdout, stderr } = await runCli(['noop', '--dry-run']);
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
  });

  it('accepts a multi-word positional task argument without an argument-parsing error', async () => {
    const { code, stderr } = await runCli(['fix', 'the', 'typo', '--agent', 'foo']);
    assert.notEqual(code, 0);
    assert.doesNotMatch(stderr, /missing required argument/i);
    assert.match(stderr, /cursor/);
    assert.match(stderr, /claude/);
    assert.match(stderr, /agn/);
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

const COMPLEX_TRIAGE = { ok: true, result: JSON.stringify({ simple: false, why: 'needs research' }) };
const SIMPLE_TRIAGE = { ok: true, result: JSON.stringify({ simple: true, why: 'typo' }) };
const PASS_CRITIC = {
  ok: true,
  result: JSON.stringify({ passed: true, summary: 'tests adequate' }),
};
const PASS_RUNNER = {
  ok: true,
  result: JSON.stringify({ passed: true, summary: 'suite green' }),
};
const FAIL_CRITIC = {
  ok: true,
  result: JSON.stringify({
    passed: false,
    summary: 'missing coverage',
    failures: ['no assert for max-rounds'],
  }),
};
const FAIL_RUNNER = {
  ok: true,
  result: JSON.stringify({
    passed: false,
    summary: 'tests failed',
    failures: ['parseVerdict missing'],
  }),
};

/** Default stubs for a complex path that passes both loops in one round. */
function complexPassBehaviors(overrides = {}) {
  return {
    triage: COMPLEX_TRIAGE,
    research: { ok: true, result: 'research-output' },
    planner: { ok: true, result: 'planner-output' },
    'test-writer': { ok: true, result: 'tests written' },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: 'done' },
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
});
