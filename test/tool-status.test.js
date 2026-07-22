import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  formatToolStatus,
  formatActiveTools,
  normalizeCursorToolEvent,
  normalizeClaudeToolEvent,
  normalizeAgnToolEvent,
  claudeToolFormatterKey,
  truncate,
  basename,
  formatArgPreview,
} from '../lib/tool-status.js';
import { Agent } from '../lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const text = readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('formatToolStatus', () => {
  it('formats grep', () => {
    assert.match(formatToolStatus({ name: 'grep', args: { pattern: 'foo' } }), /Searching: foo/);
  });

  it('formats read', () => {
    assert.match(formatToolStatus({ name: 'read', args: { path: 'lib/a.js' } }), /Reading a\.js/);
  });

  it('formats write (path only, never body content)', () => {
    const text = formatToolStatus({
      name: 'write',
      args: { path: 'a.js', fileText: 'secret body' },
    });
    assert.match(text, /Writing a\.js/);
    assert.doesNotMatch(text, /secret body/);
  });

  it('formats edit (path only, never body content)', () => {
    const text = formatToolStatus({
      name: 'edit',
      args: { path: 'a.js', fileText: 'secret body' },
    });
    assert.match(text, /Editing a\.js/);
    assert.doesNotMatch(text, /secret body/);
  });

  it('formats delete', () => {
    assert.match(formatToolStatus({ name: 'delete', args: { path: 'a.js' } }), /Deleting a\.js/);
  });

  it('formats ls', () => {
    assert.match(formatToolStatus({ name: 'ls', args: { path: 'lib' } }), /Listing lib/);
  });

  it('formats glob', () => {
    assert.match(
      formatToolStatus({ name: 'glob', args: { pattern: '**/*.js' } }),
      /Finding: \*\*\/\*\.js/,
    );
  });

  it('formats shell', () => {
    assert.match(formatToolStatus({ name: 'shell', args: { command: 'npm test' } }), /Running: npm test/);
  });

  it('formats websearch', () => {
    assert.match(
      formatToolStatus({ name: 'websearch', args: { query: 'node test runner' } }),
      /Searching web: node test runner/,
    );
  });

  it('formats task', () => {
    assert.match(
      formatToolStatus({ name: 'task', args: { description: 'run subagent' } }),
      /Running subagent: run subagent/,
    );
  });

  it('falls back to Running <name>(args) for unknown tools', () => {
    assert.equal(
      formatToolStatus({ name: 'CustomTool', args: { path: 'foo' } }),
      'Running CustomTool(path=foo)…',
    );
  });

  it('falls back to Running <name> for unknown tools with no scalar args', () => {
    assert.equal(formatToolStatus({ name: 'CustomTool', args: {} }), 'Running CustomTool…');
  });
});

describe('formatToolStatus file_path fallback (bug fix)', () => {
  it('write resolves file_path when path is absent', () => {
    assert.match(formatToolStatus({ name: 'write', args: { file_path: 'lib/a.js' } }), /Writing a\.js/);
  });

  it('edit resolves file_path when path is absent', () => {
    assert.match(formatToolStatus({ name: 'edit', args: { file_path: 'lib/a.js' } }), /Editing a\.js/);
  });

  it('delete resolves file_path when path is absent', () => {
    assert.match(formatToolStatus({ name: 'delete', args: { file_path: 'lib/a.js' } }), /Deleting a\.js/);
  });

  it('still prefers path over file_path when both are present', () => {
    assert.match(
      formatToolStatus({ name: 'write', args: { path: 'p.js', file_path: 'f.js' } }),
      /Writing p\.js/,
    );
  });

  it('falls back to "file" when neither path nor file_path is present', () => {
    assert.match(formatToolStatus({ name: 'edit', args: {} }), /Editing file/);
  });
});

describe('claudeToolFormatterKey', () => {
  it('maps MultiEdit to the edit formatter key', () => {
    assert.equal(claudeToolFormatterKey('MultiEdit'), 'edit');
  });

  it('still maps Read/Write/Edit/Bash as before', () => {
    assert.equal(claudeToolFormatterKey('Read'), 'read');
    assert.equal(claudeToolFormatterKey('Write'), 'write');
    assert.equal(claudeToolFormatterKey('Edit'), 'edit');
    assert.equal(claudeToolFormatterKey('Bash'), 'shell');
  });
});

