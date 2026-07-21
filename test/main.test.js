import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
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
  });

  it('accepts a multi-word positional task argument without an argument-parsing error', async () => {
    const { code, stderr } = await runCli(['fix', 'the', 'typo', '--agent', 'foo']);
    assert.notEqual(code, 0);
    assert.doesNotMatch(stderr, /missing required argument/i);
    assert.match(stderr, /cursor/);
    assert.match(stderr, /claude/);
  });
});

/** Builds a fake `AgentClass` that records construction order and resolves
 * per-name canned results, so `runPipeline`'s branching can be tested without
 * spawning real agent CLIs. */
function createMockAgentClass(behaviors) {
  const instances = [];

  class MockAgent {
    constructor(name) {
      this.name = name;
      instances.push(name);
    }

    async run() {
      return behaviors[this.name] ?? { ok: true, result: '' };
    }
  }

  MockAgent.instances = instances;
  return MockAgent;
}

describe('runPipeline nested implementer stages', () => {
  it('constructs test-writer then code-writer (not implementer) after planner', async () => {
    const MockAgentClass = createMockAgentClass({
      triage: { ok: true, result: JSON.stringify({ simple: false, why: 'needs research' }) },
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      'test-writer': { ok: true, result: 'worktree: /tmp/foo' },
      'code-writer': { ok: true, result: 'done' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runPipeline('do something complex', { agent: 'claude', AgentClass: MockAgentClass });
    } finally {
      logSpy.mock.restore();
    }

    assert.deepEqual(MockAgentClass.instances, [
      'triage',
      'research',
      'planner',
      'test-writer',
      'code-writer',
    ]);
  });

  it('skips code-writer and exits non-zero when test-writer resolves ok:false', async () => {
    const MockAgentClass = createMockAgentClass({
      triage: { ok: true, result: JSON.stringify({ simple: false, why: 'needs research' }) },
      research: { ok: true, result: 'research-output' },
      planner: { ok: true, result: 'planner-output' },
      'test-writer': { ok: false, result: 'not a git repository' },
    });

    const logSpy = mock.method(console, 'log', () => {});
    const errorSpy = mock.method(console, 'error', () => {});
    const exitSpy = mock.method(process, 'exit', () => {});
    try {
      await runPipeline('do something complex', { agent: 'claude', AgentClass: MockAgentClass });
    } finally {
      logSpy.mock.restore();
      errorSpy.mock.restore();
      exitSpy.mock.restore();
    }

    assert.deepEqual(MockAgentClass.instances, ['triage', 'research', 'planner', 'test-writer']);
    assert.equal(exitSpy.mock.calls.length, 1);
    assert.equal(exitSpy.mock.calls[0].arguments[0], 1);
  });
});
