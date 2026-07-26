import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { boundariesAgentArgs } from '../agents/boundaries.js';

/**
 * Contract this file pins down for `agents/boundaries.js` (net-new, see
 * .spec/fanout-3-coordinator.md section "Agents" and .spec/fanout.md's
 * "Boundaries research"):
 *
 * - `boundariesAgentArgs({ prompt, cwd, boundariesPath })` follows the exact
 *   shape every other `agents/*.js` factory uses: `{ name, instructions,
 *   prompt, options: { cwd } }` (mirroring `agents/research.js`'s shape per
 *   task.md item 1).
 * - Instructions require writing findings ONLY to the exact path
 *   `boundariesPath` (mirrors research.js's "write your findings only to the
 *   exact path" contract) — no task checklist, no `task.md`.
 * - Instructions explicitly forbid implementation planning (this agent
 *   researches partitionability only, per fanout.md's "Boundaries research"
 *   section and decision 5).
 * - Instructions direct the agent to answer: what can run in parallel, where
 *   the coarse boundaries are, and whether shared scaffolding (types,
 *   registries, barrels) must land before parallel work.
 * - Instructions end with the standard `<<<SUMMARY>>>` footer convention,
 *   same as every other agent.
 * - `agents/index.js` re-exports `boundariesAgentArgs` alongside the existing
 *   agents (task.md item 1's "Export both from agents/index.js").
 */

function baseArgs(overrides = {}) {
  return {
    prompt: 'implement the billing module',
    cwd: '/tmp/repo',
    boundariesPath: '/tmp/repo/.orch/wise-pine-e904/boundaries.md',
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

describe('boundariesAgentArgs', () => {
  it('returns the standard agent-args shape, named "boundaries", with cwd set to the invocation cwd', () => {
    const base = baseArgs();
    const args = boundariesAgentArgs(base);

    assertAgentArgsShape(args);
    assert.equal(args.name, 'boundaries');
    assert.equal(args.prompt, base.prompt);
    assert.equal(args.options.cwd, base.cwd);
    assert.match(args.instructions, /Boundaries Agent/);
  });

  it('requires writing findings only to the exact boundariesPath', () => {
    const base = baseArgs();
    const args = boundariesAgentArgs(base);

    assert.ok(args.instructions.includes(base.boundariesPath));
    assert.match(args.instructions, /only to the exact path/i);
  });

  it('forbids implementation planning and writing a task checklist', () => {
    const args = boundariesAgentArgs(baseArgs());

    assert.match(args.instructions, /do not plan|forbid|no implementation planning/i);
    assert.match(args.instructions, /implementation/i);
    assert.doesNotMatch(args.instructions, /task\.md/i);
  });

  it('asks what can run in parallel, where the coarse boundaries are, and about shared scaffolding', () => {
    const args = boundariesAgentArgs(baseArgs());

    assert.match(args.instructions, /parallel/i);
    assert.match(args.instructions, /boundar/i);
    assert.match(args.instructions, /scaffold|registr|barrel/i);
  });

  it('ends with the standard summary-marker footer convention', () => {
    const args = boundariesAgentArgs(baseArgs());

    assert.match(args.instructions, /<<<SUMMARY>>>/);
    assert.match(args.instructions, /one paragraph/i);
  });

  it('never includes an unresolved template interpolation', () => {
    const args = boundariesAgentArgs(baseArgs());
    assert.doesNotMatch(args.instructions, /\$\{/);
  });
});

describe('agents/index.js barrel includes boundariesAgentArgs', () => {
  it('re-exports boundariesAgentArgs', async () => {
    const barrel = await import('../agents/index.js');
    assert.equal(typeof barrel.boundariesAgentArgs, 'function');
  });
});