describe('helpers', () => {
  it('truncate leaves short strings untouched', () => {
    assert.equal(truncate('abc', 10), 'abc');
  });

  it('truncate cuts long strings with an ellipsis', () => {
    assert.equal(truncate('a'.repeat(50), 10), `${'a'.repeat(10)}…`);
  });

  it('basename returns the last path segment', () => {
    assert.equal(basename('lib/a/b.js'), 'b.js');
    assert.equal(basename('file.js'), 'file.js');
  });

  it('formatArgPreview picks 1-2 short scalar args', () => {
    assert.equal(formatArgPreview({ path: 'foo', count: 3, nested: { x: 1 } }), 'path=foo, count=3');
    assert.equal(formatArgPreview({}), '');
  });
});

describe('normalizeCursorToolEvent', () => {
  it('returns null for non-tool_call events', () => {
    assert.equal(normalizeCursorToolEvent({ type: 'assistant' }), null);
  });

  it('normalizes readToolCall from fixture', () => {
    const [started, completed] = loadFixture('cursor-tool-read-started.jsonl');
    assert.deepEqual(normalizeCursorToolEvent(started), {
      name: 'Read',
      args: { path: 'lib/agent.js' },
      phase: 'started',
      callId: 'c-1',
    });
    assert.equal(normalizeCursorToolEvent(completed).phase, 'completed');
  });

  it('normalizes shellToolCall from fixture', () => {
    const [started] = loadFixture('cursor-tool-shell-started.jsonl');
    assert.deepEqual(normalizeCursorToolEvent(started), {
      name: 'Shell',
      args: { command: 'npm test' },
      phase: 'started',
      callId: 'c-2',
    });
  });

  it('normalizes function tool calls', () => {
    const event = {
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c-9',
      tool_call: { function: { name: 'my_mcp_tool', arguments: '{"foo":"bar"}' } },
    };
    assert.deepEqual(normalizeCursorToolEvent(event), {
      name: 'my_mcp_tool',
      args: { foo: 'bar' },
      phase: 'started',
      callId: 'c-9',
    });
  });

  it('falls back to stripped key name for unknown tool call shapes', () => {
    const event = {
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c-10',
      tool_call: { fooToolCall: { args: { a: 1 } } },
    };
    assert.equal(normalizeCursorToolEvent(event).name, 'foo');
  });

  it('normalizes writeToolCall (path arg) from fixture', () => {
    const [started, completed] = loadFixture('cursor-tool-write-started.jsonl');
    assert.deepEqual(normalizeCursorToolEvent(started), {
      name: 'Write',
      args: { path: 'lib/agent.js', fileText: 'secret body' },
      phase: 'started',
      callId: 'c-6',
    });
    assert.equal(normalizeCursorToolEvent(completed).phase, 'completed');
  });
});

describe('normalizeClaudeToolEvent', () => {
  it('normalizes a single tool_use block from fixture', () => {
    const [event] = loadFixture('claude-assistant-bash.jsonl');
    const events = normalizeClaudeToolEvent(event);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      name: 'shell',
      args: { command: 'npm test' },
      phase: 'started',
      callId: 'toolu_1',
    });
  });

  it('normalizes multiple tool_use blocks in one assistant message', () => {
    const event = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't-1', name: 'Read', input: { path: 'a.js' } },
          { type: 'tool_use', id: 't-2', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    };
    const events = normalizeClaudeToolEvent(event);
    assert.equal(events.length, 2);
    assert.equal(events[0].name, 'read');
    assert.equal(events[1].name, 'grep');
  });

  it('normalizes a tool_result from fixture as completed', () => {
    const [event] = loadFixture('claude-tool-result.jsonl');
    const events = normalizeClaudeToolEvent(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'completed');
    assert.equal(events[0].callId, 'toolu_1');
  });

  it('returns empty array for unrelated event types', () => {
    assert.deepEqual(normalizeClaudeToolEvent({ type: 'system', subtype: 'init' }), []);
  });

  it('normalizes Write with file_path from fixture, resolving to a basename on the live spinner', () => {
    const [event] = loadFixture('claude-assistant-write.jsonl');
    const events = normalizeClaudeToolEvent(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'write');
    assert.equal(events[0].callId, 'toolu_2');

    const text = formatToolStatus(events[0]);
    assert.match(text, /Writing agent\.js/);
    assert.doesNotMatch(text, /secret body/);
  });

  it('normalizes MultiEdit to the edit formatter key from fixture', () => {
    const [event] = loadFixture('claude-assistant-multiedit.jsonl');
    const events = normalizeClaudeToolEvent(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'edit');
    assert.equal(events[0].callId, 'toolu_3');
  });

  it('MultiEdit renders as Editing … on the live spinner, not Running MultiEdit…', () => {
    const [event] = loadFixture('claude-assistant-multiedit.jsonl');
    const [toolEvent] = normalizeClaudeToolEvent(event);
    const text = formatToolStatus(toolEvent);
    assert.match(text, /Editing tool-status\.js/);
    assert.doesNotMatch(text, /MultiEdit/);
  });
});

