import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { splitStageSummary, printStageSummary } from '../lib/stage-summary.js';

describe('splitStageSummary', () => {
  it('splits content and summary on the delimiter', () => {
    const raw = 'the real content\n<<<SUMMARY>>>\nThis is the paragraph summary.';
    const { content, summary } = splitStageSummary(raw);
    assert.equal(content, 'the real content');
    assert.equal(summary, 'This is the paragraph summary.');
  });

  it('trims whitespace around content and summary when the delimiter is present', () => {
    const raw = '  \n  the real content  \n<<<SUMMARY>>>\n  the paragraph  \n  ';
    const { content, summary } = splitStageSummary(raw);
    assert.equal(content, 'the real content');
    assert.equal(summary, 'the paragraph');
  });

  it('returns raw unchanged as content and empty summary when the delimiter is absent', () => {
    const raw = '  some content with no delimiter  ';
    const { content, summary } = splitStageSummary(raw);
    assert.equal(content, raw);
    assert.equal(summary, '');
  });

  it('splits on the LAST occurrence when the delimiter text appears more than once', () => {
    const raw = [
      'part one',
      '<<<SUMMARY>>>',
      'not the real summary, mentions the literal delimiter text below',
      '<<<SUMMARY>>>',
      'the real summary',
    ].join('\n');
    const { content, summary } = splitStageSummary(raw);
    assert.equal(
      content,
      'part one\n<<<SUMMARY>>>\nnot the real summary, mentions the literal delimiter text below',
    );
    assert.equal(summary, 'the real summary');
  });

  it('returns an empty summary when nothing but whitespace follows the delimiter', () => {
    const raw = 'content only\n<<<SUMMARY>>>\n   ';
    const { content, summary } = splitStageSummary(raw);
    assert.equal(content, 'content only');
    assert.equal(summary, '');
  });

  it('preserves JSON content before the delimiter untouched (parseTriageJson/parseVerdict contract)', () => {
    const json = JSON.stringify({ passed: true, summary: 'ok' });
    const raw = `${json}\n<<<SUMMARY>>>\nThe runner ran the suite and it passed.`;
    const { content, summary } = splitStageSummary(raw);
    assert.equal(content, json);
    assert.equal(summary, 'The runner ran the suite and it passed.');
  });

  it('treats non-string input like an absent delimiter instead of throwing', () => {
    for (const input of [null, undefined]) {
      const { content, summary } = splitStageSummary(input);
      assert.equal(content, input);
      assert.equal(summary, '');
    }
  });
});

describe('printStageSummary', () => {
  it('prints a titled, bulleted block when summary is non-empty', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('test-writer 1/5', 'Wrote the tests and updated status.md.');
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, [
      '',
      '─────────────────',
      ' test-writer 1/5 ',
      '─────────────────',
      '  • Wrote the tests and updated status.md.',
      '',
    ]);
  });

  it('splits a multi-sentence summary into one bullet per sentence', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('triage', 'Read the request. Routed to quick-fix.');
    } finally {
      restore.mock.restore();
    }
    assert.ok(logs.includes('  • Read the request.'));
    assert.ok(logs.includes('  • Routed to quick-fix.'));
  });

  it('is a no-op when summary is an empty string', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('triage', '');
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, []);
  });

  it('uses the exact label passed in, unchanged (caller supplies roundLabel(...) for looped stages)', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('code-writer 2/5', 'Implemented the checklist.');
    } finally {
      restore.mock.restore();
    }
    assert.ok(logs.some((line) => line.includes('code-writer 2/5')));
    assert.ok(logs.some((line) => line.includes('• Implemented the checklist.')));
  });

  it('appends a Files (N) section after prose bullets when files are provided', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('code-writer 1/5', 'Implemented the checklist.', [
        { marker: '~', path: 'lib/agent.js' },
        { marker: '+', path: 'lib/file-tracker.js' },
      ]);
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, [
      '',
      '─────────────────',
      ' code-writer 1/5 ',
      '─────────────────',
      '  • Implemented the checklist.',
      '  Files (2)',
      '    ~ lib/agent.js',
      '    + lib/file-tracker.js',
      '',
    ]);
  });

  it('prints a titled Files-only block when prose is empty but files are nonempty', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('test-writer 1/5', '', [
        { marker: '+', path: 'test/file-tracker.test.js' },
      ]);
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, [
      '',
      '─────────────────',
      ' test-writer 1/5 ',
      '─────────────────',
      '  Files (1)',
      '    + test/file-tracker.test.js',
      '',
    ]);
  });

  it('prints prose without a Files section when files is omitted or empty', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('triage', 'Routed to research.', []);
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, [
      '',
      '────────',
      ' triage ',
      '────────',
      '  • Routed to research.',
      '',
    ]);
    assert.equal(logs.some((line) => /Files \(/.test(line)), false);
  });

  it('is a no-op when both summary and files are empty', () => {
    const logs = [];
    const restore = mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    try {
      printStageSummary('code-writer 1/5', '', []);
      printStageSummary('code-writer 1/5', '', undefined);
      printStageSummary('code-writer 1/5', '');
    } finally {
      restore.mock.restore();
    }
    assert.deepEqual(logs, []);
  });
});
