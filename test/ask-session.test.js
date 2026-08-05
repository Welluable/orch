import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  askSessionPaths,
  readAskSession,
  writeAskSession,
  appendAskTurns,
  recordAskExchange,
} from '../lib/ask-session.js';

/**
 * Contract for lib/ask-session.js (unit 01-ask-session / persist ask chat
 * sessions under `.orch/<slug>/`):
 *
 * - askSessionPaths(cwd, slug) -> { dir, askJsonPath, lockPath }, all
 *   absolute and rooted under `<cwd>/.orch/<slug>/`. ask.json sits beside
 *   run.json; lock is `.ask.lock` (not `.run.lock`).
 * - readAskSession(cwd, slug) -> parsed ask.json, or `null` if missing.
 *   Throws on invalid JSON.
 * - writeAskSession(cwd, slug, data) -> atomic write-temp+rename of the full
 *   document; creates the job dir if missing; leaves no stray `.tmp` files.
 * - appendAskTurns(cwd, slug, { agent?, turns }) -> acquires `.ask.lock`,
 *   creates a minimal session doc on first write
 *   `{ slug, createdAt, updatedAt, agent?, turns: [] }`, appends `turns` in
 *   order, bumps `updatedAt`, releases the lock, returns the updated doc.
 *   Stale locks (dead owner pid) are removed like jobs/seq.
 * - recordAskExchange(cwd, slug, { prompt, answer, agent? }) -> convenience
 *   for the `--ask` branch: appends one `user` turn (`prompt`) then one
 *   `assistant` turn (`answer`) with optional ISO `at` timestamps. Does not
 *   invent assistant content — callers only invoke this on success.
 * - Schema is intentionally minimal for unit 02 reload: slug metadata +
 *   ordered turns `{ role, content, at? }`. Full transcript stays in
 *   ask.json — never embed turns inside run.json.
 */

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ask-session-'));
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  return pid;
}

function baseSession(overrides = {}) {
  const now = '2026-08-05T10:00:00.000Z';
  return {
    slug: 'ask-chat-0000',
    createdAt: now,
    updatedAt: now,
    agent: 'claude',
    turns: [
      { role: 'user', content: 'where is the CLI entrypoint?', at: now },
      { role: 'assistant', content: 'The entrypoint is main.js.', at: now },
    ],
    ...overrides,
  };
}

describe('askSessionPaths', () => {
  it('returns absolute paths rooted under <cwd>/.orch/<slug>/ (ask.json + .ask.lock)', () => {
    const tmpCwd = makeTmpCwd();
    const paths = askSessionPaths(tmpCwd, 'wise-otter-8a1a');

    assert.equal(paths.dir, path.join(tmpCwd, '.orch', 'wise-otter-8a1a'));
    assert.equal(paths.askJsonPath, path.join(paths.dir, 'ask.json'));
    assert.equal(paths.lockPath, path.join(paths.dir, '.ask.lock'));
    for (const p of Object.values(paths)) {
      assert.ok(path.isAbsolute(p), `${p} should be absolute`);
    }
  });
});

describe('writeAskSession / readAskSession', () => {
  it('round-trips a session through an atomic write (no leftover temp files)', () => {
    const tmpCwd = makeTmpCwd();
    const session = baseSession();

    writeAskSession(tmpCwd, session.slug, session);

    const read = readAskSession(tmpCwd, session.slug);
    assert.deepEqual(read, session);

    const { dir } = askSessionPaths(tmpCwd, session.slug);
    assert.deepEqual(fs.readdirSync(dir), ['ask.json']);
  });

  it('creates the job directory if it does not already exist', () => {
    const tmpCwd = makeTmpCwd();
    const session = baseSession({ slug: 'brand-new-ask-0001' });

    assert.equal(fs.existsSync(askSessionPaths(tmpCwd, session.slug).dir), false);
    writeAskSession(tmpCwd, session.slug, session);
    assert.equal(fs.existsSync(askSessionPaths(tmpCwd, session.slug).dir), true);
  });

  it('readAskSession returns null when ask.json is missing', () => {
    const tmpCwd = makeTmpCwd();
    assert.equal(readAskSession(tmpCwd, 'never-created-0000'), null);
  });

  it('readAskSession throws on malformed JSON rather than silently returning null', () => {
    const tmpCwd = makeTmpCwd();
    const { dir, askJsonPath } = askSessionPaths(tmpCwd, 'broken-ask-0000');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(askJsonPath, '{ not valid json');

    assert.throws(() => readAskSession(tmpCwd, 'broken-ask-0000'));
  });
});

