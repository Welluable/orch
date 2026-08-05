import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seqDecomposerAgentArgs } from '../agents/seq-decomposer.js';
import { adjustAgentArgs } from '../agents/adjust.js';
import { parseDecomposition } from '../lib/parse-decomposition.js';
import * as agentsIndex from '../agents/index.js';

/**
 * Contract this file pins down for agents/seq-decomposer.js and
 * agents/adjust.js (see .spec/seq.md Decomposition / Hybrid adjust and
 * task.md Phase 3).
 *
 * seqDecomposerAgentArgs({ prompt, cwd, maxUnits, feedback })
 * - Same `{ name, instructions, prompt, options: { cwd } }` shape as other
 *   agents/*.js factories. `name` is `seq-decomposer` (or `decomposer` if
 *   the implementation reuses that spinner label — prefer `seq-decomposer`
 *   so coordinator logs distinguish fan-out vs seq).
 * - **No** `boundariesOutput` parameter; instructions must not mention
 *   boundaries.md or require owns/dependsOn/scaffold/area.
 * - Instructions require strict JSON (`decomposable`, `why`, and when true
 *   `units[]` with `id`/`title`/`subtask` only) before `<<<SUMMARY>>>`,
 *   parseable by `parseDecomposition`.
 * - `maxUnits` is interpolated; `feedback` (violation strings) injects a
 *   repair block when present.
 * - `decomposable: false` with `why` is a valid answer.
 *
 * adjustAgentArgs({ originalTask, doneUnits, pendingUnits, tip, cwd, maxUnits, feedback })
 * - Same agent-args shape; `name` is `adjust`.
 * - Instructions fence on `originalTask`, summarize `doneUnits`, list
 *   `pendingUnits` in order, mention `tip`, and require rewrite-at-most-
 *   next-two / drop-obsolete / no new ids / no scope expansion past the
 *   original task / respect maxUnits.
 * - Output JSON shape `{ rewrites: [{ id, title?, subtask? }], drops: [id] }`
 *   before the summary marker.
 *
 * agents/index.js re-exports both factories.
 */

function assertAgentArgsShape(args) {
  assert.equal(typeof args, 'object');
  assert.notEqual(args, null);
  assert.equal(typeof args.name, 'string');
  assert.equal(typeof args.instructions, 'string');
  assert.ok(args.instructions.length > 0);
  assert.equal(typeof args.prompt, 'string');
  assert.equal(typeof args.options, 'object');
  assert.notEqual(args.options, null);
  assert.equal(typeof args.options.cwd, 'string');
}

const VALID_SEQ_DECOMPOSITION = {
  decomposable: true,
  why: 'types then API; each is a finishable commit-sized unit',
  units: [
    { id: '01-types', title: 'billing types', subtask: 'Add shared billing types and stubs.' },
    { id: '02-api', title: 'invoice API', subtask: 'Implement create and list invoice endpoints.' },
  ],
};

describe('seqDecomposerAgentArgs', () => {
  it('returns the standard agent-args shape with cwd options', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement the billing module',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assertAgentArgsShape(args);
    assert.match(args.name, /seq-decomposer|decomposer/);
    assert.equal(args.options.cwd, '/tmp/repo');
    assert.equal(args.prompt, 'implement the billing module');
  });

  it('does not accept or mention boundaries / owns / dependsOn / scaffold', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement the billing module',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assert.equal(Object.hasOwn(args, 'boundariesOutput'), false);
    assert.doesNotMatch(args.instructions, /boundaries\.md/i);
    assert.doesNotMatch(args.instructions, /\bowns\b/);
    assert.doesNotMatch(args.instructions, /dependsOn/);
    assert.doesNotMatch(args.instructions, /\bscaffold\b/);
  });

  it('interpolates maxUnits and allows decomposable:false', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement the billing module',
      cwd: '/tmp/repo',
      maxUnits: 6,
    });
    assert.match(args.instructions, /6/);
    assert.match(args.instructions, /decomposable:\s*false|decomposable": false|not decomposable/i);
  });

  it('injects feedback violations on repair rounds', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement the billing module',
      cwd: '/tmp/repo',
      maxUnits: 8,
      feedback: ['fewer than two units; not decomposable', 'unit 01-types has fan-out field owns'],
    });
    assert.match(args.instructions, /fewer than two units/);
    assert.match(args.instructions, /fan-out field owns/);
  });

  it('produces instructions whose required JSON shape parseDecomposition accepts', () => {
    const args = seqDecomposerAgentArgs({
      prompt: 'implement the billing module',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assert.match(args.instructions, /units/);
    assert.match(args.instructions, /SUMMARY|summary marker|<<<SUMMARY>>>/i);
    const parsed = parseDecomposition(JSON.stringify(VALID_SEQ_DECOMPOSITION));
    assert.equal(parsed.decomposable, true);
    assert.equal(parsed.units.length, 2);
  });
});

