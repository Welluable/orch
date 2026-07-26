import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  readFanout,
  writeFanout,
  patchWorker,
  patchIntegration,
  validateDecomposition,
  planLayers,
  chooseConcurrency,
  buildWorkerEnvelope,
  buildIntegrationEnvelope,
  recordChangedFiles,
  detectOverlaps,
} from '../lib/fanout.js';

/**
 * Contract this file pins down for lib/fanout.js (see
 * .spec/fanout-1-foundation.md and .spec/fanout.md's fanout.json schema):
 *
 * - fanout.json lives at `<cwd>/.orch/<parentSlug>/fanout.json` and is
 *   read/written/patched with the same atomic tmp+rename + per-job lock
 *   discipline as lib/jobs.js's run.json.
 * - readFanout(cwd, parentSlug) -> parsed fanout.json, or `null` if missing.
 * - writeFanout(cwd, parentSlug, data) -> atomic full-document write.
 * - patchWorker(cwd, parentSlug, workerId, patchFnOrObject) -> locks,
 *   re-reads the latest document, shallow-merges the patch (object, or a
 *   `(currentWorker) => partialPatch` function receiving that one worker's
 *   current record) onto the matching entry in `workers[]` only, atomically
 *   writes the whole document back, unlocks, and returns the updated full
 *   fanout document.
 * - patchIntegration(cwd, parentSlug, patchFnOrObject) -> same shape, applied
 *   to the top-level `integration` object; the function form receives the
 *   current `integration` object.
 * - validateDecomposition(decomposition, { maxWorkers }) -> array of
 *   violations (empty = valid).
 * - planLayers(workers) -> array of layers, each an array of worker ids, in
 *   the same relative order as the input `workers` array.
 * - chooseConcurrency({ layerSize, maxConcurrency }) -> layerSize when
 *   maxConcurrency isn't a number, else Math.min(layerSize, maxConcurrency).
 * - buildWorkerEnvelope / buildIntegrationEnvelope -> thin prompt strings.
 * - recordChangedFiles({ repoRoot, base, branch, execFile }) -> parsed
 *   `git diff --name-only <base>..<branch>` output.
 * - detectOverlaps(workers) -> mutates each worker's `overlaps` array with
 *   paths shared by two or more workers' `changedFiles`, and returns the
 *   deduped union of every overlapping path.
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fanout-'));
}

function fanoutJsonPath(cwd, parentSlug) {
  return path.join(cwd, '.orch', parentSlug, 'fanout.json');
}

function baseWorker(overrides = {}) {
  return {
    id: '01-scaffold',
    title: 'shared billing types and stubs',
    subtask: 'Create Invoice and Charge types and register billing routes.',
    area: 'src/billing/',
    owns: ['src/billing/types.ts'],
    dependsOn: [],
    scaffold: false,
    slug: null,
    branch: null,
    state: 'pending',
    sha: null,
    changedFiles: [],
    overlaps: [],
    ...overrides,
  };
}

function baseFanout(overrides = {}) {
  return {
    parentSlug: 'wise-pine-e904',
    task: 'implement the billing module',
    base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    maxWorkers: 4,
    maxConcurrency: null,
    concurrency: 2,
    state: 'running',
    workers: [
      baseWorker({ id: '01-scaffold', scaffold: true }),
      baseWorker({
        id: '02-invoices',
        title: 'invoice endpoints',
        area: 'src/billing/invoices/',
        owns: ['src/billing/invoices/'],
        dependsOn: ['01-scaffold'],
      }),
    ],
    integration: {
      slug: null,
      pid: null,
      branch: null,
      worktree: null,
      candidates: [],
      merged: [],
      skipped: [],
      overlappingFiles: [],
      state: 'pending',
      sha: null,
    },
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

/** Fake `execFile` for argument-level unit tests (same pattern as test/worktree.test.js). */
function makeFakeExecFile(handlers) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    for (const { match, stdout, error } of handlers) {
      if (match(args)) {
        if (error) throw error;
        return stdout ?? '';
      }
    }
    throw new Error(`unhandled fake execFile call: ${command} ${args.join(' ')}`);
  };
  return { execFile, calls };
}

