import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  readSeq,
  writeSeq,
  patchUnit,
  patchTip,
  appendAdjustment,
  validateSeqDecomposition,
  buildUnitEnvelope,
  validateAdjustResult,
  applyAdjustResult,
} from '../lib/seq.js';

/**
 * Contract this file pins down for lib/seq.js (see .spec/seq.md Artifacts /
 * Decomposition / Hybrid adjust, and task.md Phase 1):
 *
 * - seq.json lives at `<cwd>/.orch/<parentSlug>/seq.json` and is
 *   read/written/patched with the same atomic tmp+rename + per-job lock
 *   discipline as lib/fanout.js / lib/jobs.js (lock file `.seq.lock`).
 * - readSeq(cwd, parentSlug) -> parsed seq.json, or `null` if missing.
 * - writeSeq(cwd, parentSlug, data) -> atomic full-document write.
 * - patchUnit(cwd, parentSlug, unitId, patchFnOrObject) -> locks, re-reads,
 *   shallow-merges the patch (object, or `(currentUnit) => partialPatch`)
 *   onto the matching entry in `units[]` only, atomically writes back,
 *   unlocks, returns the updated full document.
 * - patchTip(cwd, parentSlug, tipSha) -> locks and sets top-level `tip`.
 * - appendAdjustment(cwd, parentSlug, entry) -> locks and pushes onto
 *   `adjustments[]` (creating the array if absent).
 * - validateSeqDecomposition(decomposition, { maxUnits }) -> violation
 *   strings (empty = valid). Rules: ≥2 units; ≤ maxUnits; unique non-empty
 *   slug-safe `id` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`); non-empty `title` /
 *   `subtask`; **reject** fan-out fields `dependsOn`, `owns`, `scaffold`,
 *   `area` when present on any unit.
 * - buildUnitEnvelope({ id, title, subtask, originalTask }) -> thin prompt
 *   string from .spec/seq.md (unit id/title, original task fence, subtask,
 *   "work only on this unit"; no full backlog, no boundaries.md, no owns).
 * - validateAdjustResult(result, { units, maxUnits }) -> violation strings.
 *   `result` shape: `{ rewrites: [{ id, title?, subtask? }], drops: [id] }`.
 *   Rules: rewrite at most the next 1–2 *pending* units (by current order);
 *   drops only pending ids → applied as `skipped`; no edit of `done` /
 *   `failed` / `running` / `skipped` records; no inventing new ids; total
 *   units length must stay ≤ maxUnits (v1 rewrite/drop only, so length is
 *   unchanged by a valid adjust).
 * - applyAdjustResult(seqDoc, result) -> new seq document with rewrites
 *   applied, dropped units marked `skipped`, no mutation of the input.
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-seq-'));
}

function seqJsonPath(cwd, parentSlug) {
  return path.join(cwd, '.orch', parentSlug, 'seq.json');
}

function baseUnit(overrides = {}) {
  return {
    id: '01-types',
    title: 'billing types',
    subtask: 'Add shared billing types and stubs.',
    state: 'pending',
    slug: null,
    sha: null,
    changedFiles: null,
    ...overrides,
  };
}

function baseSeq(overrides = {}) {
  return {
    version: 1,
    parentSlug: 'wise-pine-e904',
    task: 'implement the billing module',
    base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    tip: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    maxUnits: 8,
    units: [
      baseUnit({ id: '01-types', state: 'done', slug: 'rapid-fox-x7q2', sha: 'bbb1111', changedFiles: ['src/billing/types.ts'] }),
      baseUnit({
        id: '02-api',
        title: 'invoice API',
        subtask: 'Implement create/list invoice endpoints on current tip.',
      }),
      baseUnit({
        id: '03-ui',
        title: 'invoice UI',
        subtask: 'Build invoice list UI against the tip API.',
      }),
    ],
    adjustments: [],
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    state: 'running',
    ...overrides,
  };
}

function validDecomposition(overrides = {}) {
  return {
    decomposable: true,
    why: 'types then API then UI; each is a finishable commit-sized unit',
    units: [
      { id: '01-types', title: 'billing types', subtask: 'Add shared billing types and stubs.' },
      { id: '02-api', title: 'invoice API', subtask: 'Implement create and list invoice endpoints.' },
    ],
    ...overrides,
  };
}

describe('readSeq / writeSeq', () => {
  it('returns null when seq.json does not exist', () => {
    const cwd = makeTmpCwd();
    assert.equal(readSeq(cwd, 'no-such-parent-0000'), null);
  });

  it('round-trips a full document through an atomic write', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq();

    writeSeq(cwd, doc.parentSlug, doc);

    assert.deepEqual(readSeq(cwd, doc.parentSlug), doc);
    assert.ok(fs.existsSync(seqJsonPath(cwd, doc.parentSlug)));
    const dir = path.dirname(seqJsonPath(cwd, doc.parentSlug));
    const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('patchUnit', () => {
  it('shallow-merges an object patch onto only the matching unit', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq();
    writeSeq(cwd, doc.parentSlug, doc);

    const updated = patchUnit(cwd, doc.parentSlug, '02-api', {
      state: 'done',
      sha: 'c3d4e5f',
      slug: 'merry-elk-r4b1',
      changedFiles: ['src/billing/invoices.ts'],
    });

    const patched = updated.units.find((u) => u.id === '02-api');
    assert.equal(patched.state, 'done');
    assert.equal(patched.sha, 'c3d4e5f');
    assert.equal(patched.slug, 'merry-elk-r4b1');
    assert.equal(patched.title, 'invoice API');
    const other = updated.units.find((u) => u.id === '01-types');
    assert.deepEqual(other, doc.units[0]);
    assert.deepEqual(readSeq(cwd, doc.parentSlug), updated);
  });

  it('accepts a function patch receiving the current unit record', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq({
      units: [baseUnit({ id: '01-types', changedFiles: ['src/billing/types.ts'] })],
    });
    writeSeq(cwd, doc.parentSlug, doc);

    const updated = patchUnit(cwd, doc.parentSlug, '01-types', (current) => ({
      changedFiles: [...(current.changedFiles || []), 'src/billing/index.ts'],
    }));

    assert.deepEqual(
      updated.units.find((u) => u.id === '01-types').changedFiles,
      ['src/billing/types.ts', 'src/billing/index.ts'],
    );
  });

  it('releases the lock file after a successful patch', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq();
    writeSeq(cwd, doc.parentSlug, doc);

    patchUnit(cwd, doc.parentSlug, '02-api', { state: 'running' });

    const dir = path.dirname(seqJsonPath(cwd, doc.parentSlug));
    const lockLeftovers = fs.readdirSync(dir).filter((name) => name.includes('lock'));
    assert.deepEqual(lockLeftovers, []);
  });
});

describe('patchTip / appendAdjustment', () => {
  it('updates tip without touching units', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq();
    writeSeq(cwd, doc.parentSlug, doc);

    const updated = patchTip(cwd, doc.parentSlug, 'def5678abcdef');

    assert.equal(updated.tip, 'def5678abcdef');
    assert.deepEqual(updated.units, doc.units);
    assert.equal(readSeq(cwd, doc.parentSlug).tip, 'def5678abcdef');
  });

  it('appends an adjustments entry and preserves prior ones', () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq({
      adjustments: [{ afterUnitId: '01-types', tip: 'bbb1111', summary: 'baseline' }],
    });
    writeSeq(cwd, doc.parentSlug, doc);

    const updated = appendAdjustment(cwd, doc.parentSlug, {
      afterUnitId: '02-api',
      tip: 'ccc2222',
      summary: 'Rewrote 03-ui; dropped nothing',
    });

    assert.equal(updated.adjustments.length, 2);
    assert.equal(updated.adjustments[1].afterUnitId, '02-api');
    assert.deepEqual(readSeq(cwd, doc.parentSlug).adjustments, updated.adjustments);
  });
});

describe('patchUnit concurrency safety', () => {
  it('serializes back-to-back patches from two real processes without losing any increment', async () => {
    const cwd = makeTmpCwd();
    const doc = baseSeq({
      units: [baseUnit({ id: '01-types', changedFiles: [] })],
    });
    doc.units[0].counter = 0;
    writeSeq(cwd, doc.parentSlug, doc);

    const seqPath = new URL('../lib/seq.js', import.meta.url).pathname;
    const incrementerScript = `
      import { patchUnit } from ${JSON.stringify(`file://${seqPath}`)};
      for (let i = 0; i < 25; i += 1) {
        patchUnit(${JSON.stringify(cwd)}, ${JSON.stringify(doc.parentSlug)}, '01-types', (current) => ({
          counter: (current.counter || 0) + 1,
        }));
      }
    `;

    const runIncrementer = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', incrementerScript]);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`incrementer exited ${code}: ${stderr}`))));
    });

    await Promise.all([runIncrementer(), runIncrementer()]);

    const finalDoc = readSeq(cwd, doc.parentSlug);
    assert.equal(finalDoc.units.find((u) => u.id === '01-types').counter, 50);
  });
});

describe('validateSeqDecomposition', () => {
  it('accepts a well-formed ordered units list (empty violations array)', () => {
    assert.deepEqual(validateSeqDecomposition(validDecomposition(), { maxUnits: 8 }), []);
  });

  it('rejects fewer than two units as non-decomposable', () => {
    const violations = validateSeqDecomposition(
      validDecomposition({
        units: [{ id: '01-types', title: 'billing types', subtask: 'Add types.' }],
      }),
      { maxUnits: 8 },
    );
    assert.ok(violations.length > 0);
  });

  it('rejects more units than maxUnits', () => {
    const units = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      id: `0${id}-${id}`,
      title: id,
      subtask: `do ${id}`,
    }));
    // ids must be slug-safe; use numeric prefixes
    const safe = ['01-a', '02-b', '03-c', '04-d', '05-e'].map((id) => ({
      id,
      title: id,
      subtask: `do ${id}`,
    }));
    const violations = validateSeqDecomposition(
      validDecomposition({ units: safe }),
      { maxUnits: 4 },
    );
    assert.ok(violations.length > 0);
  });

  it('rejects duplicate ids', () => {
    const violations = validateSeqDecomposition(
      validDecomposition({
        units: [
          { id: '01-types', title: 'a', subtask: 'do a' },
          { id: '01-types', title: 'b', subtask: 'do b' },
        ],
      }),
      { maxUnits: 8 },
    );
    assert.ok(violations.length > 0);
  });

  it('rejects empty title or subtask', () => {
    const noTitle = validateSeqDecomposition(
      validDecomposition({
        units: [
          { id: '01-types', title: '', subtask: 'do a' },
          { id: '02-api', title: 'b', subtask: 'do b' },
        ],
      }),
      { maxUnits: 8 },
    );
    assert.ok(noTitle.length > 0);

    const noSubtask = validateSeqDecomposition(
      validDecomposition({
        units: [
          { id: '01-types', title: 'a', subtask: '' },
          { id: '02-api', title: 'b', subtask: 'do b' },
        ],
      }),
      { maxUnits: 8 },
    );
    assert.ok(noSubtask.length > 0);
  });

  it('rejects non-slug-safe ids', () => {
    const violations = validateSeqDecomposition(
      validDecomposition({
        units: [
          { id: 'Types!', title: 'a', subtask: 'do a' },
          { id: '02-api', title: 'b', subtask: 'do b' },
        ],
      }),
      { maxUnits: 8 },
    );
    assert.ok(violations.length > 0);
  });

  it('rejects fan-out fields dependsOn, owns, scaffold, and area', () => {
    for (const field of [
      { dependsOn: [] },
      { owns: ['src/a/'] },
      { scaffold: false },
      { area: 'src/a/' },
    ]) {
      const violations = validateSeqDecomposition(
        validDecomposition({
          units: [
            { id: '01-types', title: 'a', subtask: 'do a', ...field },
            { id: '02-api', title: 'b', subtask: 'do b' },
          ],
        }),
        { maxUnits: 8 },
      );
      assert.ok(violations.length > 0, `expected rejection for field ${JSON.stringify(field)}`);
    }
  });
});

describe('buildUnitEnvelope', () => {
  it('includes unit id, title, original task, and subtask', () => {
    const envelope = buildUnitEnvelope({
      id: '02-api',
      title: 'invoice API',
      subtask: 'Implement create and list invoice endpoints with tests.',
      originalTask: 'implement the billing module',
    });

    assert.match(envelope, /02-api/);
    assert.match(envelope, /invoice API/);
    assert.match(envelope, /implement the billing module/);
    assert.match(envelope, /Implement create and list invoice endpoints with tests\./);
  });

  it('instructs the unit to work only on this unit and not later backlog items', () => {
    const envelope = buildUnitEnvelope({
      id: '01-types',
      title: 'billing types',
      subtask: 'Add shared billing types and stubs.',
      originalTask: 'implement the billing module',
    });

    assert.match(envelope, /only on this unit/i);
    assert.match(envelope, /later backlog|do not implement later/i);
  });

  it('never includes owns, boundaries.md, or a full remaining backlog dump', () => {
    const envelope = buildUnitEnvelope({
      id: '01-types',
      title: 'billing types',
      subtask: 'Add shared billing types and stubs.',
      originalTask: 'implement the billing module',
    });

    assert.doesNotMatch(envelope, /\bowns\b/i);
    assert.doesNotMatch(envelope, /boundaries\.md/i);
    assert.doesNotMatch(envelope, /03-ui/);
    assert.doesNotMatch(envelope, /full backlog/i);
  });
});

describe('validateAdjustResult / applyAdjustResult', () => {
  function pendingBacklog() {
    return [
      baseUnit({ id: '01-types', state: 'done', sha: 'bbb1111', slug: 'rapid-fox-x7q2', changedFiles: [] }),
      baseUnit({ id: '02-api', title: 'invoice API', subtask: 'old api subtask' }),
      baseUnit({ id: '03-ui', title: 'invoice UI', subtask: 'old ui subtask' }),
      baseUnit({ id: '04-extra', title: 'extra', subtask: 'maybe obsolete' }),
    ];
  }

  it('accepts rewriting the next one or two pending units and dropping a later pending', () => {
    const units = pendingBacklog();
    const result = {
      rewrites: [
        { id: '02-api', title: 'invoice API v2', subtask: 'Implement endpoints against tip types.' },
        { id: '03-ui', subtask: 'Build UI against the tip API.' },
      ],
      drops: ['04-extra'],
    };
    assert.deepEqual(validateAdjustResult(result, { units, maxUnits: 8 }), []);
  });

  it('rejects rewriting more than the next two pending units', () => {
    const units = pendingBacklog();
    const result = {
      rewrites: [
        { id: '02-api', subtask: 'a' },
        { id: '03-ui', subtask: 'b' },
        { id: '04-extra', subtask: 'c' },
      ],
      drops: [],
    };
    assert.ok(validateAdjustResult(result, { units, maxUnits: 8 }).length > 0);
  });

  it('rejects rewriting a non-next pending unit (skips over first pending)', () => {
    const units = pendingBacklog();
    const result = {
      rewrites: [{ id: '03-ui', subtask: 'skip ahead' }],
      drops: [],
    };
    assert.ok(validateAdjustResult(result, { units, maxUnits: 8 }).length > 0);
  });

  it('rejects rewriting or dropping done / failed units', () => {
    const units = [
      baseUnit({ id: '01-types', state: 'done', sha: 'bbb' }),
      baseUnit({ id: '02-api', state: 'failed', slug: 'x' }),
      baseUnit({ id: '03-ui' }),
    ];
    assert.ok(
      validateAdjustResult(
        { rewrites: [{ id: '01-types', subtask: 'nope' }], drops: [] },
        { units, maxUnits: 8 },
      ).length > 0,
    );
    assert.ok(
      validateAdjustResult(
        { rewrites: [], drops: ['02-api'] },
        { units, maxUnits: 8 },
      ).length > 0,
    );
  });

  it('rejects inventing a new unit id in rewrites or drops', () => {
    const units = pendingBacklog();
    assert.ok(
      validateAdjustResult(
        { rewrites: [{ id: '99-new', title: 'n', subtask: 'n' }], drops: [] },
        { units, maxUnits: 8 },
      ).length > 0,
    );
    assert.ok(
      validateAdjustResult(
        { rewrites: [], drops: ['99-new'] },
        { units, maxUnits: 8 },
      ).length > 0,
    );
  });

  it('applyAdjustResult rewrites titles/subtasks and marks drops skipped without mutating input', () => {
    const doc = baseSeq({ units: pendingBacklog() });
    const snapshot = structuredClone(doc);
    const result = {
      rewrites: [
        { id: '02-api', title: 'invoice API v2', subtask: 'Implement against tip.' },
      ],
      drops: ['04-extra'],
    };

    const applied = applyAdjustResult(doc, result);

    assert.deepEqual(doc, snapshot);
    assert.equal(applied.units.find((u) => u.id === '02-api').title, 'invoice API v2');
    assert.equal(applied.units.find((u) => u.id === '02-api').subtask, 'Implement against tip.');
    assert.equal(applied.units.find((u) => u.id === '03-ui').subtask, 'old ui subtask');
    assert.equal(applied.units.find((u) => u.id === '04-extra').state, 'skipped');
    assert.equal(applied.units.find((u) => u.id === '01-types').state, 'done');
  });
});
