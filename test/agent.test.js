import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AgentCursor } from '../lib/agent-cursor.js';
import { AgentClaude } from '../lib/agent-claude.js';
import { AgentAgn } from '../lib/agent-agn.js';
import { formatElapsed, maybePrintModelLine, modelPrintState } from '../lib/agent.js';
import { formatToolStatus } from '../lib/tool-status.js';
import { parseTriageJson } from '../lib/parse-triage-json.js';
import { parseVerdict } from '../lib/parse-verdict.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const text = readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A stand-in ora spinner so settleResult() can run without a real TTY. */
function fakeSpinner() {
  return {
    isSpinning: true,
    succeed: mock.fn(),
    fail: mock.fn(),
  };
}

describe('formatElapsed', () => {
  it('formats whole seconds under a minute', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(45000), '45s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatElapsed(182000), '3m 2s');
  });
});

describe('parseTriageJson', () => {
  it('parses valid JSON with simple true', () => {
    const parsed = parseTriageJson('{"simple":true,"why":"typo","fix_plan":"fix it"}');
    assert.equal(parsed.simple, true);
    assert.equal(parsed.why, 'typo');
  });

  it('extracts JSON from markdown fences', () => {
    const parsed = parseTriageJson('```json\n{"simple":false,"why":"big"}\n```');
    assert.equal(parsed.simple, false);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseTriageJson('not json'), null);
    assert.equal(parseTriageJson(''), null);
    assert.equal(parseTriageJson(null), null);
  });
});

describe('parseVerdict', () => {
  it('parses a valid pass verdict', () => {
    assert.deepEqual(parseVerdict('{"passed":true,"summary":"looks good"}'), {
      passed: true,
      summary: 'looks good',
    });
  });

  it('parses a valid fail verdict with optional failures', () => {
    const verdict = parseVerdict(
      '{"passed":false,"summary":"gaps","failures":["missing assert on max-rounds"]}',
    );
    assert.equal(verdict.passed, false);
    assert.equal(verdict.summary, 'gaps');
    assert.deepEqual(verdict.failures, ['missing assert on max-rounds']);
  });

  it('extracts verdict JSON from markdown fences', () => {
    const verdict = parseVerdict('Here you go:\n```json\n{"passed":true,"summary":"ok"}\n```\n');
    assert.equal(verdict.passed, true);
    assert.equal(verdict.summary, 'ok');
  });

  it('extracts verdict JSON by slicing the first { to last }', () => {
    const verdict = parseVerdict('Verdict follows: {"passed":false,"summary":"weak"} end.');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.summary, 'weak');
  });

  it('treats missing, unparseable, or non-boolean passed as fail with unparseable verdict', () => {
    for (const input of [null, undefined, '', 'not json', '{"summary":"no passed field"}', '{"passed":"yes"}']) {
      assert.deepEqual(parseVerdict(input), {
        passed: false,
        summary: 'unparseable verdict',
      });
    }
  });
});


describe('AgentCursor', () => {
  it('builds Cursor spawn config', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'agent');
    assert.deepEqual(args, ['-p', '--force', '--output-format', 'stream-json', 'hello']);
  });

  it('ask/read-only mode uses --mode ask and omits --force', () => {
    const agent = new AgentCursor('ask', 'instr', 'prompt', { readOnly: true });
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'agent');
    assert.ok(args.includes('--mode'));
    assert.equal(args[args.indexOf('--mode') + 1], 'ask');
    assert.ok(!args.includes('--force'));
    assert.deepEqual(args, ['-p', '--mode', 'ask', '--output-format', 'stream-json', 'hello']);
  });

  it('write/default mode keeps -p --force --output-format stream-json unchanged', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt', { readOnly: false });
    const { args } = agent.getSpawnConfig('hello');
    assert.deepEqual(args, ['-p', '--force', '--output-format', 'stream-json', 'hello']);
  });

  it('defaults spawn cwd to process.cwd() when no cwd option is given', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, process.cwd());
  });

  it('uses an explicit cwd option for the spawn config', () => {
    const agent = new AgentCursor('code-writer', 'instr', 'prompt', { cwd: '/tmp/some-worktree' });
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, '/tmp/some-worktree');
  });
});