describe('readFanout / writeFanout', () => {
  it('returns null when fanout.json does not exist', () => {
    const cwd = makeTmpCwd();
    assert.equal(readFanout(cwd, 'no-such-parent-0000'), null);
  });

  it('round-trips a full document through an atomic write', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();

    writeFanout(cwd, doc.parentSlug, doc);

    assert.deepEqual(readFanout(cwd, doc.parentSlug), doc);
    assert.ok(fs.existsSync(fanoutJsonPath(cwd, doc.parentSlug)));
    // No leftover temp file next to the real one.
    const dir = path.dirname(fanoutJsonPath(cwd, doc.parentSlug));
    const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.') && name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('patchWorker', () => {
  it('shallow-merges an object patch onto only the matching worker', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);

    const updated = patchWorker(cwd, doc.parentSlug, '02-invoices', { state: 'done', sha: 'c3d4e5f' });

    const patchedWorker = updated.workers.find((w) => w.id === '02-invoices');
    assert.equal(patchedWorker.state, 'done');
    assert.equal(patchedWorker.sha, 'c3d4e5f');
    // Untouched fields on the patched worker survive.
    assert.equal(patchedWorker.area, 'src/billing/invoices/');
    // The other worker is untouched.
    const otherWorker = updated.workers.find((w) => w.id === '01-scaffold');
    assert.deepEqual(otherWorker, doc.workers[0]);
    // Persisted, not just returned.
    assert.deepEqual(readFanout(cwd, doc.parentSlug), updated);
  });

  it('accepts a function patch receiving the current worker record', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout({
      workers: [baseWorker({ id: '01-scaffold', changedFiles: ['src/billing/types.ts'] })],
    });
    writeFanout(cwd, doc.parentSlug, doc);

    const updated = patchWorker(cwd, doc.parentSlug, '01-scaffold', (current) => ({
      changedFiles: [...current.changedFiles, 'src/billing/index.ts'],
    }));

    const patchedWorker = updated.workers.find((w) => w.id === '01-scaffold');
    assert.deepEqual(patchedWorker.changedFiles, ['src/billing/types.ts', 'src/billing/index.ts']);
  });

  it('releases the lock file after a successful patch', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);

    patchWorker(cwd, doc.parentSlug, '02-invoices', { state: 'running' });

    const dir = path.dirname(fanoutJsonPath(cwd, doc.parentSlug));
    const lockLeftovers = fs.readdirSync(dir).filter((name) => name.includes('lock'));
    assert.deepEqual(lockLeftovers, []);
  });
});

describe('patchIntegration', () => {
  it('shallow-merges an object patch onto the top-level integration object', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout();
    writeFanout(cwd, doc.parentSlug, doc);

    const updated = patchIntegration(cwd, doc.parentSlug, { state: 'merging', candidates: ['orch/a', 'orch/b'] });

    assert.equal(updated.integration.state, 'merging');
    assert.deepEqual(updated.integration.candidates, ['orch/a', 'orch/b']);
    // Untouched integration fields survive.
    assert.deepEqual(updated.integration.merged, []);
    // workers[] is untouched.
    assert.deepEqual(updated.workers, doc.workers);
    assert.deepEqual(readFanout(cwd, doc.parentSlug), updated);
  });

  it('accepts a function patch receiving the current integration object', () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout({
      integration: {
        slug: 'tidy-heron-m2p9', pid: null, branch: null, worktree: null,
        candidates: [], merged: ['orch/a'], skipped: [], overlappingFiles: [], state: 'merging', sha: null,
      },
    });
    writeFanout(cwd, doc.parentSlug, doc);

    const updated = patchIntegration(cwd, doc.parentSlug, (current) => ({
      merged: [...current.merged, 'orch/b'],
    }));

    assert.deepEqual(updated.integration.merged, ['orch/a', 'orch/b']);
  });
});

