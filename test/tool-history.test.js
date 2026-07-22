import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Agent } from '../lib/agent.js';
import { AgentClaude } from '../lib/agent-claude.js';
import { AgentCursor } from '../lib/agent-cursor.js';
import { AgentAgn } from '../lib/agent-agn.js';

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

/** Runs `fn` with process.stdout.isTTY forced to `value`, restoring it after. */
function withTTY(value, fn) {
  const original = process.stdout.isTTY;
  process.stdout.isTTY = value;
  try {
    return fn();
  } finally {
    process.stdout.isTTY = original;
  }
}

describe('Agent history buffer (tool events)', () => {
  it('a start/complete pair pushes one { kind: "tool" } entry with a durationMs', async () => {
    const agent = new Agent('code-writer', 'instr', 'prompt');
    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'started', callId: 'c-1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'completed', callId: 'c-1' });

    assert.equal(agent.historyEntries.length, 1);
    const [entry] = agent.historyEntries;
    assert.equal(entry.kind, 'tool');
    assert.equal(entry.name, 'Read');
    assert.deepEqual(entry.args, { path: 'a.js' });
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(entry.durationMs >= 0);
  });

  it('N start/complete pairs produce N history entries, in completion order', () => {
    const agent = new Agent('code-writer', 'instr', 'prompt');

    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'started', callId: 'c-1' });
    agent.onToolEvent({ name: 'Shell', args: { command: 'npm test' }, phase: 'started', callId: 'c-2' });
    agent.onToolEvent({ name: 'Write', args: { path: 'b.js' }, phase: 'started', callId: 'c-3' });

    // Complete out of start order: c-2, then c-1, then c-3.
    agent.onToolEvent({ name: 'Shell', args: {}, phase: 'completed', callId: 'c-2' });
    agent.onToolEvent({ name: 'Read', args: {}, phase: 'completed', callId: 'c-1' });
    agent.onToolEvent({ name: 'Write', args: {}, phase: 'completed', callId: 'c-3' });

    assert.equal(agent.historyEntries.length, 3);
    assert.deepEqual(
      agent.historyEntries.map((e) => e.name),
      ['Shell', 'Read', 'Write'],
    );
    agent.historyEntries.forEach((e) => {
      assert.equal(e.kind, 'tool');
      assert.equal(typeof e.durationMs, 'number');
    });
  });

  it('a "started" phase alone does not push a history entry', () => {
    const agent = new Agent('code-writer', 'instr', 'prompt');
    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'started', callId: 'c-1' });
    assert.equal(agent.historyEntries.length, 0);
  });
});

describe('Agent thinking span helpers', () => {
  it('startThinking then endThinking pushes one { kind: "thinking" } entry with a durationMs', async () => {
    const agent = new Agent('research', 'instr', 'prompt');
    agent.startThinking();
    assert.ok(agent.thinkingStartedAt != null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    agent.endThinking();

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.length, 1);
    const [entry] = agent.historyEntries;
    assert.equal(entry.kind, 'thinking');
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(entry.durationMs >= 0);
  });

  it('calling startThinking twice without an intervening endThinking keeps the first start time (no-op)', () => {
    const agent = new Agent('research', 'instr', 'prompt');
    agent.startThinking();
    const firstStart = agent.thinkingStartedAt;
    agent.startThinking();

    assert.equal(agent.thinkingStartedAt, firstStart);

    agent.endThinking();
    assert.equal(agent.historyEntries.length, 1);
  });

  it('calling endThinking with no open span is a no-op', () => {
    const agent = new Agent('research', 'instr', 'prompt');
    agent.endThinking();
    assert.equal(agent.historyEntries.length, 0);
    assert.equal(agent.thinkingStartedAt, null);
  });

  it('multiple think -> tool -> think stretches produce multiple thinking entries', () => {
    const agent = new Agent('research', 'instr', 'prompt');

    agent.startThinking();
    agent.endThinking();

    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'started', callId: 'c-1' });
    agent.onToolEvent({ name: 'Read', args: {}, phase: 'completed', callId: 'c-1' });

    agent.startThinking();
    agent.endThinking();

    const thinkingEntries = agent.historyEntries.filter((e) => e.kind === 'thinking');
    const toolEntries = agent.historyEntries.filter((e) => e.kind === 'tool');
    assert.equal(thinkingEntries.length, 2);
    assert.equal(toolEntries.length, 1);
  });
});