describe('AgentClaude', () => {
  it('builds Claude spawn config with stream-json verbose', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'claude');
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('stream-json'));
    assert.equal(args[args.length - 1], 'hello');
  });

  it('ask/read-only mode uses --permission-mode plan and omits --dangerously-skip-permissions', () => {
    const agent = new AgentClaude('ask', 'instr', 'prompt', { readOnly: true });
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'claude');
    assert.ok(args.includes('--permission-mode'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.length - 1], 'hello');
  });

  it('write/default mode keeps --dangerously-skip-permissions and omits --permission-mode', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt', { readOnly: false });
    const { args } = agent.getSpawnConfig('hello');
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--permission-mode'));
    assert.deepEqual(args, [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      'hello',
    ]);
  });

  it('defaults spawn cwd to process.cwd() when no cwd option is given', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, process.cwd());
  });

  it('uses an explicit cwd option for the spawn config', () => {
    const agent = new AgentClaude('test-writer', 'instr', 'prompt', { cwd: '/tmp/some-worktree' });
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, '/tmp/some-worktree');
  });

  it('maps assistant tool_use to formatToolStatus', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }],
        },
      },
      { verbose: false, finish: mock.fn() },
    );

    assert.equal(statuses.length, 1);
    assert.match(statuses[0], /Running:/);
  });

  it('maps system init to connected', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      { type: 'system', subtype: 'hook_started' },
      { verbose: false, finish: mock.fn() },
    );
    agent.handleStreamEvent(
      { type: 'system', subtype: 'init' },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, ['connected']);
  });
});

describe('AgentAgn', () => {
  it('builds agn spawn config with exact args, prompt last', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'agn');
    assert.deepEqual(args, ['-p', '--output-format', 'stream-json', 'hello']);
  });

  it('ask/read-only mode keeps argv unchanged (no CLI read-only flag; prompt-only limitation)', () => {
    const agent = new AgentAgn('ask', 'instr', 'prompt', { readOnly: true });
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'agn');
    assert.deepEqual(args, ['-p', '--output-format', 'stream-json', 'hello']);
  });

  it('does not add --stream-partial-output, a permission-bypass flag, or a model flag', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const { args } = agent.getSpawnConfig('hello');
    assert.equal(args.length, 4);
    assert.ok(!args.includes('--stream-partial-output'));
    assert.ok(!args.some((a) => /model/i.test(a)));
    assert.ok(!args.some((a) => /permission/i.test(a)));
  });

  it('defaults spawn cwd to process.cwd() when no cwd option is given', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, process.cwd());
  });

  it('uses an explicit cwd option for the spawn config', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt', { cwd: '/tmp/some-worktree' });
    const { options } = agent.getSpawnConfig('hello');
    assert.equal(options.cwd, '/tmp/some-worktree');
  });

  it('uses the same stdio/env spawn options shape as the other backends', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const { options } = agent.getSpawnConfig('hello');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env, process.env);
  });

  it('sets connected only for system/init, not other system subtypes', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      { type: 'system', subtype: 'other' },
      { verbose: false, finish: mock.fn() },
    );
    agent.handleStreamEvent(
      { type: 'system', subtype: 'init' },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, ['connected']);
  });

  it('ignores user events', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, []);
  });

  it('sets composing response… on a full assistant segment when no tool is active', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      { type: 'assistant', message: { role: 'assistant', content: 'partial answer' } },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, ['composing response…']);
  });

  it('does not set composing response… on assistant when a tool is active', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);
    agent.activeTools.set('a-1', { name: 'read', args: {} });

    agent.handleStreamEvent(
      { type: 'assistant', message: { role: 'assistant', content: 'partial answer' } },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, []);
  });

  it('assistant/delta in verbose mode writes the delta text to stderr instead of setStatus', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);
    const writes = [];
    const restore = mock.method(process.stderr, 'write', (chunk) => {
      writes.push(chunk);
      return true;
    });

    agent.handleStreamEvent(
      { type: 'assistant', subtype: 'delta', text: 'partial text' },
      { verbose: true, finish: mock.fn() },
    );

    restore.mock.restore();
    assert.deepEqual(writes, ['partial text']);
    assert.deepEqual(statuses, []);
  });

  it('assistant/delta in non-verbose mode sets thinking… when no tool is active', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.handleStreamEvent(
      { type: 'assistant', subtype: 'delta', text: 'partial text' },
      { verbose: false, finish: mock.fn() },
    );

    assert.deepEqual(statuses, ['thinking…']);
  });

  it('tool_call started/completed lifecycle: normalizes via normalizeAgnToolEvent and drives onToolEvent', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt');
    const [started] = loadFixture('agn-tool-read-started.jsonl');
    const [completed] = loadFixture('agn-tool-read-completed.jsonl');

    agent.handleStreamEvent(started, { verbose: false, finish: mock.fn() });
    assert.equal(agent.activeTools.size, 1);
    assert.deepEqual(agent.activeTools.get('a-1'), {
      name: 'read',
      args: { path: 'lib/agent.js' },
    });

    agent.handleStreamEvent(completed, { verbose: false, finish: mock.fn() });
    assert.equal(agent.activeTools.size, 0);
  });

  it('result/success settles ok:true with the event result text', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt');
    agent.spinner = fakeSpinner();
    agent.startedAt = Date.now();
    const finish = mock.fn();

    agent.handleStreamEvent(
      { type: 'result', subtype: 'success', result: 'done', iterations: 2, is_error: false },
      { verbose: false, finish },
    );

    assert.equal(finish.mock.calls.length, 1);
    const [err, value] = finish.mock.calls[0].arguments;
    assert.equal(err, null);
    assert.equal(value.ok, true);
    assert.equal(value.result, 'done');
  });

  it('result/max_iterations settles ok:false, preserving event.result', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt');
    agent.spinner = fakeSpinner();
    agent.startedAt = Date.now();
    const finish = mock.fn();
    const [, maxIterationsEvent] = loadFixture('agn-result-error.jsonl');

    agent.handleStreamEvent(maxIterationsEvent, { verbose: false, finish });

    assert.equal(finish.mock.calls.length, 1);
    const [err, value] = finish.mock.calls[0].arguments;
    assert.equal(err, null);
    assert.equal(value.ok, false);
    assert.equal(value.result, 'reached max iterations');
  });

  it('result/error settles ok:false, using event.error as the result text', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt');
    agent.spinner = fakeSpinner();
    agent.startedAt = Date.now();
    const finish = mock.fn();
    const [errorEvent] = loadFixture('agn-result-error.jsonl');

    agent.handleStreamEvent(errorEvent, { verbose: false, finish });

    assert.equal(finish.mock.calls.length, 1);
    const [err, value] = finish.mock.calls[0].arguments;
    assert.equal(err, null);
    assert.equal(value.ok, false);
    assert.equal(value.result, 'agn config missing API key');
  });

  it('ignores unknown event types (no status change, no finish call)', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);
    const finish = mock.fn();

    agent.handleStreamEvent({ type: 'rate_limit_event' }, { verbose: false, finish });

    assert.deepEqual(statuses, []);
    assert.equal(finish.mock.calls.length, 0);
  });
});

