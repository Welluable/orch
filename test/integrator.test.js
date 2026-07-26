import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { integratorAgentArgs } from '../agents/integrator.js';

/**
 * Contract this file pins down for `agents/integrator.js` (net-new, see
 * .spec/fanout-2-child-paths.md section 3 and .spec/fanout.md's "The
 * integration session" / decision 9):
 *
 * - `integratorAgentArgs({ prompt, cwd, conflictedFiles, mergeOutput,
 *   involvedWorkers })` follows the exact shape of every other `agents/*.js`
 *   factory: returns `{ instructions, prompt, options: { cwd } }` (a `name`
 *   is fine to include too, since the integrator runs once — not in a
 *   writer⇄critic/runner round loop — so there is no `roundLabel` suffix to
 *   apply at the call site the way test-writer/test-critic/code-writer/
 *   test-runner need).
 * - `cwd` is the integration worktree; `prompt` is passed through unchanged
 *   (the caller decides what the "task" text is; the agent-args factory does
 *   not build the envelope itself).
 * - Instructions name every conflicted file path and forbid touching files
 *   outside that list.
 * - Instructions surface the merge output and the involved workers'
 *   `subtask`/`area` as context, without inventing new context (no parent
 *   research, no `owns`).
 * - Instructions explicitly forbid redesign/reimplementation beyond what is
 *   needed to resolve the conflict.
 * - Instructions explicitly forbid running any git command (`git add`,
 *   `git commit`, `git merge --continue/--abort`, etc.) — orch owns the
 *   merge commit itself; the integrator only edits files (decision 9 /
 *   "orch owns git merge; an agent only repairs conflicts").
 * - Instructions end with the same summary-marker convention as every other
 *   agent (`<<<SUMMARY>>>` footer), and there is no JSON verdict — orch
 *   checks `hasConflictMarkers` itself afterward, it doesn't ask the agent to
 *   self-report pass/fail.
 */

function baseArgs(overrides = {}) {
  return {
    prompt: 'Combine the completed worker branches for "implement the billing module" into one coherent branch and make the full test suite pass.',
    cwd: '/abs/path/repo-wise-pine-e904',
    conflictedFiles: ['src/billing/index.ts', 'src/routes/billing.ts'],
    mergeOutput: 'CONFLICT (content): Merge conflict in src/billing/index.ts',
    involvedWorkers: [
      { id: '02-invoices', title: 'invoice endpoints', subtask: 'Implement create and list invoice endpoints.', area: 'src/billing/invoices/' },
      { id: '03-charges', title: 'charge endpoints', subtask: 'Implement create and list charge endpoints.', area: 'src/billing/charges/' },
    ],
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

describe('integratorAgentArgs', () => {
  it('returns the standard agent-args shape, with cwd set to the integration worktree', () => {
    const base = baseArgs();
    const args = integratorAgentArgs(base);

    assertAgentArgsShape(args);
    assert.equal(args.prompt, base.prompt);
    assert.equal(args.options.cwd, base.cwd);
    assert.match(args.instructions, /Integrator Agent/);
  });

  it('names every conflicted file path in the instructions', () => {
    const base = baseArgs();
    const args = integratorAgentArgs(base);

    for (const file of base.conflictedFiles) {
      assert.ok(args.instructions.includes(file), `expected instructions to mention ${file}`);
    }
  });

  it('includes the merge output verbatim as context', () => {
    const base = baseArgs();
    const args = integratorAgentArgs(base);

    assert.ok(args.instructions.includes(base.mergeOutput));
  });

  it("includes each involved worker's subtask and area, without a parent research dump or owns list", () => {
    const base = baseArgs();
    const args = integratorAgentArgs(base);

    for (const worker of base.involvedWorkers) {
      assert.ok(args.instructions.includes(worker.subtask), `expected instructions to mention ${worker.subtask}`);
      assert.ok(args.instructions.includes(worker.area), `expected instructions to mention ${worker.area}`);
    }
    assert.doesNotMatch(args.instructions, /\bowns\b/i);
    assert.doesNotMatch(args.instructions, /boundaries\.md/i);
  });

  it('forbids redesign or reimplementation beyond resolving the conflict', () => {
    const args = integratorAgentArgs(baseArgs());
    assert.match(args.instructions, /redesign|reimplement/i);
    assert.match(args.instructions, /resolve|conflict/i);
  });

  it('forbids the agent from running git itself — orch completes the merge', () => {
    const args = integratorAgentArgs(baseArgs());
    assert.match(args.instructions, /do not run [`']?git|do not run any git/i);
    assert.doesNotMatch(args.instructions, /"passed"/);
    assert.doesNotMatch(args.instructions, /verdict/i);
  });

  it('ends with the standard summary-marker footer convention', () => {
    const args = integratorAgentArgs(baseArgs());
    assert.match(args.instructions, /<<<SUMMARY>>>/);
    assert.match(args.instructions, /one paragraph/i);
  });

  it('never includes an unresolved template interpolation', () => {
    const args = integratorAgentArgs(baseArgs());
    assert.doesNotMatch(args.instructions, /\$\{/);
  });
});