describe('patchWorker / patchIntegration concurrency safety', () => {
  it('serializes back-to-back patches from two real processes without losing any increment', async () => {
    const cwd = makeTmpCwd();
    const doc = baseFanout({
      workers: [baseWorker({ id: '01-scaffold', changedFiles: [] })],
    });
    doc.workers[0].counter = 0;
    writeFanout(cwd, doc.parentSlug, doc);

    const fanoutPath = new URL('../lib/fanout.js', import.meta.url).pathname;
    const incrementerScript = `
      import { patchWorker } from ${JSON.stringify(`file://${fanoutPath}`)};
      for (let i = 0; i < 25; i += 1) {
        patchWorker(${JSON.stringify(cwd)}, ${JSON.stringify(doc.parentSlug)}, '01-scaffold', (current) => ({ counter: (current.counter || 0) + 1 }));
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

    const finalDoc = readFanout(cwd, doc.parentSlug);
    assert.equal(finalDoc.workers.find((w) => w.id === '01-scaffold').counter, 50);
  });
});

describe('validateDecomposition', () => {
  it('accepts a well-formed graph (empty violations array)', () => {
    const decomposition = {
      decomposable: true,
      why: 'independent endpoints',
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: false },
      ],
    };
    assert.deepEqual(validateDecomposition(decomposition, { maxWorkers: 4 }), []);
  });

  it('rejects more workers than maxWorkers', () => {
    const decomposition = {
      decomposable: true,
      workers: ['a', 'b', 'c', 'd', 'e'].map((id) => (
        { id, title: id, subtask: id, area: `src/${id}/`, owns: [`src/${id}/`], dependsOn: [], scaffold: false }
      )),
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects fewer than two workers as non-decomposable', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects a worker missing non-empty owns', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: [], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects a worker missing non-empty area', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: '', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects an unknown id referenced in dependsOn', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: ['does-not-exist'], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects a dependsOn cycle', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: ['b'], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects overlapping owns between two workers in the same layer, including prefix overlap', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/a/', owns: ['src/a/b.ts'], dependsOn: [], scaffold: false },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('accepts overlapping owns between workers in different layers (dependency separates them)', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/a/', owns: ['src/a/b.ts'], dependsOn: ['a'], scaffold: false },
      ],
    };
    assert.deepEqual(validateDecomposition(decomposition, { maxWorkers: 4 }), []);
  });

  it('rejects more than one scaffold worker', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: true },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: [], scaffold: true },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });

  it('rejects a scaffold worker that has dependencies', () => {
    const decomposition = {
      decomposable: true,
      workers: [
        { id: 'a', title: 'a', subtask: 'do a', area: 'src/a/', owns: ['src/a/'], dependsOn: [], scaffold: false },
        { id: 'b', title: 'b', subtask: 'do b', area: 'src/b/', owns: ['src/b/'], dependsOn: ['a'], scaffold: true },
      ],
    };
    const violations = validateDecomposition(decomposition, { maxWorkers: 4 });
    assert.ok(violations.length > 0);
  });
});

describe('planLayers', () => {
  it('lays out a linear chain one worker per layer, in dependency order', () => {
    const workers = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ];
    assert.deepEqual(planLayers(workers), [['a'], ['b'], ['c']]);
  });

  it('lays out a diamond (a -> b,c -> d) with b and c sharing a layer', () => {
    const workers = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ];
    assert.deepEqual(planLayers(workers), [['a'], ['b', 'c'], ['d']]);
  });

  it('puts a fully independent set entirely in one layer', () => {
    const workers = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: [] },
    ];
    assert.deepEqual(planLayers(workers), [['a', 'b', 'c']]);
  });
});

describe('chooseConcurrency', () => {
  it('returns the layer size when maxConcurrency is not a number', () => {
    assert.equal(chooseConcurrency({ layerSize: 5 }), 5);
    assert.equal(chooseConcurrency({ layerSize: 5, maxConcurrency: null }), 5);
    assert.equal(chooseConcurrency({ layerSize: 5, maxConcurrency: undefined }), 5);
  });

  it('caps at maxConcurrency when it is a number below the layer size', () => {
    assert.equal(chooseConcurrency({ layerSize: 5, maxConcurrency: 2 }), 2);
  });

  it('does not exceed the layer size when maxConcurrency is a larger number', () => {
    assert.equal(chooseConcurrency({ layerSize: 3, maxConcurrency: 10 }), 3);
  });
});