describe('adjustAgentArgs', () => {
  it('returns the standard agent-args shape named adjust', () => {
    const args = adjustAgentArgs({
      originalTask: 'implement the billing module',
      doneUnits: [{ id: '01-types', title: 'billing types', subtask: 'Add types.', sha: 'bbb' }],
      pendingUnits: [
        { id: '02-api', title: 'invoice API', subtask: 'Implement API.' },
        { id: '03-ui', title: 'invoice UI', subtask: 'Build UI.' },
      ],
      tip: 'def5678',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assertAgentArgsShape(args);
    assert.equal(args.name, 'adjust');
  });

  it('fences on the original task, lists done and pending, and mentions tip', () => {
    const args = adjustAgentArgs({
      originalTask: 'implement the billing module',
      doneUnits: [{ id: '01-types', title: 'billing types', subtask: 'Add types.', sha: 'bbb' }],
      pendingUnits: [
        { id: '02-api', title: 'invoice API', subtask: 'Implement API.' },
        { id: '03-ui', title: 'invoice UI', subtask: 'Build UI.' },
      ],
      tip: 'def5678',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assert.match(args.instructions, /implement the billing module/);
    assert.match(args.instructions, /01-types/);
    assert.match(args.instructions, /02-api/);
    assert.match(args.instructions, /03-ui/);
    assert.match(args.instructions, /def5678/);
  });

  it('instructs rewrite-at-most-two, drop obsolete, no new ids, respect maxUnits', () => {
    const args = adjustAgentArgs({
      originalTask: 'implement the billing module',
      doneUnits: [],
      pendingUnits: [{ id: '01-types', title: 't', subtask: 's' }],
      tip: 'abc',
      cwd: '/tmp/repo',
      maxUnits: 8,
    });
    assert.match(args.instructions, /two|2/);
    assert.match(args.instructions, /drop/i);
    assert.match(args.instructions, /rewrites|rewrite/i);
    assert.match(args.instructions, /8/);
    assert.match(args.instructions, /new id|invent/i);
  });

  it('injects feedback on repair rounds', () => {
    const args = adjustAgentArgs({
      originalTask: 'implement the billing module',
      doneUnits: [],
      pendingUnits: [{ id: '01-types', title: 't', subtask: 's' }],
      tip: 'abc',
      cwd: '/tmp/repo',
      maxUnits: 8,
      feedback: ['cannot rewrite done unit 01-types'],
    });
    assert.match(args.instructions, /cannot rewrite done unit/);
  });
});

describe('agents/index.js seq exports', () => {
  it('re-exports seqDecomposerAgentArgs, decomposeAgentArgs, and adjustAgentArgs', () => {
    assert.equal(typeof agentsIndex.seqDecomposerAgentArgs, 'function');
    assert.equal(typeof agentsIndex.decomposeAgentArgs, 'function');
    assert.equal(typeof agentsIndex.adjustAgentArgs, 'function');
  });
});