describe('maybePrintModelLine', () => {
  beforeEach(() => {
    modelPrintState.printed = false;
  });

  it('prints exactly one model: line for the first init with a model', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (msg) => logs.push(msg));

    maybePrintModelLine({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }, null);

    restore.mock.restore();
    assert.deepEqual(logs, ['model: claude-sonnet-5']);
    assert.equal(modelPrintState.printed, true);
  });

  it('does not print again for a second agent\'s init', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (msg) => logs.push(msg));

    maybePrintModelLine({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }, null);
    maybePrintModelLine({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }, null);

    restore.mock.restore();
    assert.deepEqual(logs, ['model: claude-sonnet-5']);
  });

  it('prints nothing when init has no model', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (msg) => logs.push(msg));

    maybePrintModelLine({ type: 'system', subtype: 'init' }, null);

    restore.mock.restore();
    assert.deepEqual(logs, []);
    assert.equal(modelPrintState.printed, false);
  });

  it('pauses and resumes a spinning spinner around the print', () => {
    const calls = [];
    const spinner = {
      isSpinning: true,
      stop: () => calls.push('stop'),
      start: () => calls.push('start'),
    };
    const restore = mock.method(console, 'log', () => {});

    maybePrintModelLine({ type: 'system', subtype: 'init', model: 'Auto' }, spinner);

    restore.mock.restore();
    assert.deepEqual(calls, ['stop', 'start']);
  });
});

describe('formatToolStatus', () => {
  it('maps Claude Bash and Edit names', () => {
    assert.match(
      formatToolStatus({ name: 'bash', args: { command: 'ls -la' } }),
      /Running:/,
    );
    assert.match(
      formatToolStatus({ name: 'edit', args: { path: 'a.js' } }),
      /Editing a\.js/,
    );
  });
});
