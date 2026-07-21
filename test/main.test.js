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

  it('help output mentions --agent, --verbose, and --dry-run', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /--verbose/);
    assert.match(stdout, /--agent/);
    assert.match(stdout, /--dry-run/);
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

/** Builds a fake `AgentClass` that records construction order (and, per
 * instance, the options/prompt it was constructed with) and resolves
 * per-name canned results, so `runPipeline`'s branching can be tested without
 * spawning real agent CLIs. `order`, if given, is a shared array that also
 * receives a push for every construction — used to interleave agent
 * construction with createRunContext/createWorktree calls. */
function createMockAgentClass(behaviors, { order } = {}) {
  const instances = [];

  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
      instances.push(this);
      order?.push(name);
    }

    async run() {
      return behaviors[this.name] ?? { ok: true, result: '' };
    }
  }

  MockAgent.instances = instances;
  return MockAgent;
}

const COMPLEX_TRIAGE = { ok: true, result: JSON.stringify({ simple: false, why: 'needs research' }) };
const SIMPLE_TRIAGE = { ok: true, result: JSON.stringify({ simple: true, why: 'typo' }) };

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

describe('runPipeline nested implementer stages', () => {
  it('constructs test-writer then code-writer (not implementer) after planner', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass({
      triage: COMPLEX_TRIAGE,
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      'test-writer': { ok: true, result: 'worktree: /tmp/foo' },
      'code-writer': { ok: true, result: 'done' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => i.name),
      ['triage', 'research', 'planner', 'test-writer', 'code-writer'],
    );
  });

  it('skips code-writer and exits non-zero when test-writer resolves ok:false', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);
    const MockAgentClass = createMockAgentClass({
      triage: COMPLEX_TRIAGE,
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      'test-writer': { ok: false, result: 'not a git repository' },
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
      });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(
      MockAgentClass.instances.map((i) => i.name),
      ['triage', 'research', 'planner', 'test-writer'],
    );
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
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

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('fix the typo', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(order, ['triage', 'quick-fix']);
    assert.equal(createRunContextMock.mock.calls.length, 0);
    assert.equal(createWorktreeMock.mock.calls.length, 0);
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

    const MockAgentClass = createMockAgentClass(
      {
        triage: COMPLEX_TRIAGE,
        research: { ok: true, result: 'research-output' },
        planner: { ok: true, result: 'planner-output' },
        'test-writer': { ok: true, result: 'tests written' },
        'code-writer': { ok: true, result: 'done' },
      },
      { order },
    );

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: createRunContextMock,
        createWorktree: createWorktreeMock,
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
      'code-writer',
    ]);
    assert.equal(createRunContextMock.mock.calls.length, 1);
    assert.equal(createWorktreeMock.mock.calls.length, 1);

    const [triage, research, planner, testWriter, codeWriter] = MockAgentClass.instances;
    assert.equal(research.options?.cwd, invocationCwd);
    assert.equal(planner.options?.cwd, invocationCwd);
    assert.equal(testWriter.options?.cwd, worktree.worktreePath);
    assert.equal(codeWriter.options?.cwd, worktree.worktreePath);
  });

  it('research and planner prompts reference the exact absolute paths, not a <taskname> placeholder', async () => {
    const invocationCwd = process.cwd();
    const runContext = fakeRunContext(invocationCwd);
    const worktree = fakeWorktree(invocationCwd);

    const MockAgentClass = createMockAgentClass({
      triage: COMPLEX_TRIAGE,
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      'test-writer': { ok: true, result: 'tests written' },
      'code-writer': { ok: true, result: 'done' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
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

    const MockAgentClass = createMockAgentClass({
      triage: COMPLEX_TRIAGE,
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      // Deliberately does not mention the worktree path or branch in its
      // prose result, so code-writer can only have gotten them structurally.
      'test-writer': { ok: true, result: 'tests written, see status.md' },
      'code-writer': { ok: true, result: 'done' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', {
        agent: 'claude',
        AgentClass: MockAgentClass,
        createRunContext: mock.fn(() => runContext),
        createWorktree: mock.fn(() => worktree),
      });
    } finally {
      logSpy.mock.restore();
    }

    const [, , , , codeWriter] = MockAgentClass.instances;
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
      const MockAgentClass = createMockAgentClass({
        triage: COMPLEX_TRIAGE,
        research: { ok: true, result: 'research-output' },
        planner: { ok: true, result: 'planner-output' },
        'test-writer': { ok: true, result: 'tests written' },
        'code-writer': { ok: true, result: 'done' },
      });

      const RecordingAgentClass = class extends MockAgentClass {
        async run(...args) {
          if (this.name === 'test-writer' && fs.existsSync(runContext.statusPath)) {
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
