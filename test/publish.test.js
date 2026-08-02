import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBaseBranch,
  fetchBase,
  pushBranch,
  findOpenPullRequest,
  createPullRequest,
  publish,
} from '../lib/publish.js';

/**
 * Fake `execFile` for argument-level unit tests. Mirrors test/commit.test.js /
 * test/worktree.test.js — handlers match on argv; every call is recorded.
 */
function makeFakeExecFile(handlers) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    for (const { match, stdout, error } of handlers) {
      if (match(command, args, options)) {
        if (error) throw error;
        return stdout ?? '';
      }
    }
    throw new Error(`unhandled fake execFile call: ${command} ${(args || []).join(' ')}`);
  };
  return { execFile, calls };
}

const isSymbolicRef = (command, args) =>
  command === 'git' && args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD');
const isSetHead = (command, args) =>
  command === 'git' && args.includes('remote') && args.includes('set-head');
const isFetch = (command, args) =>
  command === 'git' && args.includes('fetch');
const isPush = (command, args) =>
  command === 'git' && args.includes('push');
const isPrList = (command, args) =>
  command === 'gh' && args.includes('pr') && args.includes('list');
const isPrCreate = (command, args) =>
  command === 'gh' && args.includes('pr') && args.includes('create');

describe('resolveBaseBranch', () => {
  it('strips the origin/ prefix from refs/remotes/origin/HEAD', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isSymbolicRef, stdout: 'origin/main\n' },
    ]);

    assert.equal(resolveBaseBranch({ cwd: '/repo', execFile }), 'main');
    assert.equal(calls[0].command, 'git');
    assert.ok(calls[0].args.includes('symbolic-ref'));
    assert.ok(calls[0].args.includes('--short'));
    assert.ok(calls[0].args.includes('refs/remotes/origin/HEAD'));
    assert.ok(
      calls[0].args.includes('-C') && calls[0].args.includes('/repo'),
      'must run against the invocation cwd',
    );
  });

  it('runs set-head --auto once and retries when the symbolic-ref is missing', () => {
    const calls = [];
    let attempt = 0;
    const execFile = (command, args, options) => {
      calls.push({ command, args, options });
      if (isSymbolicRef(command, args)) {
        attempt += 1;
        if (attempt === 1) {
          throw Object.assign(new Error('git failed'), {
            stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
          });
        }
        return 'origin/trunk\n';
      }
      if (isSetHead(command, args)) {
        assert.ok(args.includes('remote') && args.includes('set-head'));
        assert.ok(args.includes('origin') && args.includes('--auto'));
        return '';
      }
      throw new Error(`unhandled: ${command} ${args.join(' ')}`);
    };

    assert.equal(resolveBaseBranch({ cwd: '/repo', execFile }), 'trunk');
    assert.equal(attempt, 2);
    assert.equal(calls.filter((c) => isSetHead(c.command, c.args)).length, 1);
  });

  it('errors cleanly when the ref is still missing after set-head --auto', () => {
    const execFile = (command, args) => {
      if (isSymbolicRef(command, args)) {
        throw Object.assign(new Error('git failed'), {
          stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref',
        });
      }
      if (isSetHead(command, args)) return '';
      throw new Error(`unhandled: ${command} ${args.join(' ')}`);
    };

    assert.throws(
      () => resolveBaseBranch({ cwd: '/repo', execFile }),
      /origin\/HEAD|default branch|symbolic-ref|set-head/i,
    );
  });
});

describe('fetchBase', () => {
  it('runs git fetch origin <base> in the invocation cwd', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isFetch, stdout: '' },
    ]);

    fetchBase({ cwd: '/repo', remote: 'origin', base: 'main', execFile });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'git');
    assert.deepEqual(calls[0].args, ['-C', '/repo', 'fetch', 'origin', 'main']);
  });

  it('wraps fetch failures like runGit', () => {
    const { execFile } = makeFakeExecFile([
      {
        match: isFetch,
        error: Object.assign(new Error('git failed'), { stderr: 'fatal: couldn\'t find remote ref main' }),
      },
    ]);

    assert.throws(
      () => fetchBase({ cwd: '/repo', remote: 'origin', base: 'main', execFile }),
      /couldn't find remote ref main/,
    );
  });
});