describe('buildWorkerEnvelope', () => {
  it('includes the subtask, area, and comma-separated sibling titles', () => {
    const envelope = buildWorkerEnvelope({
      subtask: 'Implement create and list invoice endpoints.',
      area: 'src/billing/invoices/',
      scaffold: false,
      siblingTitles: ['invoice endpoints', 'charge endpoints'],
    });

    assert.match(envelope, /Implement create and list invoice endpoints\./);
    assert.match(envelope, /src\/billing\/invoices\//);
    assert.match(envelope, /invoice endpoints/);
    assert.match(envelope, /charge endpoints/);
  });

  it('never includes owns paths or a reference to boundaries.md', () => {
    const envelope = buildWorkerEnvelope({
      subtask: 'Implement create and list invoice endpoints.',
      area: 'src/billing/invoices/',
      scaffold: false,
      siblingTitles: ['invoice endpoints'],
    });

    assert.doesNotMatch(envelope, /\bowns\b/i);
    assert.doesNotMatch(envelope, /boundaries\.md/i);
  });

  it('mentions pre-registering shared registries, barrels, or route tables for the scaffold variant', () => {
    const envelope = buildWorkerEnvelope({
      subtask: 'Create Invoice and Charge types and register billing routes.',
      area: 'src/billing/',
      scaffold: true,
      siblingTitles: ['invoice endpoints', 'charge endpoints'],
    });

    assert.match(envelope, /pre-register/i);
    assert.match(envelope, /registry/i);
    assert.match(envelope, /barrel/i);
    assert.match(envelope, /route-table|route table/i);
  });
});

describe('buildIntegrationEnvelope', () => {
  it('lists branches in the given order', () => {
    const envelope = buildIntegrationEnvelope({
      task: 'implement the billing module',
      branches: ['orch/rapid-fox-x7q2', 'orch/merry-elk-r4b1'],
      overlappingFiles: [],
    });

    const firstIndex = envelope.indexOf('orch/rapid-fox-x7q2');
    const secondIndex = envelope.indexOf('orch/merry-elk-r4b1');
    assert.ok(firstIndex !== -1 && secondIndex !== -1);
    assert.ok(firstIndex < secondIndex);
    assert.match(envelope, /implement the billing module/);
  });

  it('renders the literal "none" when there are no overlapping files', () => {
    const envelope = buildIntegrationEnvelope({
      task: 'implement the billing module',
      branches: ['orch/a'],
      overlappingFiles: [],
    });

    assert.match(envelope, /\bnone\b/);
  });

  it('renders overlapping paths when present', () => {
    const envelope = buildIntegrationEnvelope({
      task: 'implement the billing module',
      branches: ['orch/a', 'orch/b'],
      overlappingFiles: ['src/billing/index.ts', 'src/routes/billing.ts'],
    });

    assert.match(envelope, /src\/billing\/index\.ts/);
    assert.match(envelope, /src\/routes\/billing\.ts/);
  });

  it('never includes owns or parent research text', () => {
    const envelope = buildIntegrationEnvelope({
      task: 'implement the billing module',
      branches: ['orch/a'],
      overlappingFiles: [],
    });

    assert.doesNotMatch(envelope, /\bowns\b/i);
    assert.doesNotMatch(envelope, /boundaries\.md/i);
  });
});

describe('recordChangedFiles', () => {
  it('parses git diff --name-only output into a file path array', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: (args) => args.includes('diff'), stdout: 'src/billing/types.ts\nsrc/routes/billing.ts\n' },
    ]);

    const result = recordChangedFiles({
      repoRoot: '/repo/root',
      base: 'a1b2c3d',
      branch: 'orch/rapid-fox-x7q2',
      execFile,
    });

    assert.deepEqual(result, ['src/billing/types.ts', 'src/routes/billing.ts']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-C', '/repo/root', 'diff', '--name-only', 'a1b2c3d..orch/rapid-fox-x7q2']);
  });

  it('returns an empty array when nothing changed', () => {
    const { execFile } = makeFakeExecFile([
      { match: (args) => args.includes('diff'), stdout: '' },
    ]);

    const result = recordChangedFiles({
      repoRoot: '/repo/root',
      base: 'a1b2c3d',
      branch: 'orch/rapid-fox-x7q2',
      execFile,
    });

    assert.deepEqual(result, []);
  });
});

describe('detectOverlaps', () => {
  it('populates overlaps on both workers that share a changed file, and returns the union', () => {
    const workers = [
      { id: 'a', owns: ['src/a/'], changedFiles: ['src/a/one.ts', 'src/shared.ts'], overlaps: [] },
      { id: 'b', owns: ['src/b/'], changedFiles: ['src/b/two.ts', 'src/shared.ts'], overlaps: [] },
    ];

    const union = detectOverlaps(workers);

    assert.deepEqual(workers.find((w) => w.id === 'a').overlaps, ['src/shared.ts']);
    assert.deepEqual(workers.find((w) => w.id === 'b').overlaps, ['src/shared.ts']);
    assert.deepEqual(union, ['src/shared.ts']);
  });

  it('does not flag a file only one worker touched, even when outside its owns', () => {
    const workers = [
      { id: 'a', owns: ['src/a/'], changedFiles: ['src/a/one.ts', 'src/lone-wanderer.ts'], overlaps: [] },
      { id: 'b', owns: ['src/b/'], changedFiles: ['src/b/two.ts'], overlaps: [] },
    ];

    const union = detectOverlaps(workers);

    assert.deepEqual(workers.find((w) => w.id === 'a').overlaps, []);
    assert.deepEqual(workers.find((w) => w.id === 'b').overlaps, []);
    assert.deepEqual(union, []);
  });
});
