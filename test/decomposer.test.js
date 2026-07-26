import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposerAgentArgs } from '../agents/decomposer.js';
import { parseDecomposition } from '../lib/parse-decomposition.js';

/**
 * Contract this file pins down for `agents/decomposer.js` (net-new, see
 * .spec/fanout-3-coordinator.md section "Agents" and .spec/fanout.md's
 * "Decomposition"):
 *
 * - `decomposerAgentArgs({ prompt, cwd, boundariesOutput, maxWorkers,
 *   feedback })` follows the exact shape every other `agents/*.js` factory
 *   uses: `{ name, instructions, prompt, options: { cwd } }` (mirroring
 *   `agents/triage.js`'s strict-JSON-then-summary-marker shape per task.md
 *   item 1).
 * - `boundariesOutput` is taken as an in-memory string param and interpolated
 *   directly into the instructions (the same pattern `agents/planner.js`
 *   uses for `researchOutput`) — the decomposer never re-reads
 *   `boundaries.md` from disk itself.
 * - Instructions require a strict-JSON final message matching the
 *   decomposition schema (`decomposable`, `why`, and — when decomposable —
 *   `workers[]` with `id`/`title`/`subtask`/`area`/`owns`/`dependsOn`/
 *   `scaffold`), parseable by the existing `parseDecomposition`
 *   (`lib/parse-decomposition.js`), followed by the standard summary-marker
 *   footer.
 * - Instructions state that `decomposable: false` (with a `why`) is a valid,
 *   expected answer — the decomposer must not be pressured into forcing a
 *   split.
 * - `maxWorkers` is interpolated so the agent knows the hard ceiling it must
 *   respect.
 * - When `feedback` (an array of orch-computed validation violation
 *   strings — see `validateDecomposition` in `lib/fanout.js`) is present,
 *   instructions inject a distinct feedback block naming each violation, for
 *   the repair round-trip described in task.md ("up to two repair
 *   round-trips back to the decomposer on violations").
 * - `agents/index.js` re-exports `decomposerAgentArgs` alongside the existing
 *   agents (task.md item 1's "Export both from agents/index.js").
 */

function baseArgs(overrides = {}) {
  return {
    prompt: 'implement the billing module',
    cwd: '/tmp/repo',
    boundariesOutput: 'The billing module splits into scaffold + 3 independent endpoint handlers.',
    maxWorkers: 4,
    ...overrides,
  };
}

function assertAgentArgsShape(args) {
  assert.equal(typeof args, 'object');
  assert.notEqual(args, null);
  assert.equal(typeof args.instructions, 'string');
  assert.ok(args.instructions.length > 0);
  assert.equal(typeof args.prompt, 'string');
  assert.equal(typeof args.options, 'object');
  assert.notEqual(args.options, null);
  assert.equal(typeof args.options.cwd, 'string');
}

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

describe('decomposerAgentArgs', () => {
  it('returns the standard agent-args shape, named "decomposer", with cwd set to the invocation cwd', () => {
    const base = baseArgs();
    const args = decomposerAgentArgs(base);

    assertAgentArgsShape(args);
    assert.equal(args.name, 'decomposer');
    assert.equal(args.prompt, base.prompt);
    assert.equal(args.options.cwd, base.cwd);
    assert.match(args.instructions, /Decomposer Agent/i);
  });

  it('interpolates boundariesOutput verbatim in-memory, wrapped in a distinct block', () => {
    const base = baseArgs();
    const args = decomposerAgentArgs(base);

    assert.ok(args.instructions.includes(base.boundariesOutput));
  });

  it('requires strict JSON matching the decomposition schema, parseable by parseDecomposition', () => {
    const args = decomposerAgentArgs(baseArgs());

    assert.match(args.instructions, /"decomposable"/);
    assert.match(args.instructions, /"why"/);
    assert.match(args.instructions, /"workers"/);
    assert.match(args.instructions, /"dependsOn"/);
    assert.match(args.instructions, /"scaffold"/);
    assert.match(args.instructions, /valid JSON/i);

    // Sanity: a well-formed reply following this contract round-trips through
    // the real parser this agent's output is meant to feed.
    const reply = `${JSON.stringify(VALID_DECOMPOSABLE)}\n<<<SUMMARY>>>\nsplit into scaffold + endpoints`;
    const parsed = parseDecomposition(reply);
    assert.equal(parsed.decomposable, true);
    assert.equal(parsed.workers.length, 2);
  });

  it('states that decomposable:false is a valid, expected answer', () => {
    const args = decomposerAgentArgs(baseArgs());
    assert.match(args.instructions, /decomposable.*false/is);
    assert.match(args.instructions, /valid|expected|acceptable/i);
  });

  it('interpolates maxWorkers as the hard ceiling', () => {
    const args = decomposerAgentArgs(baseArgs({ maxWorkers: 6 }));
    assert.ok(args.instructions.includes('6'));
    assert.match(args.instructions, /at most|no more than|maximum/i);
  });

  it('omits a [Validation Feedback] block when feedback is absent', () => {
    const args = decomposerAgentArgs(baseArgs());
    assert.doesNotMatch(args.instructions, /\[Validation Feedback\]/);
  });

  it('injects a [Validation Feedback] block naming each violation when feedback is present', () => {
    const feedback = [
      'workers 02-invoices and 03-charges have overlapping owns in the same layer',
      'more than one worker marked scaffold',
    ];
    const args = decomposerAgentArgs(baseArgs({ feedback }));

    assert.match(args.instructions, /\[Validation Feedback\]/);
    for (const violation of feedback) {
      assert.ok(args.instructions.includes(violation), `expected instructions to mention: ${violation}`);
    }
  });

  it('ends with the standard summary-marker footer convention', () => {
    const args = decomposerAgentArgs(baseArgs());
    assert.match(args.instructions, /<<<SUMMARY>>>/);
    assert.match(args.instructions, /one paragraph/i);
  });

  it('never includes an unresolved template interpolation', () => {
    const args = decomposerAgentArgs(baseArgs());
    assert.doesNotMatch(args.instructions, /\$\{/);
  });
});

describe('agents/index.js barrel includes decomposerAgentArgs', () => {
  it('re-exports decomposerAgentArgs', async () => {
    const barrel = await import('../agents/index.js');
    assert.equal(typeof barrel.decomposerAgentArgs, 'function');
  });
});