describe('pushBranch', () => {
  it('issues push -u origin <branch> against the worktree path', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isPush, stdout: 'ok\n' },
    ]);

    pushBranch({
      worktreePath: '/repo-slug',
      remote: 'origin',
      branch: 'orch/brave-kestrel-0ad0',
      execFile,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'git');
    assert.deepEqual(calls[0].args, [
      '-C',
      '/repo-slug',
      'push',
      '-u',
      'origin',
      'orch/brave-kestrel-0ad0',
    ]);
  });

  it('wraps push failures with stderr', () => {
    const { execFile } = makeFakeExecFile([
      {
        match: isPush,
        error: Object.assign(new Error('git failed'), { stderr: 'remote rejected' }),
      },
    ]);

    assert.throws(
      () => pushBranch({
        worktreePath: '/repo-slug',
        remote: 'origin',
        branch: 'orch/slug',
        execFile,
      }),
      /remote rejected/,
    );
  });
});

describe('findOpenPullRequest', () => {
  it('returns null on empty gh output', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isPrList, stdout: '[]\n' },
    ]);

    const result = findOpenPullRequest({
      worktreePath: '/repo-slug',
      branch: 'orch/brave-kestrel-0ad0',
      execFile,
    });

    assert.equal(result, null);
    assert.equal(calls[0].command, 'gh');
    assert.ok(calls[0].args.includes('pr'));
    assert.ok(calls[0].args.includes('list'));
    assert.ok(calls[0].args.includes('--head'));
    assert.ok(calls[0].args.includes('orch/brave-kestrel-0ad0'));
    assert.ok(calls[0].args.includes('--state'));
    assert.ok(calls[0].args.includes('open'));
    assert.ok(calls[0].args.includes('--json'));
    assert.ok(calls[0].args.includes('url,number') || (
      calls[0].args.includes('url') && calls[0].args.includes('number')
    ));
  });

  it('returns { url, number } when an open PR exists', () => {
    const { execFile } = makeFakeExecFile([
      {
        match: isPrList,
        stdout: JSON.stringify([
          { url: 'https://github.com/owner/repo/pull/42', number: 42 },
        ]),
      },
    ]);

    assert.deepEqual(
      findOpenPullRequest({
        worktreePath: '/repo-slug',
        branch: 'orch/slug',
        execFile,
      }),
      { url: 'https://github.com/owner/repo/pull/42', number: 42 },
    );
  });
});

describe('createPullRequest', () => {
  it('passes --body-file and parses the URL and number from gh output', () => {
    const { execFile, calls } = makeFakeExecFile([
      {
        match: isPrCreate,
        stdout: 'https://github.com/owner/repo/pull/7\n',
      },
    ]);

    const result = createPullRequest({
      worktreePath: '/repo-slug',
      base: 'main',
      branch: 'orch/brave-kestrel-0ad0',
      title: 'Add publish phase',
      bodyPath: '/repo/.orch/brave-kestrel-0ad0/pr.md',
      execFile,
    });

    assert.deepEqual(result, {
      url: 'https://github.com/owner/repo/pull/7',
      number: 7,
    });

    assert.equal(calls[0].command, 'gh');
    const args = calls[0].args;
    assert.ok(args.includes('pr') && args.includes('create'));
    assert.ok(args.includes('--base') && args.includes('main'));
    assert.ok(args.includes('--head') && args.includes('orch/brave-kestrel-0ad0'));
    assert.ok(args.includes('--title') && args.includes('Add publish phase'));
    assert.ok(args.includes('--body-file') && args.includes('/repo/.orch/brave-kestrel-0ad0/pr.md'));
    // Prefer cwd=worktree over shell strings; either cwd option or equivalent is fine
    // as long as args stay an array of strings.
    args.forEach((arg) => assert.equal(typeof arg, 'string'));
  });

  it('wraps gh pr create failures with stderr', () => {
    const { execFile } = makeFakeExecFile([
      {
        match: isPrCreate,
        error: Object.assign(new Error('gh failed'), { stderr: 'GraphQL: Resource not accessible' }),
      },
    ]);

    assert.throws(
      () => createPullRequest({
        worktreePath: '/repo-slug',
        base: 'main',
        branch: 'orch/slug',
        title: 'title',
        bodyPath: '/tmp/pr.md',
        execFile,
      }),
      /Resource not accessible/,
    );
  });
});