describe('normalizeAgnToolEvent', () => {
  it('returns null for non-tool_call events', () => {
    assert.equal(normalizeAgnToolEvent({ type: 'assistant' }), null);
    assert.equal(normalizeAgnToolEvent({ type: 'system', subtype: 'init' }), null);
  });

  it('returns null for a tool_call with an invalid subtype', () => {
    assert.equal(
      normalizeAgnToolEvent({ type: 'tool_call', subtype: 'progress', call_id: 'a-1', name: 'read_file' }),
      null,
    );
  });

  it('returns null when call_id is missing or not a non-empty string', () => {
    assert.equal(
      normalizeAgnToolEvent({ type: 'tool_call', subtype: 'started', name: 'read_file' }),
      null,
    );
    assert.equal(
      normalizeAgnToolEvent({ type: 'tool_call', subtype: 'started', call_id: '', name: 'read_file' }),
      null,
    );
    assert.equal(
      normalizeAgnToolEvent({ type: 'tool_call', subtype: 'started', call_id: 42, name: 'read_file' }),
      null,
    );
  });

  it('normalizes a started tool_call from fixture, canonicalizing read_file to read', () => {
    const [started] = loadFixture('agn-tool-read-started.jsonl');
    assert.deepEqual(normalizeAgnToolEvent(started), {
      name: 'read',
      args: { path: 'lib/agent.js' },
      phase: 'started',
      callId: 'a-1',
    });
  });

  it('normalizes a completed tool_call from fixture with empty args and matching call_id', () => {
    const [completed] = loadFixture('agn-tool-read-completed.jsonl');
    assert.deepEqual(normalizeAgnToolEvent(completed), {
      name: 'read',
      args: {},
      phase: 'completed',
      callId: 'a-1',
    });
  });

  it('canonicalizes write_file to write and patch to edit', () => {
    assert.equal(
      normalizeAgnToolEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'a-2',
        name: 'write_file',
        input: { path: 'a.js' },
      }).name,
      'write',
    );
    assert.equal(
      normalizeAgnToolEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'a-3',
        name: 'patch',
        input: { path: 'a.js' },
      }).name,
      'edit',
    );
  });

  it('leaves unmapped tool names (e.g. read_skill, shell) unchanged', () => {
    assert.equal(
      normalizeAgnToolEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'a-4',
        name: 'read_skill',
        input: { name: 'foo' },
      }).name,
      'read_skill',
    );
    assert.equal(
      normalizeAgnToolEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'a-5',
        name: 'shell',
        input: { command: 'npm test' },
      }).name,
      'shell',
    );
  });
});