describe('Agent.printHistory', () => {
  it('prints nothing when historyEntries is empty', () => {
    withTTY(true, () => {
      const agent = new Agent('research', 'instr', 'prompt');
      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      agent.printHistory();
      restore.mock.restore();
      assert.deepEqual(logs, []);
    });
  });

  it('prints each entry indented by exactly two spaces, in buffer order', () => {
    withTTY(true, () => {
      const agent = new Agent('research', 'instr', 'prompt');
      agent.historyEntries.push(
        { kind: 'thinking', durationMs: 3000 },
        { kind: 'tool', name: 'Read', args: { path: 'a.js' }, durationMs: 200 },
      );

      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      agent.printHistory();
      restore.mock.restore();

      assert.equal(logs.length, 2);
      assert.equal(logs[0], '  Thought for 3s');
      assert.ok(logs[1].startsWith('  '));
      assert.match(logs[1], /a\.js/);
      // Indentation is exactly two spaces, not more.
      assert.notEqual(logs[1][2], ' ');
    });
  });

  it('is a no-op when process.stdout.isTTY is falsy (non-TTY/CI)', () => {
    withTTY(false, () => {
      const agent = new Agent('research', 'instr', 'prompt');
      agent.historyEntries.push({ kind: 'thinking', durationMs: 3000 });

      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      agent.printHistory();
      restore.mock.restore();

      assert.deepEqual(logs, []);
    });
  });
});

describe('Agent.settleResult history flush', () => {
  it('succeed path: prints the succeed message, then history lines in order, then clears the buffer', () => {
    withTTY(true, () => {
      const agent = new Agent('code-writer', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();
      agent.historyEntries.push(
        { kind: 'thinking', durationMs: 2000 },
        { kind: 'tool', name: 'Write', args: { path: 'a.js' }, durationMs: 500 },
      );

      const order = [];
      agent.spinner.succeed = mock.fn(() => order.push('succeed'));
      const logs = [];
      const restore = mock.method(console, 'log', (msg) => {
        order.push('log');
        logs.push(msg);
      });

      const finish = mock.fn();
      agent.settleResult({ is_error: false, result: 'ok', duration_ms: 10 }, finish);
      restore.mock.restore();

      assert.equal(agent.spinner.succeed.mock.calls.length, 1);
      assert.deepEqual(order, ['succeed', 'log', 'log']);
      assert.equal(logs.length, 2);
      assert.equal(logs[0], '  Thought for 2s');
      assert.match(logs[1], /a\.js/);
      assert.deepEqual(agent.historyEntries, []);
      assert.equal(finish.mock.calls.length, 1);
      const [err, value] = finish.mock.calls[0].arguments;
      assert.equal(err, null);
      assert.equal(value.ok, true);
    });
  });

  it('fail path: also flushes history after the fail line, then clears the buffer', () => {
    withTTY(true, () => {
      const agent = new Agent('code-writer', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();
      agent.historyEntries.push({ kind: 'tool', name: 'Read', args: { path: 'b.js' }, durationMs: 300 });

      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      const finish = mock.fn();
      agent.settleResult({ is_error: true, result: 'boom', duration_ms: 10 }, finish);
      restore.mock.restore();

      assert.equal(agent.spinner.fail.mock.calls.length, 1);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /b\.js/);
      assert.deepEqual(agent.historyEntries, []);
      assert.equal(finish.mock.calls.length, 1);
      const [, value] = finish.mock.calls[0].arguments;
      assert.equal(value.ok, false);
    });
  });

  it('empty historyEntries: prints no extra lines after the succeed line', () => {
    withTTY(true, () => {
      const agent = new Agent('research', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();

      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      agent.settleResult({ is_error: false, result: 'ok', duration_ms: 10 }, mock.fn());
      restore.mock.restore();

      assert.deepEqual(logs, []);
    });
  });

  it('clears any dangling open thinking-span state on settle', () => {
    withTTY(true, () => {
      const agent = new Agent('code-writer', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();
      agent.startThinking(); // never explicitly ended before settle

      agent.settleResult({ is_error: false, result: 'ok', duration_ms: 10 }, mock.fn());

      assert.equal(agent.thinkingStartedAt, null);
    });
  });

  it('is a no-op for printing in non-TTY environments (stage line only)', () => {
    withTTY(false, () => {
      const agent = new Agent('code-writer', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();
      agent.historyEntries.push({ kind: 'tool', name: 'Read', args: { path: 'a.js' }, durationMs: 2000 });

      const logs = [];
      const restore = mock.method(console, 'log', (msg) => logs.push(msg));
      agent.settleResult({ is_error: false, result: 'ok', duration_ms: 10 }, mock.fn());
      restore.mock.restore();

      assert.deepEqual(logs, []);
      // The buffer is still cleared even though nothing was printed.
      assert.deepEqual(agent.historyEntries, []);
    });
  });

  it('does not disturb existing activeTools clearing / elapsed timer stop ordering', () => {
    withTTY(true, () => {
      const agent = new Agent('code-writer', 'instr', 'prompt');
      agent.spinner = fakeSpinner();
      agent.startedAt = Date.now();
      agent.activeTools.set('c-1', { name: 'Read', args: {} });

      agent.settleResult({ is_error: false, result: 'ok', duration_ms: 10 }, mock.fn());

      assert.equal(agent.activeTools.size, 0);
      assert.equal(agent.elapsedTimer, null);
    });
  });
});

describe('AgentClaude thinking span wiring', () => {
  it('an assistant compose event (no tool blocks, no active tools) starts a thinking span', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { verbose: false, finish: mock.fn() },
    );
    assert.ok(agent.thinkingStartedAt != null);
  });

  it('repeated compose events do not open a second span (idempotent)', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'assistant', message: { content: [] } },
      { verbose: false, finish: mock.fn() },
    );
    const firstStart = agent.thinkingStartedAt;
    agent.handleStreamEvent(
      { type: 'assistant', message: { content: [] } },
      { verbose: false, finish: mock.fn() },
    );
    assert.equal(agent.thinkingStartedAt, firstStart);
  });

  it('the first tool_use ends an open thinking span and records one thinking history entry', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { verbose: false, finish: mock.fn() },
    );

    const [toolEvent] = loadFixture('claude-assistant-bash.jsonl');
    agent.handleStreamEvent(toolEvent, { verbose: false, finish: mock.fn() });

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.filter((e) => e.kind === 'thinking').length, 1);
  });

  it('result settling ends a still-open thinking span (approximated for Claude)', () => {
    const agent = new AgentClaude('research', 'instr', 'prompt');
    agent.spinner = fakeSpinner();
    agent.startedAt = Date.now();
    agent.handleStreamEvent(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { verbose: false, finish: mock.fn() },
    );

    withTTY(false, () => {
      agent.handleStreamEvent(
        { type: 'result', is_error: false, result: 'ok', duration_ms: 10 },
        { verbose: false, finish: mock.fn() },
      );
    });

    assert.equal(agent.thinkingStartedAt, null);
  });
});

