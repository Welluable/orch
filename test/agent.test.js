import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCursor } from '../lib/agent-cursor.js';
import { AgentClaude } from '../lib/agent-claude.js';
import { formatElapsed, formatToolStatus } from '../lib/agent.js';
import { parseTriageJson } from '../lib/parse-triage-json.js';

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


describe('AgentCursor', () => {
  it('builds Cursor spawn config', () => {
    const agent = new AgentCursor('research', 'instr', 'prompt');
    const { command, args } = agent.getSpawnConfig('hello');
    assert.equal(command, 'agent');
    assert.deepEqual(args, ['-p', '--force', '--output-format', 'stream-json', 'hello']);
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

describe('formatToolStatus', () => {
  it('maps Claude Bash and Edit names', () => {
    assert.match(
      formatToolStatus({ name: 'Bash', input: { command: 'ls -la' } }),
      /Running:/,
    );
    assert.match(
      formatToolStatus({ name: 'Edit', input: { path: 'a.js' } }),
      /Writing a\.js/,
    );
  });
});
