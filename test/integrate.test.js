import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBranches,
  abortMerge,
  conflictedFiles,
  hasConflictMarkers,
} from '../lib/integrate.js';

/**
 * Contract this file pins down for lib/integrate.js (see
 * .spec/fanout-1-foundation.md and .spec/fanout.md's integration section):
 *
 * - mergeBranches({ cwd, candidates, merged, overlappingFiles, execFile }):
 *   walks `candidates` in order, skipping any already present in `merged`
 *   (recorded as `status: 'skipped'`); for each remaining branch runs
 *   `git -C <cwd> merge --no-ff <branch>` via the injectable `execFile`; a
 *   clean merge records `status: 'merged'`; a thrown/non-zero merge records
 *   `status: 'conflict'` and the driver stops advancing to further
 *   candidates (the tree is left conflicted; no auto-abort, no attempt at
 *   subsequent branches). Returns the array of per-branch results produced
 *   so far.
 * - abortMerge({ cwd, execFile }): runs `git -C <cwd> merge --abort`.
 * - conflictedFiles({ cwd, execFile }): runs
 *   `git -C <cwd> diff --name-only --diff-filter=U` and returns the parsed
 *   path array.
 * - hasConflictMarkers({ cwd, execFile }): runs `git -C <cwd> diff` and
 *   returns true iff the output still contains a `<<<<<<<` marker.
 */

function isMergeNoFf(args) {
  return args.includes('merge') && args.includes('--no-ff');
}

function isAbort(args) {
  return args.includes('merge') && args.includes('--abort');
}

function isConflictedFilesDiff(args) {
  return args.includes('diff') && args.includes('--diff-filter=U');
}

function isPlainDiff(args) {
  return args.includes('diff') && !args.includes('--diff-filter=U') && !args.includes('--name-only');
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

describe('mergeBranches', () => {
  it('accumulates status: merged across multiple clean candidates, in order', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isMergeNoFf, stdout: '' },
    ]);

    const result = mergeBranches({
      cwd: '/repo/root-parent',
      candidates: ['orch/a', 'orch/b', 'orch/c'],
      merged: [],
      overlappingFiles: [],
      execFile,
    });

    assert.deepEqual(result.map((r) => ({ branch: r.branch, status: r.status })), [
      { branch: 'orch/a', status: 'merged' },
      { branch: 'orch/b', status: 'merged' },
      { branch: 'orch/c', status: 'merged' },
    ]);
    assert.equal(calls.filter((c) => isMergeNoFf(c.args)).length, 3);
    calls.forEach((c) => assert.deepEqual(c.args.slice(0, 2), ['-C', '/repo/root-parent']));
  });

  it('skips branches already present in merged without invoking git', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isMergeNoFf, stdout: '' },
    ]);

    const result = mergeBranches({
      cwd: '/repo/root-parent',
      candidates: ['orch/a', 'orch/b'],
      merged: ['orch/a'],
      overlappingFiles: [],
      execFile,
    });

    assert.deepEqual(result.map((r) => ({ branch: r.branch, status: r.status })), [
      { branch: 'orch/a', status: 'skipped' },
      { branch: 'orch/b', status: 'merged' },
    ]);
    assert.equal(calls.filter((c) => isMergeNoFf(c.args) && c.args.includes('orch/a')).length, 0);
  });

  it('stops advancing past a conflicting merge and does not auto-abort', () => {
    const conflictError = Object.assign(new Error('git merge failed'), {
      stderr: 'CONFLICT (content): Merge conflict in src/shared.ts',
    });
    const { execFile, calls } = makeFakeExecFile([
      {
        match: (args) => isMergeNoFf(args) && args.includes('orch/a'),
        stdout: '',
      },
      {
        match: (args) => isMergeNoFf(args) && args.includes('orch/b'),
        error: conflictError,
      },
      {
        match: (args) => isMergeNoFf(args) && args.includes('orch/c'),
        stdout: '',
      },
    ]);

    const result = mergeBranches({
      cwd: '/repo/root-parent',
      candidates: ['orch/a', 'orch/b', 'orch/c'],
      merged: [],
      overlappingFiles: ['src/shared.ts'],
      execFile,
    });

    assert.deepEqual(result.map((r) => ({ branch: r.branch, status: r.status })), [
      { branch: 'orch/a', status: 'merged' },
      { branch: 'orch/b', status: 'conflict' },
    ]);
    // orch/c was never attempted.
    assert.equal(calls.filter((c) => isMergeNoFf(c.args) && c.args.includes('orch/c')).length, 0);
    // No automatic abort.
    assert.equal(calls.filter((c) => isAbort(c.args)).length, 0);
  });
});

describe('abortMerge', () => {
  it('runs git merge --abort in the given cwd', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isAbort, stdout: '' },
    ]);

    abortMerge({ cwd: '/repo/root-parent', execFile });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-C', '/repo/root-parent', 'merge', '--abort']);
  });
});

describe('conflictedFiles', () => {
  it('parses git diff --name-only --diff-filter=U output into a path array', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isConflictedFilesDiff, stdout: 'src/shared.ts\nsrc/other.ts\n' },
    ]);

    const result = conflictedFiles({ cwd: '/repo/root-parent', execFile });

    assert.deepEqual(result, ['src/shared.ts', 'src/other.ts']);
    assert.deepEqual(calls[0].args, ['-C', '/repo/root-parent', 'diff', '--name-only', '--diff-filter=U']);
  });

  it('returns an empty array when nothing is conflicted', () => {
    const { execFile } = makeFakeExecFile([
      { match: isConflictedFilesDiff, stdout: '' },
    ]);

    assert.deepEqual(conflictedFiles({ cwd: '/repo/root-parent', execFile }), []);
  });
});

describe('hasConflictMarkers', () => {
  it('returns true when the diff still contains a <<<<<<< marker', () => {
    const { execFile } = makeFakeExecFile([
      {
        match: isPlainDiff,
        stdout: '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> orch/b\n',
      },
    ]);

    assert.equal(hasConflictMarkers({ cwd: '/repo/root-parent', execFile }), true);
  });

  it('returns false once a claimed repair has removed the markers', () => {
    const { execFile } = makeFakeExecFile([
      { match: isPlainDiff, stdout: 'resolved content, no markers here\n' },
    ]);

    assert.equal(hasConflictMarkers({ cwd: '/repo/root-parent', execFile }), false);
  });
});

describe('abortMerge restoring a clean state after a conflict', () => {
  it('conflictedFiles reports the conflict, then reports clean after abortMerge', () => {
    let aborted = false;
    const calls = [];
    const execFile = (command, args) => {
      calls.push(args);
      if (isAbort(args)) {
        aborted = true;
        return '';
      }
      if (isConflictedFilesDiff(args)) {
        return aborted ? '' : 'src/shared.ts\n';
      }
      return '';
    };

    assert.deepEqual(conflictedFiles({ cwd: '/repo/root-parent', execFile }), ['src/shared.ts']);

    abortMerge({ cwd: '/repo/root-parent', execFile });

    assert.deepEqual(conflictedFiles({ cwd: '/repo/root-parent', execFile }), []);
    assert.ok(calls.some((args) => isAbort(args)));
  });
});