describe('AgentCursor thinking span wiring', () => {
  it('thinking/delta starts a thinking span', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );
    assert.ok(agent.thinkingStartedAt != null);
  });

  it('thinking/completed ends the span and records one thinking history entry', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );
    agent.handleStreamEvent({ type: 'thinking', subtype: 'completed' }, { verbose: false, finish: mock.fn() });

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.filter((e) => e.kind === 'thinking').length, 1);
  });

  it('a tool start ends an open thinking span even without an explicit thinking/completed', () => {
    const agent = new AgentCursor('code-writer', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );

    const [started] = loadFixture('cursor-tool-write-started.jsonl');
    agent.handleStreamEvent(started, { verbose: false, finish: mock.fn() });

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.filter((e) => e.kind === 'thinking').length, 1);
  });

  it('repeated thinking/delta events do not open a second span (idempotent)', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'a' },
      { verbose: false, finish: mock.fn() },
    );
    const firstStart = agent.thinkingStartedAt;
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'b' },
      { verbose: false, finish: mock.fn() },
    );
    assert.equal(agent.thinkingStartedAt, firstStart);
  });

  it('an assistant compose event also ends an open thinking span', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'thinking', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );
    agent.handleStreamEvent({ type: 'assistant' }, { verbose: false, finish: mock.fn() });

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.filter((e) => e.kind === 'thinking').length, 1);
  });
});

describe('AgentAgn thinking span wiring', () => {
  it('assistant/delta (no active tools) starts a thinking span', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'assistant', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );
    assert.ok(agent.thinkingStartedAt != null);
  });

  it('the first tool_call started ends the span and records one thinking history entry', () => {
    const agent = new AgentAgn('code-writer', 'instr', 'prompt');
    agent.handleStreamEvent(
      { type: 'assistant', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );

    const [started] = loadFixture('agn-tool-read-started.jsonl');
    agent.handleStreamEvent(started, { verbose: false, finish: mock.fn() });

    assert.equal(agent.thinkingStartedAt, null);
    assert.equal(agent.historyEntries.filter((e) => e.kind === 'thinking').length, 1);
  });

  it('result settling ends a still-open thinking span', () => {
    const agent = new AgentAgn('research', 'instr', 'prompt');
    agent.spinner = fakeSpinner();
    agent.startedAt = Date.now();
    agent.handleStreamEvent(
      { type: 'assistant', subtype: 'delta', text: 'hmm' },
      { verbose: false, finish: mock.fn() },
    );

    withTTY(false, () => {
      agent.handleStreamEvent(
        { type: 'result', subtype: 'success', result: 'done', is_error: false },
        { verbose: false, finish: mock.fn() },
      );
    });

    assert.equal(agent.thinkingStartedAt, null);
  });
});
