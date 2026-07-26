import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecomposition } from '../lib/parse-decomposition.js';

/**
 * Contract pinned down here (see .spec/fanout-1-foundation.md):
 *
 * - Mirrors lib/parse-triage-json.js's three-tier extraction: direct
 *   JSON.parse, then a fenced ```json block, then the first `{` to last `}`
 *   span. Always returns `null` instead of throwing.
 * - `{ decomposable: false, why }` is accepted as-is (no `workers` required).
 * - `{ decomposable: true, why, workers: [...] }` is accepted as-is; no
 *   semantic validation happens here (that's validateDecomposition's job).
 * - Returns `null` for non-string input, empty string, invalid JSON, or no
 *   `{...}` span found anywhere.
 */

const VALID_DECOMPOSABLE = {
  decomposable: true,
  why: 'each endpoint is an independent handler with its own test file',
  workers: [
    {
      id: '01-scaffold',
      title: 'shared billing types and stubs',
      subtask: 'Create Invoice and Charge types, empty handler stubs, and register all billing routes.',
      area: 'src/billing/',
      owns: ['src/billing/types.ts', 'src/routes/billing.ts'],
      dependsOn: [],
      scaffold: true,
    },
    {
      id: '02-invoices',
      title: 'invoice endpoints',
      subtask: 'Implement create and list invoice endpoints.',
      area: 'src/billing/invoices/',
      owns: ['src/billing/invoices/'],
      dependsOn: ['01-scaffold'],
      scaffold: false,
    },
  ],
};

const VALID_NON_DECOMPOSABLE = {
  decomposable: false,
  why: 'the task is a single tightly-coupled change with no independent seams',
};

describe('parseDecomposition', () => {
  it('parses a valid decomposable:true payload with workers intact', () => {
    const parsed = parseDecomposition(JSON.stringify(VALID_DECOMPOSABLE));

    assert.equal(parsed.decomposable, true);
    assert.equal(parsed.why, VALID_DECOMPOSABLE.why);
    assert.equal(parsed.workers.length, 2);
    assert.deepEqual(parsed.workers[0], VALID_DECOMPOSABLE.workers[0]);
    assert.deepEqual(parsed.workers[1], VALID_DECOMPOSABLE.workers[1]);
  });

  it('parses a decomposable:false payload without requiring workers', () => {
    const parsed = parseDecomposition(JSON.stringify(VALID_NON_DECOMPOSABLE));

    assert.equal(parsed.decomposable, false);
    assert.equal(parsed.why, VALID_NON_DECOMPOSABLE.why);
    assert.equal(parsed.workers, undefined);
  });

  it('extracts JSON from a fenced ```json block', () => {
    const prose = [
      'Here is my decomposition:',
      '```json',
      JSON.stringify(VALID_DECOMPOSABLE),
      '```',
      'Let me know if this looks right.',
    ].join('\n');

    const parsed = parseDecomposition(prose);
    assert.equal(parsed.decomposable, true);
    assert.equal(parsed.workers.length, 2);
  });

  it('extracts JSON from prose wrapped around a bare object (first { to last })', () => {
    const prose = `Sure thing, decomposing now.\n${JSON.stringify(VALID_NON_DECOMPOSABLE)}\nHope that helps.`;

    const parsed = parseDecomposition(prose);
    assert.equal(parsed.decomposable, false);
    assert.equal(parsed.why, VALID_NON_DECOMPOSABLE.why);
  });

  it('returns null for garbage input instead of throwing', () => {
    assert.equal(parseDecomposition('not json at all'), null);
    assert.equal(parseDecomposition('{"unterminated": '), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(parseDecomposition(null), null);
    assert.equal(parseDecomposition(undefined), null);
    assert.equal(parseDecomposition(42), null);
    assert.equal(parseDecomposition({ decomposable: true }), null);
  });

  it('returns null for empty or whitespace-only input', () => {
    assert.equal(parseDecomposition(''), null);
    assert.equal(parseDecomposition('   \n  '), null);
  });

  it('returns null when no {...} span exists anywhere in the text', () => {
    assert.equal(parseDecomposition('I looked at the code and there is nothing to decompose.'), null);
  });
});
