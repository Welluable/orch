import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FileTracker } from '../lib/file-tracker.js';

const WORKTREE = '/repo/root-slug';

function recordPair(tracker, { name, args, callId, completedArgs }) {
  tracker.record({ name, args, phase: 'started', callId });
  tracker.record({
    name: name === 'MultiEdit' ? 'edit' : name,
    args: completedArgs ?? {},
    phase: 'completed',
    callId,
  });
}

describe('FileTracker', () => {
  it('maps Write → +, Edit → ~, Delete → - (case-insensitive names)', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    recordPair(tracker, { name: 'Write', args: { path: 'a.js' }, callId: '1' });
    recordPair(tracker, { name: 'edit', args: { path: 'b.js' }, callId: '2' });
    recordPair(tracker, { name: 'DELETE', args: { path: 'c.js' }, callId: '3' });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '+', path: 'a.js' },
      { marker: '~', path: 'b.js' },
      { marker: '-', path: 'c.js' },
    ]);
  });

  it('treats Claude MultiEdit (already normalized to edit) as ~', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    // Stream layer maps MultiEdit → edit before onToolEvent; tracker still
    // accepts the normalized name and the PascalCase form.
    recordPair(tracker, {
      name: 'edit',
      args: { file_path: 'lib/tool-status.js' },
      callId: 'toolu_3',
    });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '~', path: 'lib/tool-status.js' },
    ]);
  });

  it('recalls path from started when completed args are empty (Claude/agn)', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    tracker.record({
      name: 'write',
      args: { file_path: 'lib/agent.js' },
      phase: 'started',
      callId: 'toolu_2',
    });
    tracker.record({
      name: '',
      args: {},
      phase: 'completed',
      callId: 'toolu_2',
    });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '+', path: 'lib/agent.js' },
    ]);
  });

  it('accepts path from either args.path or args.file_path', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    recordPair(tracker, {
      name: 'Write',
      args: { path: 'via-path.js' },
      callId: 'p1',
      completedArgs: { path: 'via-path.js' },
    });
    recordPair(tracker, {
      name: 'write',
      args: { file_path: 'via-file-path.js' },
      callId: 'p2',
    });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '+', path: 'via-path.js' },
      { marker: '+', path: 'via-file-path.js' },
    ]);
  });

  it('keeps first-seen order and last-seen marker on dedupe', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    recordPair(tracker, { name: 'Write', args: { path: 'a.js' }, callId: '1' });
    recordPair(tracker, { name: 'Write', args: { path: 'b.js' }, callId: '2' });
    recordPair(tracker, { name: 'Edit', args: { path: 'a.js' }, callId: '3' });
    recordPair(tracker, { name: 'Delete', args: { path: 'b.js' }, callId: '4' });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '~', path: 'a.js' },
      { marker: '-', path: 'b.js' },
    ]);
  });

  it('normalizes absolute paths to worktree-relative', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });
    const abs = path.join(WORKTREE, 'lib', 'file-tracker.js');

    recordPair(tracker, {
      name: 'Write',
      args: { path: abs },
      callId: '1',
      completedArgs: { path: abs },
    });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '+', path: 'lib/file-tracker.js' },
    ]);
  });

  it('skips paths that never completed', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    tracker.record({
      name: 'Write',
      args: { path: 'pending.js' },
      phase: 'started',
      callId: 'hang',
    });
    recordPair(tracker, { name: 'Edit', args: { path: 'done.js' }, callId: 'ok' });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '~', path: 'done.js' },
    ]);
  });

  it('ignores non-file tools (Read, Shell, Grep, …)', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    for (const [name, args, callId] of [
      ['Read', { path: 'a.js' }, 'r1'],
      ['Shell', { command: 'npm test' }, 's1'],
      ['Grep', { pattern: 'foo' }, 'g1'],
      ['read', { file_path: 'b.js' }, 'r2'],
      ['shell', { command: 'ls' }, 's2'],
    ]) {
      recordPair(tracker, { name, args, callId });
    }
    recordPair(tracker, { name: 'Write', args: { path: 'kept.js' }, callId: 'w1' });

    assert.deepEqual(tracker.getFiles(), [
      { marker: '+', path: 'kept.js' },
    ]);
  });

  it('skips completed write/edit/delete when no path is known on started or completed', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    tracker.record({ name: 'Write', args: {}, phase: 'started', callId: 'x' });
    tracker.record({ name: 'Write', args: {}, phase: 'completed', callId: 'x' });

    assert.deepEqual(tracker.getFiles(), []);
  });

  it('record returns isNew:true only on the first live-eligible completion per path', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    tracker.record({ name: 'Write', args: { path: 'a.js' }, phase: 'started', callId: '1' });
    const first = tracker.record({
      name: 'Write',
      args: { path: 'a.js' },
      phase: 'completed',
      callId: '1',
    });
    tracker.record({ name: 'Edit', args: { path: 'a.js' }, phase: 'started', callId: '2' });
    const second = tracker.record({
      name: 'Edit',
      args: { path: 'a.js' },
      phase: 'completed',
      callId: '2',
    });

    assert.equal(first?.isNew, true);
    assert.equal(first?.marker, '+');
    assert.equal(first?.path, 'a.js');
    assert.equal(second?.isNew, false);
    assert.equal(second?.marker, '~');
    assert.deepEqual(tracker.getFiles(), [{ marker: '~', path: 'a.js' }]);
  });

  it('started-only and non-file record calls return null / non-isNew', () => {
    const tracker = new FileTracker({ cwd: WORKTREE });

    assert.equal(
      tracker.record({ name: 'Write', args: { path: 'a.js' }, phase: 'started', callId: '1' }),
      null,
    );
    assert.equal(
      tracker.record({ name: 'Read', args: { path: 'a.js' }, phase: 'completed', callId: '2' }),
      null,
    );
  });
});