describe('formatActiveTools', () => {
  it('joins entries with middle dot', () => {
    const map = new Map([
      ['c-1', { name: 'Read', args: { path: 'a.js' } }],
      ['c-2', { name: 'Shell', args: { command: 'npm test' } }],
    ]);
    assert.equal(formatActiveTools(map), 'Reading a.js… · Running: npm test…');
  });

  it('shows up to 3 entries and appends +N more beyond that', () => {
    const map = new Map([
      ['c-1', { name: 'Read', args: { path: 'a.js' } }],
      ['c-2', { name: 'Shell', args: { command: 'npm test' } }],
      ['c-3', { name: 'Grep', args: { pattern: 'foo' } }],
      ['c-4', { name: 'Read', args: { path: 'b.js' } }],
      ['c-5', { name: 'Read', args: { path: 'c.js' } }],
    ]);
    const text = formatActiveTools(map);
    assert.match(text, /\+2 more$/);
    assert.equal(text.split(' · ').length, 4); // 3 tool segments + "+2 more"
  });

  it('truncates each segment to 40 chars in parallel mode', () => {
    const map = new Map([
      ['c-1', { name: 'Shell', args: { command: 'x'.repeat(100) } }],
    ]);
    const [segment] = formatActiveTools(map).split(' · ');
    // The command arg itself is truncated to 40 chars (+ ellipsis); it must
    // not contain the full 100-char command.
    assert.ok(segment.includes('x'.repeat(40)));
    assert.ok(!segment.includes('x'.repeat(41)));
  });

  it('caps the total line at 120 chars (+ ellipsis marker)', () => {
    const map = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `c-${i}`,
        { name: 'Shell', args: { command: 'y'.repeat(50) } },
      ]),
    );
    // truncate() appends one ellipsis char when cutting at the 120-char budget.
    assert.ok(formatActiveTools(map).length <= 121);
  });
});

describe('ActiveToolTracker via Agent.onToolEvent', () => {
  it('3 starts join into one line; 1 completes leaves 2 in order; all complete falls back to working…', () => {
    const agent = new Agent('implementer', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    agent.onToolEvent({ name: 'Read', args: { path: 'a.js' }, phase: 'started', callId: 'c-1' });
    agent.onToolEvent({ name: 'Shell', args: { command: 'npm test' }, phase: 'started', callId: 'c-2' });
    agent.onToolEvent({ name: 'Grep', args: { pattern: 'foo' }, phase: 'started', callId: 'c-3' });

    assert.equal(agent.activeTools.size, 3);
    assert.match(statuses[statuses.length - 1], /Reading a\.js.*Running: npm test.*Searching: foo/s);

    agent.onToolEvent({ name: 'Read', args: {}, phase: 'completed', callId: 'c-1' });
    assert.deepEqual([...agent.activeTools.keys()], ['c-2', 'c-3']);
    assert.match(statuses[statuses.length - 1], /Running: npm test.*Searching: foo/s);

    agent.onToolEvent({ name: 'Shell', args: {}, phase: 'completed', callId: 'c-2' });
    agent.onToolEvent({ name: 'Grep', args: {}, phase: 'completed', callId: 'c-3' });
    assert.equal(agent.activeTools.size, 0);
    assert.equal(statuses[statuses.length - 1], 'working…');
  });
});

describe('parallel tool lifecycle (fixture-driven)', () => {
  it('tracks 3 starts, 1 completion, then drains to working…', () => {
    const agent = new Agent('implementer', 'instr', 'prompt');
    const statuses = [];
    agent.setStatus = (text) => statuses.push(text);

    const events = loadFixture('cursor-tool-parallel.jsonl');
    for (const event of events) {
      const toolEvent = normalizeCursorToolEvent(event);
      if (toolEvent) agent.onToolEvent(toolEvent);
    }

    // After all 5 starts + 2 completions, 3 remain (c-3, c-4, c-5).
    assert.equal(agent.activeTools.size, 3);
    assert.deepEqual([...agent.activeTools.keys()], ['c-3', 'c-4', 'c-5']);

    const last = statuses[statuses.length - 1];
    assert.match(last, /Searching: foo/);
    assert.match(last, /Reading b\.js/);
    assert.match(last, /Reading c\.js/);

    // Draining the rest brings it back to working…
    agent.onToolEvent({ name: 'Grep', args: {}, phase: 'completed', callId: 'c-3' });
    agent.onToolEvent({ name: 'Read', args: {}, phase: 'completed', callId: 'c-4' });
    agent.onToolEvent({ name: 'Read', args: {}, phase: 'completed', callId: 'c-5' });
    assert.equal(statuses[statuses.length - 1], 'working…');
  });
});