/**
 * Spec Tests: Existing PR / push→find→create orchestration.
 * `publish` must call push, then findOpenPullRequest; a non-empty find skips
 * `gh pr create`. Covered with stub execFile — not a mocked return value.
 */
describe('publish (push → find → create orchestration)', () => {
  const baseArgs = {
    worktreePath: '/repo-slug',
    remote: 'origin',
    branch: 'orch/brave-kestrel-0ad0',
    base: 'main',
    title: 'Add publish phase',
    bodyPath: '/repo/.orch/brave-kestrel-0ad0/pr.md',
  };

  it('existing PR: push then non-empty findOpenPullRequest skips gh pr create', () => {
    const existingUrl = 'https://github.com/owner/repo/pull/99';
    const { execFile, calls } = makeFakeExecFile([
      { match: isPush, stdout: 'ok\n' },
      {
        match: isPrList,
        stdout: JSON.stringify([{ url: existingUrl, number: 99 }]),
      },
      {
        match: isPrCreate,
        error: new Error('gh pr create must not run when an open PR already exists'),
      },
    ]);

    const result = publish({ ...baseArgs, execFile });

    assert.deepEqual(result, { url: existingUrl, number: 99, reused: true });
    assert.equal(calls.filter((c) => isPush(c.command, c.args)).length, 1);
    assert.equal(calls.filter((c) => isPrList(c.command, c.args)).length, 1);
    assert.equal(
      calls.filter((c) => isPrCreate(c.command, c.args)).length,
      0,
      'must not invoke gh pr create when findOpenPullRequest is non-empty',
    );
    // Ordering: push before list
    const pushIdx = calls.findIndex((c) => isPush(c.command, c.args));
    const listIdx = calls.findIndex((c) => isPrList(c.command, c.args));
    assert.ok(pushIdx >= 0 && listIdx > pushIdx, 'push must precede pr list');
  });

  it('empty findOpenPullRequest runs gh pr create after push', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isPush, stdout: 'ok\n' },
      { match: isPrList, stdout: '[]\n' },
      {
        match: isPrCreate,
        stdout: 'https://github.com/owner/repo/pull/7\n',
      },
    ]);

    const result = publish({ ...baseArgs, execFile });

    assert.deepEqual(result, { url: 'https://github.com/owner/repo/pull/7', number: 7 });
    assert.equal(calls.filter((c) => isPush(c.command, c.args)).length, 1);
    assert.equal(calls.filter((c) => isPrList(c.command, c.args)).length, 1);
    assert.equal(calls.filter((c) => isPrCreate(c.command, c.args)).length, 1);
    const createArgs = calls.find((c) => isPrCreate(c.command, c.args)).args;
    assert.ok(createArgs.includes('--base') && createArgs.includes('main'));
    assert.ok(createArgs.includes('--body-file') && createArgs.includes(baseArgs.bodyPath));
  });

  it('propagates pushBranch failure and never lists or creates a PR', () => {
    const { execFile, calls } = makeFakeExecFile([
      {
        match: isPush,
        error: Object.assign(new Error('git failed'), { stderr: 'remote rejected' }),
      },
    ]);

    assert.throws(
      () => publish({ ...baseArgs, execFile }),
      /remote rejected/,
    );
    assert.equal(calls.filter((c) => isPrList(c.command, c.args)).length, 0);
    assert.equal(calls.filter((c) => isPrCreate(c.command, c.args)).length, 0);
  });

  it('propagates createPullRequest failure after a successful push and empty find', () => {
    const { execFile, calls } = makeFakeExecFile([
      { match: isPush, stdout: 'ok\n' },
      { match: isPrList, stdout: '[]\n' },
      {
        match: isPrCreate,
        error: Object.assign(new Error('gh failed'), { stderr: 'GraphQL: Resource not accessible' }),
      },
    ]);

    assert.throws(
      () => publish({ ...baseArgs, execFile }),
      /Resource not accessible/,
    );
    assert.equal(calls.filter((c) => isPush(c.command, c.args)).length, 1);
    assert.equal(calls.filter((c) => isPrCreate(c.command, c.args)).length, 1);
  });
});