describe('appendAskTurns', () => {
  it('creates a session on first append with slug metadata and ordered turns', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'first-turn-0000';
    const before = Date.now();

    const doc = appendAskTurns(tmpCwd, slug, {
      agent: 'claude',
      turns: [
        { role: 'user', content: 'what is orch?' },
        { role: 'assistant', content: 'An orchestration CLI.' },
      ],
    });

    const after = Date.now();
    assert.equal(doc.slug, slug);
    assert.equal(doc.agent, 'claude');
    assert.equal(doc.turns.length, 2);
    assert.equal(doc.turns[0].role, 'user');
    assert.equal(doc.turns[0].content, 'what is orch?');
    assert.equal(doc.turns[1].role, 'assistant');
    assert.equal(doc.turns[1].content, 'An orchestration CLI.');
    assert.ok(doc.createdAt);
    assert.ok(doc.updatedAt);
    assert.ok(Date.parse(doc.createdAt) >= before - 1000);
    assert.ok(Date.parse(doc.updatedAt) <= after + 1000);

    assert.deepEqual(readAskSession(tmpCwd, slug), doc);
    assert.equal(fs.existsSync(askSessionPaths(tmpCwd, slug).lockPath), false);
  });

  it('appends further turns onto an existing session without dropping prior ones', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'multi-turn-0000';

    appendAskTurns(tmpCwd, slug, {
      agent: 'claude',
      turns: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    const firstUpdatedAt = readAskSession(tmpCwd, slug).updatedAt;

    const doc = appendAskTurns(tmpCwd, slug, {
      turns: [
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
      ],
    });

    assert.equal(doc.turns.length, 4);
    assert.deepEqual(
      doc.turns.map((t) => t.content),
      ['q1', 'a1', 'q2', 'a2'],
    );
    assert.equal(doc.slug, slug);
    assert.equal(doc.agent, 'claude');
    assert.notEqual(doc.updatedAt, firstUpdatedAt);
    assert.equal(doc.createdAt, readAskSession(tmpCwd, slug).createdAt);
  });

  it('removes a stale lock (owner pid dead) instead of hanging, then proceeds', async () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'stale-ask-lock-0000';
    writeAskSession(tmpCwd, slug, baseSession({ slug, turns: [] }));

    const { dir, lockPath } = askSessionPaths(tmpCwd, slug);
    fs.mkdirSync(dir, { recursive: true });
    const staleOwnerPid = await deadPid();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: staleOwnerPid }));

    const updated = appendAskTurns(tmpCwd, slug, {
      turns: [{ role: 'user', content: 'after stale lock' }],
    });

    assert.equal(updated.turns.at(-1).content, 'after stale lock');
    assert.equal(fs.existsSync(lockPath), false);
  });
});

describe('recordAskExchange', () => {
  it('records one user + one assistant turn (create on first exchange)', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'exchange-0000';

    const doc = recordAskExchange(tmpCwd, slug, {
      prompt: 'where is the CLI entrypoint?',
      answer: 'The entrypoint is main.js.',
      agent: 'cursor',
    });

    assert.equal(doc.slug, slug);
    assert.equal(doc.agent, 'cursor');
    assert.equal(doc.turns.length, 2);
    assert.equal(doc.turns[0].role, 'user');
    assert.equal(doc.turns[0].content, 'where is the CLI entrypoint?');
    assert.equal(doc.turns[1].role, 'assistant');
    assert.equal(doc.turns[1].content, 'The entrypoint is main.js.');
    assert.ok(doc.turns[0].at);
    assert.ok(doc.turns[1].at);
  });

  it('appends a second exchange onto the same slug session', () => {
    const tmpCwd = makeTmpCwd();
    const slug = 'exchange-continue-0000';

    recordAskExchange(tmpCwd, slug, {
      prompt: 'q1',
      answer: 'a1',
      agent: 'claude',
    });
    const doc = recordAskExchange(tmpCwd, slug, {
      prompt: 'q2',
      answer: 'a2',
      agent: 'claude',
    });

    assert.equal(doc.turns.length, 4);
    assert.deepEqual(
      doc.turns.map((t) => ({ role: t.role, content: t.content })),
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
      ],
    );
  });
});
