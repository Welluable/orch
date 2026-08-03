import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobPaths, readJob, writeJob } from '../lib/jobs.js';

/**
 * Contract for `.spec/server.md` phases 1–3 (serve jobs + products + scan/files):
 *
 * - `orch serve` binds home to `os.homedir()` (injectable `homedir` in tests),
 *   ensures `$HOME/.orch/products/`, refuses when `$HOME/.orch` is not writable,
 *   requires `gh auth status` + default agent binary on PATH, listens on
 *   `--host 0.0.0.0` / `--port 7333` by default, and warns when bind is
 *   non-loopback (no auth in v1).
 * - FIFO queue gated by `--concurrency` (default 2) / `--max-queue` (default 64).
 *   Active count = live jobs across all products (spec decision 20). Tick starts
 *   jobs via injectable `runDetached` with `pr: true`, product cwd, optional
 *   `base`, and a no-op `exit` so the serve process stays alive. HTTP starts
 *   persist `source: { kind, id, remoteAddr, receivedAt }` on the job record.
 * - HTTP (no auth): `GET /api/healthz`; product routes below; `POST
 *   /api/products/:product/jobs` for an existing product dir; `GET /api/jobs`,
 *   `GET /api/jobs/:slug`, `GET /api/jobs/:slug/logs`, `GET /api/jobs/:slug/files`,
 *   `GET /api/products/:product/jobs`, `POST .../pause|resume|stop`.
 * - Phase 2 products: `GET`/`POST /api/products`, `GET`/`PATCH
 *   /api/products/:product` (no DELETE). Slug
 *   `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` max 64; required `name` + `slug`.
 *   Init = `git init -b main` → empty commit → private `gh repo create`
 *   (owner: request → `--github-owner` → `gh` login) → `git remote add origin`
 *   → push `main`; clone = `git clone` into `$HOME/.orch/products/<slug>/`
 *   (empty remotes healed onto `main` + push + set-head; non-empty optional
 *   set-head --auto). Existing slug → `409` for both init and clone. Write
 *   `product.json`. Failures after mkdir → best-effort rm + `502`. Stub
 *   `gh`/`git` via injectable `execFile` / `execFileSync` — no live GitHub.
 * - Phase 3 remainder (unit 04): job scan only walks product.json-backed
 *   product dirs; `GET /api/products/:product/jobs` returns `{ jobs }` (full
 *   list for that product, unknown → 404); `GET /api/jobs/:slug/files` is
 *   on-demand read-only git status from `run.json.worktree` →
 *   `{ files: [{ path, status }] }` including **untracked** (`??`) as well as
 *   tracked dirty paths (no staging `git add`). After orch commits clean the
 *   worktree, the list still surfaces files from commits on the job branch
 *   since `run.json.base` (union of dirty + committed-since-base). Unavailable
 *   job/worktree/git → `{ files: [] }`.
 * - Durable `state: "queued"` jobs are re-enqueued on boot; shutdown does not
 *   kill children.
 *
 * Implementation seam: `lib/serve.js` exports `startServe(options)`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');
const serveModulePath = path.join(__dirname, '..', 'lib', 'serve.js');

function makeTmpHome(prefix = 'orch-serve-home-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function productsDir(home) {
  return path.join(home, '.orch', 'products');
}

function seedProduct(home, slug, { name } = {}) {
  const dir = path.join(productsDir(home), slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'product.json'),
    JSON.stringify({
      slug,
      name: name ?? slug,
      createdAt: new Date().toISOString(),
      source: 'clone',
      remote: {
        url: `https://github.com/acme/${slug}.git`,
        provider: 'github',
        owner: 'acme',
        visibility: 'private',
      },
    }, null, 2),
  );
  return dir;
}

function seedJob(productCwd, slug, fields = {}) {
  const record = {
    slug,
    task: fields.task ?? 'seeded task',
    agent: fields.agent ?? 'claude',
    maxRounds: fields.maxRounds ?? 5,
    cwd: productCwd,
    pauseRequested: false,
    branch: null,
    worktree: null,
    startedAt: fields.startedAt ?? new Date().toISOString(),
    finishedAt: fields.finishedAt ?? null,
    exitCode: fields.exitCode ?? null,
    logPath: jobPaths(productCwd, slug).logPath,
    pid: fields.pid ?? null,
    state: fields.state ?? 'running',
    phase: null,
    stage: null,
    round: null,
    product: fields.product,
    source: fields.source,
    ...fields,
  };
  writeJob(productCwd, slug, record);
  if (fields.logText != null) {
    fs.writeFileSync(jobPaths(productCwd, slug).logPath, fields.logText);
  }
  return record;
}

function runCli(args, { cwd = path.join(__dirname, '..'), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function loadStartServe() {
  assert.ok(
    fs.existsSync(serveModulePath),
    'expected lib/serve.js (phase-1 serve module) to exist',
  );
  const mod = await import('../lib/serve.js');
  assert.equal(typeof mod.startServe, 'function', 'lib/serve.js must export startServe');
  return mod.startServe;
}

function okGhExecFileSync(cmd, args) {
  if (cmd === 'which') return '/usr/bin/' + args[0];
  if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
    return 'Logged in to github.com as acme';
  }
  throw new Error(`unexpected execFileSync: ${cmd} ${args.join(' ')}`);
}

/**
 * Fake sync/async-compatible exec for product init/clone (and boot auth).
 * Records calls; simulates git clone by creating the destination directory.
 * When `emptyClone` is true, `git rev-parse --verify HEAD` fails until an
 * allow-empty commit runs (empty-remote healing path).
 */
function makeProductExec({
  login = 'login-user',
  failRepoCreate = false,
  failClone = false,
  failAfterMkdir = null,
  emptyClone = false,
} = {}) {
  const calls = [];
  let emptyCloneHasHead = !emptyClone;
  const execFile = (cmd, args = [], options = {}) => {
    calls.push({ command: cmd, args: [...args], options });
    if (cmd === 'which') return '/usr/bin/' + args[0];
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
      return 'Logged in to github.com as acme';
    }
    if (cmd === 'gh' && args[0] === 'api' && args.includes('user')) {
      return `${login}\n`;
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'create') {
      if (failRepoCreate || failAfterMkdir === 'repo-create') {
        const err = new Error('gh repo create failed');
        err.stderr = 'HTTP 422: Repository creation failed';
        throw err;
      }
      assert.ok(args.includes('--private'), 'gh repo create must pass --private');
      return '';
    }
    if (cmd === 'git') {
      if (failAfterMkdir === 'git' && (args.includes('init') || args[0] === 'init')) {
        const err = new Error('git init failed');
        err.stderr = 'fatal: could not initialize';
        throw err;
      }
      if (args[0] === 'clone' || args.includes('clone')) {
        if (failClone || failAfterMkdir === 'clone') {
          const err = new Error('git clone failed');
          err.stderr = 'fatal: repository not found';
          throw err;
        }
        // `git clone <url> <dest>` — create dest so product.json can be written.
        const dest = args[args.length - 1];
        if (dest && !dest.startsWith('-') && !/^https?:/.test(dest) && !dest.includes('@')) {
          fs.mkdirSync(dest, { recursive: true });
          fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        }
        return '';
      }
      if (
        args.includes('rev-parse')
        && args.includes('--verify')
        && args.includes('HEAD')
      ) {
        if (!emptyCloneHasHead) {
          const err = new Error('fatal: Needed a single revision');
          err.stderr = 'fatal: Needed a single revision';
          throw err;
        }
        return 'deadbeef\n';
      }
      if (
        emptyClone
        && (args[0] === 'commit' || args.includes('commit'))
        && args.includes('--allow-empty')
      ) {
        emptyCloneHasHead = true;
        return '';
      }
      // init / commit / remote / push / checkout / set-head / remote set-url — succeed
      return '';
    }
    throw new Error(`unexpected execFile: ${cmd} ${args.join(' ')}`);
  };
  return { execFile, calls };
}

function serveBaseOptions(home, overrides = {}) {
  const runDetached = overrides.runDetached ?? mock.fn(async (_prompt, options = {}) => {
    // Mimic detach-parent success without exiting the test process.
    if (typeof options.exit === 'function') options.exit(0);
  });
  const defaultExec = makeProductExec().execFile;
  return {
    homedir: () => home,
    host: '127.0.0.1',
    port: 0,
    concurrency: 2,
    maxQueue: 64,
    agent: 'claude',
    maxRounds: 5,
    isBinaryOnPath: (bin) => bin === 'gh' || bin === 'claude' || bin === 'agent',
    execFileSync: defaultExec,
    execFile: defaultExec,
    log: () => {},
    warn: () => {},
    ...overrides,
    runDetached: overrides.runDetached ?? runDetached,
  };
}

function readProductJson(home, slug) {
  const p = path.join(productsDir(home), slug, 'product.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ghRepoCreateCalls(calls) {
  return calls.filter(
    (c) => c.command === 'gh' && c.args[0] === 'repo' && c.args[1] === 'create',
  );
}

function ghApiUserCalls(calls) {
  return calls.filter(
    (c) => c.command === 'gh' && c.args[0] === 'api' && c.args.some((a) => a === 'user' || String(a).startsWith('user')),
  );
}

function gitCalls(calls) {
  return calls.filter((c) => c.command === 'git');
}

function firstGitCallIndex(calls, predicate) {
  return calls.findIndex((c) => c.command === 'git' && predicate(c.args));
}

/** Locked init steps from `.spec/server.md`: init -b main → empty commit → remote add → push main. */
function assertInitGitPipeline(calls, { owner, slug }) {
  const initIdx = firstGitCallIndex(
    calls,
    (args) => {
      // Spec: `git init -b main` (flag then branch name as separate argv).
      const initAt = args.indexOf('init');
      if (initAt < 0) return false;
      const bAt = args.indexOf('-b', initAt);
      return bAt >= 0 && args[bAt + 1] === 'main';
    },
  );
  assert.ok(initIdx >= 0, `expected git init -b main; git calls=${JSON.stringify(gitCalls(calls))}`);

  const commitIdx = firstGitCallIndex(
    calls,
    (args) =>
      (args[0] === 'commit' || args.includes('commit')) && args.includes('--allow-empty'),
  );
  assert.ok(
    commitIdx >= 0,
    `expected empty commit (git commit --allow-empty); git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  const remoteIdx = firstGitCallIndex(
    calls,
    (args) => args.includes('remote') && args.includes('add') && args.includes('origin'),
  );
  assert.ok(
    remoteIdx >= 0,
    `expected git remote add origin; git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  const pushIdx = firstGitCallIndex(
    calls,
    (args) => (args[0] === 'push' || args.includes('push')) && args.includes('main'),
  );
  assert.ok(pushIdx >= 0, `expected git push … main; git calls=${JSON.stringify(gitCalls(calls))}`);

  assert.ok(initIdx < commitIdx, 'git init must precede empty commit');
  assert.ok(commitIdx < remoteIdx, 'empty commit must precede remote add');
  assert.ok(remoteIdx < pushIdx, 'remote add must precede push main');

  const creates = ghRepoCreateCalls(calls);
  assert.equal(creates.length, 1);
  const createIdx = calls.indexOf(creates[0]);
  assert.ok(commitIdx < createIdx, 'empty commit must precede gh repo create');
  assert.ok(createIdx < remoteIdx, 'gh repo create must precede git remote add origin');
  assert.ok(
    creates[0].args.includes('--private'),
    'gh repo create must pass --private',
  );
  assert.ok(
    creates[0].args.some((a) => a === `${owner}/${slug}` || String(a).endsWith(`${owner}/${slug}`)),
    `repo create must target ${owner}/${slug}; args=${creates[0].args.join(' ')}`,
  );
}

/** Locked empty-clone heal from `.spec/server.md`: checkout -B main → empty commit → push -u → set-head main. */
function assertEmptyCloneHealPipeline(calls) {
  const cloneIdx = firstGitCallIndex(
    calls,
    (args) => args[0] === 'clone' || args.includes('clone'),
  );
  assert.ok(cloneIdx >= 0, `expected git clone; git calls=${JSON.stringify(gitCalls(calls))}`);

  const checkoutIdx = firstGitCallIndex(
    calls,
    (args) =>
      (args[0] === 'checkout' || args.includes('checkout'))
      && args.includes('-B')
      && args.includes('main'),
  );
  assert.ok(
    checkoutIdx >= 0,
    `expected git checkout -B main; git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  const commitIdx = firstGitCallIndex(
    calls,
    (args) =>
      (args[0] === 'commit' || args.includes('commit')) && args.includes('--allow-empty'),
  );
  assert.ok(
    commitIdx >= 0,
    `expected empty commit (git commit --allow-empty); git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  const pushIdx = firstGitCallIndex(
    calls,
    (args) =>
      (args[0] === 'push' || args.includes('push'))
      && args.includes('-u')
      && args.includes('origin')
      && args.includes('main'),
  );
  assert.ok(
    pushIdx >= 0,
    `expected git push -u origin main; git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  const setHeadIdx = firstGitCallIndex(
    calls,
    (args) =>
      args.includes('remote')
      && args.includes('set-head')
      && args.includes('origin')
      && args.includes('main')
      && !args.includes('--auto'),
  );
  assert.ok(
    setHeadIdx >= 0,
    `expected git remote set-head origin main; git calls=${JSON.stringify(gitCalls(calls))}`,
  );

  assert.ok(cloneIdx < checkoutIdx, 'git clone must precede checkout -B main');
  assert.ok(checkoutIdx < commitIdx, 'checkout -B main must precede empty commit');
  assert.ok(commitIdx < pushIdx, 'empty commit must precede push -u origin main');
  assert.ok(pushIdx < setHeadIdx, 'push must precede set-head origin main');
}

async function startTestServe(home, overrides = {}) {
  const startServe = await loadStartServe();
  const options = serveBaseOptions(home, overrides);
  const handle = await startServe(options);
  assert.ok(handle, 'startServe must return a handle');
  assert.ok(handle.server || handle.close, 'handle must expose server and/or close()');
  const port = handle.port ?? handle.server?.address()?.port;
  assert.ok(Number.isInteger(port) && port > 0, 'startServe must bind an ephemeral port when port:0');
  const host = handle.host ?? '127.0.0.1';
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...handle,
    port,
    host,
    baseUrl,
    options,
    async close() {
      if (typeof handle.close === 'function') await handle.close();
      else if (handle.server) {
        await new Promise((resolve, reject) => {
          handle.server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
  };
}

async function jsonRequest(baseUrl, method, urlPath, { body, headers } = {}) {
  const res = await fetch(new URL(urlPath, baseUrl), {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { res, text, json };
}

describe('orch serve CLI', () => {
  it('registers `serve` with default flags in --help', async () => {
    const { code, stdout, stderr } = await runCli(['serve', '--help']);
    const help = `${stdout}\n${stderr}`;
    assert.equal(code, 0, help);
    assert.match(help, /--port/);
    assert.match(help, /7333/);
    assert.match(help, /--host/);
    assert.match(help, /0\.0\.0\.0/);
    assert.match(help, /--concurrency/);
    assert.match(help, /--max-queue/);
    assert.match(help, /--agent/);
    assert.match(help, /--max-rounds/);
    assert.match(help, /--base/);
    assert.match(help, /--github-owner/);
    assert.match(help, /no auth|NO AUTH/i);
    assert.match(help, /products|~\.?\/\.orch\/products|\.orch\/products/i);
    assert.match(help, /gh auth|GitHub/i);
    assert.match(help, /machine-ip|LAN|7333/i);
  });
});

describe('startServe boot', () => {
  it('creates $HOME/.orch/products and refuses when $HOME/.orch is not writable', async () => {
    const home = makeTmpHome();
    try {
      const startServe = await loadStartServe();
      const handle = await startServe(serveBaseOptions(home));
      try {
        assert.ok(fs.statSync(productsDir(home)).isDirectory());
      } finally {
        await (handle.close?.() ?? Promise.resolve());
        if (handle.server) {
          await new Promise((resolve) => handle.server.close(() => resolve()));
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }

    const blockedHome = makeTmpHome('orch-serve-nowrite-');
    try {
      const orchPath = path.join(blockedHome, '.orch');
      fs.mkdirSync(orchPath, { recursive: true });
      fs.chmodSync(orchPath, 0o500);
      // Drop write bit on home so creating/writing under .orch fails on platforms that honor mode.
      fs.chmodSync(blockedHome, 0o500);
      const startServe = await loadStartServe();
      await assert.rejects(
        () => startServe(serveBaseOptions(blockedHome, {
          // Keep listen off the network if boot somehow proceeds.
          host: '127.0.0.1',
          port: 0,
        })),
        (err) => {
          assert.ok(err);
          return true;
        },
      );
    } finally {
      fs.chmodSync(blockedHome, 0o700);
      try { fs.chmodSync(path.join(blockedHome, '.orch'), 0o700); } catch { /* missing */ }
      fs.rmSync(blockedHome, { recursive: true, force: true });
    }
  });

  it('requires gh auth status and default agent binary on PATH before listen', async () => {
    const home = makeTmpHome();
    try {
      const startServe = await loadStartServe();

      await assert.rejects(
        () => startServe(serveBaseOptions(home, {
          isBinaryOnPath: (bin) => bin === 'claude',
          execFileSync: okGhExecFileSync,
        })),
        /gh/i,
      );

      await assert.rejects(
        () => startServe(serveBaseOptions(home, {
          isBinaryOnPath: (bin) => bin === 'gh',
          execFileSync: (cmd, args) => {
            if (cmd === 'gh' && args[0] === 'auth') {
              const err = new Error('not logged in');
              err.stderr = 'You are not logged into any GitHub hosts';
              throw err;
            }
            return okGhExecFileSync(cmd, args);
          },
        })),
        /auth/i,
      );

      await assert.rejects(
        () => startServe(serveBaseOptions(home, {
          agent: 'claude',
          isBinaryOnPath: (bin) => bin === 'gh',
        })),
        /claude|agent|PATH/i,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults listen host/port and warns about no auth on non-loopback bind', async () => {
    const home = makeTmpHome();
    try {
      const startServe = await loadStartServe();
      const warnings = [];
      const logs = [];
      // Bind loopback with an explicit non-loopback *configured* host check:
      // implementation should warn based on the requested host (0.0.0.0), even
      // if tests may listen on 127.0.0.1 for safety — pin warning on host option.
      const handle = await startServe(serveBaseOptions(home, {
        host: '0.0.0.0',
        port: 0,
        warn: (msg) => warnings.push(String(msg)),
        log: (msg) => logs.push(String(msg)),
      }));
      try {
        const requestedHost = handle.requestedHost ?? handle.host ?? '0.0.0.0';
        assert.equal(requestedHost, '0.0.0.0');
        const joinedWarn = warnings.join('\n');
        assert.match(joinedWarn, /no auth|unauthenticated|anyone who can reach/i);
        const joinedLog = logs.join('\n');
        assert.match(joinedLog, /127\.0\.0\.1/);
      } finally {
        if (typeof handle.close === 'function') await handle.close();
        else if (handle.server) {
          await new Promise((resolve) => handle.server.close(() => resolve()));
        }
      }

      // Document CLI defaults without requiring a long-lived 0.0.0.0 listen in CI.
      const { stdout, stderr } = await runCli(['serve', '--help']);
      const help = `${stdout}\n${stderr}`;
      assert.match(help, /7333/);
      assert.match(help, /0\.0\.0\.0/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('re-enqueues durable queued jobs on boot and does not auto-retry crashed runs', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'app-one');
      seedJob(productDir, 'queued-job-aaaa', {
        state: 'queued',
        product: 'app-one',
        task: 'finish me',
        source: {
          kind: 'http',
          id: 'boot-id-1',
          remoteAddr: '127.0.0.1',
          receivedAt: '2026-08-02T00:00:00.000Z',
        },
      });
      seedJob(productDir, 'crashed-job-bbbb', {
        state: 'crashed',
        product: 'app-one',
        task: 'do not retry',
        finishedAt: '2026-08-02T00:01:00.000Z',
        exitCode: 1,
        pid: 999001,
      });

      const started = [];
      const runDetached = mock.fn(async (prompt, options = {}) => {
        started.push({ prompt, cwd: options.cwd, pr: options.pr });
        if (typeof options.exit === 'function') options.exit(0);
      });

      const handle = await startTestServe(home, {
        concurrency: 2,
        runDetached,
      });
      try {
        // Allow a tick for recovery enqueue → detach.
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(
          runDetached.mock.calls.length >= 1,
          'boot recovery must tick queued jobs into runDetached',
        );
        assert.ok(
          started.some((s) => s.prompt === 'finish me' && s.pr === true),
          'queued job must start with pr:true',
        );
        assert.ok(
          !started.some((s) => s.prompt === 'do not retry'),
          'crashed jobs must not be auto-retried',
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('serve HTTP jobs API', () => {
  it('GET /api/healthz is liveness without auth', async () => {
    const home = makeTmpHome();
    try {
      const handle = await startTestServe(home);
      try {
        const { res, json, text } = await jsonRequest(handle.baseUrl, 'GET', '/api/healthz');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('www-authenticate'), null);
        if (json) {
          assert.ok(json.ok === true || json.status === 'ok' || json.alive === true);
        } else {
          assert.match(text, /ok|alive|healthy/i);
        }
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/products/:product/jobs requires an existing product, enqueues with http source, always --pr', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'my-app');
      const detachCalls = [];
      const runDetached = mock.fn(async (prompt, options = {}) => {
        detachCalls.push({ prompt, options });
        // Promote any pre-allocated queued record the serve path wrote; do not
        // invent a second slug — registry ownership stays with serve/allocate.
        if (options.cwd && options.jobSlug) {
          const existing = readJob(options.cwd, options.jobSlug);
          if (existing) {
            writeJob(options.cwd, options.jobSlug, {
              ...existing,
              state: 'running',
              pid: 424242,
            });
          }
        }
        if (typeof options.exit === 'function') options.exit(0);
      });

      const handle = await startTestServe(home, {
        concurrency: 1,
        base: 'develop',
        runDetached,
      });
      try {
        const missing = await jsonRequest(handle.baseUrl, 'POST', '/api/products/nope/jobs', {
          body: { task: 'x', id: 'id-missing' },
        });
        assert.equal(missing.res.status, 404);

        const created = await jsonRequest(handle.baseUrl, 'POST', '/api/products/my-app/jobs', {
          body: {
            task: 'add a healthcheck endpoint',
            id: 'ui-550e8400-e29b-41d4-a716-446655440000',
            agent: 'claude',
            maxRounds: 3,
            mode: 'pipeline',
          },
        });
        assert.ok([200, 201, 202].includes(created.res.status), `unexpected status ${created.res.status}`);
        assert.ok(created.json?.slug || created.json?.job?.slug, 'response must include job slug');

        await new Promise((r) => setTimeout(r, 50));
        assert.ok(detachCalls.length >= 1, 'tick must call runDetached');
        const first = detachCalls[0];
        assert.equal(first.prompt, 'add a healthcheck endpoint');
        assert.equal(first.options.cwd, productDir);
        assert.equal(first.options.pr, true);
        assert.equal(first.options.base, 'develop');
        assert.equal(typeof first.options.exit, 'function');
        // No-op exit: invoking it must not kill the test / serve handle.
        first.options.exit(0);

        // Durable queue fields written under the product cwd before/with detach.
        const slug = created.json.slug ?? created.json.job.slug;
        assert.equal(
          first.options.jobSlug,
          slug,
          'tick must pass the pre-allocated jobSlug into runDetached (extend runDetached to accept it)',
        );
        const onDisk = readJob(productDir, slug);
        assert.ok(onDisk, 'job record must exist under product cwd');
        assert.equal(onDisk.product, 'my-app');
        assert.equal(onDisk.source?.kind, 'http');
        assert.equal(onDisk.source?.id, 'ui-550e8400-e29b-41d4-a716-446655440000');
        assert.ok(onDisk.source?.receivedAt);
        // Checklist job-record shape / spec source.remoteAddr (client socket addr).
        assert.equal(typeof onDisk.source?.remoteAddr, 'string');
        assert.ok(
          onDisk.source.remoteAddr.length > 0,
          'source.remoteAddr must be a non-empty string from the HTTP client',
        );
        assert.ok(
          ['queued', 'starting', 'running'].includes(onDisk.state),
          `expected live/queued state, got ${onDisk.state}`,
        );

        // Idempotency: same caller id returns the same job.
        const again = await jsonRequest(handle.baseUrl, 'POST', '/api/products/my-app/jobs', {
          body: {
            task: 'add a healthcheck endpoint',
            id: 'ui-550e8400-e29b-41d4-a716-446655440000',
          },
        });
        const againSlug = again.json?.slug ?? again.json?.job?.slug;
        assert.equal(againSlug, slug);
        assert.equal(
          detachCalls.length,
          1,
          'idempotent replay must not spawn a second detached run',
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects JSON bodies larger than 64 KiB', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'my-app');
      const handle = await startTestServe(home, { concurrency: 1 });
      try {
        const bigTask = 'x'.repeat(65 * 1024);
        const { res } = await jsonRequest(handle.baseUrl, 'POST', '/api/products/my-app/jobs', {
          body: { task: bigTask, id: 'too-big' },
        });
        assert.equal(res.status, 413);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('FIFO queue respects concurrency and max-queue', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'queue-app');
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const order = [];
      const runDetached = mock.fn(async (prompt, options = {}) => {
        order.push(prompt);
        if (options.cwd && options.jobSlug) {
          const existing = readJob(options.cwd, options.jobSlug);
          if (existing) {
            writeJob(options.cwd, options.jobSlug, {
              ...existing,
              state: 'running',
              pid: 500000 + order.length,
            });
          }
        }
        if (typeof options.exit === 'function') options.exit(0);
        // Hold the first slot busy until released so the second stays queued
        // when concurrency is saturated (concurrency=1).
        if (order.length === 1) await gate;
      });

      const handle = await startTestServe(home, {
        concurrency: 1,
        maxQueue: 2,
        runDetached,
      });
      try {
        const a = await jsonRequest(handle.baseUrl, 'POST', '/api/products/queue-app/jobs', {
          body: { task: 'task-a', id: 'id-a' },
        });
        assert.ok([200, 201, 202].includes(a.res.status));

        // Wait until first detach started.
        for (let i = 0; i < 20 && order.length < 1; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(order[0], 'task-a');

        const b = await jsonRequest(handle.baseUrl, 'POST', '/api/products/queue-app/jobs', {
          body: { task: 'task-b', id: 'id-b' },
        });
        assert.ok([200, 201, 202].includes(b.res.status));
        const bSlug = b.json?.slug ?? b.json?.job?.slug;
        assert.ok(bSlug);
        // While concurrency is full, B must remain queued on disk.
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(order.length, 1, 'second job must wait for concurrency slot');
        const bRecord = readJob(productDir, bSlug);
        assert.equal(bRecord.state, 'queued');

        const c = await jsonRequest(handle.baseUrl, 'POST', '/api/products/queue-app/jobs', {
          body: { task: 'task-c', id: 'id-c' },
        });
        // maxQueue=2: one active-wait slot is not the queue; the in-memory/durable
        // pending queue capacity is 2 — third accept beyond capacity → 503/429.
        // Spec: --max-queue 64 bounds waiting jobs. With 1 running + 1 queued,
        // another waiting job may fill the last slot or be rejected depending on
        // whether the running job counts — pin: when pending queued count would
        // exceed maxQueue, reject.
        if (c.res.status === 200 || c.res.status === 201 || c.res.status === 202) {
          const d = await jsonRequest(handle.baseUrl, 'POST', '/api/products/queue-app/jobs', {
            body: { task: 'task-d', id: 'id-d' },
          });
          assert.ok([429, 503].includes(d.res.status), `expected queue-full status, got ${d.res.status}`);
        } else {
          assert.ok([429, 503].includes(c.res.status), `expected queue-full status, got ${c.res.status}`);
        }

        release();
        for (let i = 0; i < 40 && order.length < 2; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.deepEqual(order.slice(0, 2), ['task-a', 'task-b'], 'FIFO order');
      } finally {
        release();
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('concurrency counts live jobs across products (spec decision 20)', async () => {
    // Active slots are global: a running job in product A must block starting
    // a waiting job in product B when concurrency is saturated.
    const home = makeTmpHome();
    try {
      const aDir = seedProduct(home, 'prod-a');
      const bDir = seedProduct(home, 'prod-b');
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const started = [];
      const runDetached = mock.fn(async (prompt, options = {}) => {
        started.push({ prompt, cwd: options.cwd, product: path.basename(options.cwd ?? '') });
        if (options.cwd && options.jobSlug) {
          const existing = readJob(options.cwd, options.jobSlug);
          if (existing) {
            writeJob(options.cwd, options.jobSlug, {
              ...existing,
              state: 'running',
              pid: 600000 + started.length,
            });
          }
        }
        if (typeof options.exit === 'function') options.exit(0);
        if (started.length === 1) await gate;
      });

      const handle = await startTestServe(home, {
        concurrency: 1,
        maxQueue: 8,
        runDetached,
      });
      try {
        const a = await jsonRequest(handle.baseUrl, 'POST', '/api/products/prod-a/jobs', {
          body: { task: 'cross-a', id: 'cross-id-a' },
        });
        assert.ok([200, 201, 202].includes(a.res.status));

        for (let i = 0; i < 20 && started.length < 1; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(started.length, 1);
        assert.equal(started[0].prompt, 'cross-a');
        assert.equal(started[0].cwd, aDir);

        const b = await jsonRequest(handle.baseUrl, 'POST', '/api/products/prod-b/jobs', {
          body: { task: 'cross-b', id: 'cross-id-b' },
        });
        assert.ok([200, 201, 202].includes(b.res.status));
        const bSlug = b.json?.slug ?? b.json?.job?.slug;
        assert.ok(bSlug);

        await new Promise((r) => setTimeout(r, 40));
        assert.equal(
          started.length,
          1,
          'product-B job must wait while product-A holds the only concurrency slot',
        );
        const bRecord = readJob(bDir, bSlug);
        assert.equal(bRecord.state, 'queued');
        assert.equal(bRecord.product, 'prod-b');

        release();
        for (let i = 0; i < 40 && started.length < 2; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(started.length, 2, 'product-B must start after A frees the slot');
        assert.equal(started[1].prompt, 'cross-b');
        assert.equal(started[1].cwd, bDir);
      } finally {
        release();
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});

describe('serve HTTP jobs API (scan + controls + logs)', () => {
  it('GET /api/jobs and GET /api/jobs/:slug scan across products', async () => {
    const home = makeTmpHome();
    try {
      const aDir = seedProduct(home, 'alpha');
      const bDir = seedProduct(home, 'beta');
      seedJob(aDir, 'older-aaaa', {
        product: 'alpha',
        task: 'older',
        startedAt: '2026-08-01T00:00:00.000Z',
        state: 'done',
        finishedAt: '2026-08-01T01:00:00.000Z',
        exitCode: 0,
        pid: 1,
      });
      seedJob(bDir, 'newer-bbbb', {
        product: 'beta',
        task: 'newer',
        startedAt: '2026-08-02T00:00:00.000Z',
        state: 'running',
        pid: process.pid,
      });

      const handle = await startTestServe(home, {
        concurrency: 2,
        runDetached: mock.fn(async (_p, options = {}) => {
          if (typeof options.exit === 'function') options.exit(0);
        }),
      });
      try {
        const list = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs');
        assert.equal(list.res.status, 200);
        const jobs = list.json?.jobs ?? list.json;
        assert.ok(Array.isArray(jobs));
        assert.ok(jobs.length >= 2);
        const slugs = jobs.map((j) => j.slug);
        assert.ok(slugs.includes('older-aaaa'));
        assert.ok(slugs.includes('newer-bbbb'));
        assert.equal(jobs[0].slug, 'newer-bbbb', 'newest first');

        const one = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/newer-bbbb');
        assert.equal(one.res.status, 200);
        const job = one.json?.job ?? one.json;
        assert.equal(job.slug, 'newer-bbbb');
        assert.equal(job.product, 'beta');

        const missing = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/no-such-slug');
        assert.equal(missing.res.status, 404);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/jobs/:slug/logs returns orch.log (plain or SSE)', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'log-app');
      seedJob(productDir, 'log-job-cccc', {
        product: 'log-app',
        state: 'running',
        pid: process.pid,
        logText: 'hello from orch.log\nline two\n',
      });

      const handle = await startTestServe(home);
      try {
        const plain = await fetch(new URL('/api/jobs/log-job-cccc/logs', handle.baseUrl), {
          headers: { accept: 'text/plain' },
        });
        assert.equal(plain.status, 200);
        const plainText = await plain.text();
        assert.match(plainText, /hello from orch\.log/);

        const sse = await fetch(new URL('/api/jobs/log-job-cccc/logs', handle.baseUrl), {
          headers: { accept: 'text/event-stream' },
        });
        assert.equal(sse.status, 200);
        const ct = sse.headers.get('content-type') || '';
        assert.match(ct, /text\/event-stream|text\/plain/);
        // Consume a small amount then cancel so we don't hang on open SSE.
        const reader = sse.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          const chunk = value ? Buffer.from(value).toString('utf8') : '';
          assert.match(chunk, /hello from orch\.log|data:/);
          await reader.cancel();
        }
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST pause/resume/stop operate on the job under its product cwd', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'ctrl-app');
      seedJob(productDir, 'ctrl-job-dddd', {
        product: 'ctrl-app',
        state: 'running',
        pid: process.pid,
        pauseRequested: false,
      });

      const handle = await startTestServe(home);
      try {
        const paused = await jsonRequest(handle.baseUrl, 'POST', '/api/jobs/ctrl-job-dddd/pause');
        assert.ok([200, 204].includes(paused.res.status));
        const afterPause = readJob(productDir, 'ctrl-job-dddd');
        assert.equal(afterPause.pauseRequested, true);

        const resumed = await jsonRequest(handle.baseUrl, 'POST', '/api/jobs/ctrl-job-dddd/resume');
        assert.ok([200, 204].includes(resumed.res.status));
        const afterResume = readJob(productDir, 'ctrl-job-dddd');
        assert.equal(afterResume.pauseRequested, false);

        // stop: inject via real stopJob semantics — use a dead pid so stop reconciles
        // without signaling the test process.
        writeJob(productDir, 'ctrl-job-dddd', {
          ...readJob(productDir, 'ctrl-job-dddd'),
          pid: 999999,
          state: 'running',
        });
        const stopped = await jsonRequest(handle.baseUrl, 'POST', '/api/jobs/ctrl-job-dddd/stop');
        assert.ok([200, 204].includes(stopped.res.status));
        const afterStop = readJob(productDir, 'ctrl-job-dddd');
        assert.ok(
          ['crashed', 'stopped', 'stopping'].includes(afterStop.state)
            || stopped.json?.action === 'crashed'
            || stopped.json?.action === 'signaled'
            || stopped.json?.action === 'already-terminal',
          `unexpected stop outcome: state=${afterStop.state} body=${JSON.stringify(stopped.json)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shutdown/close does not kill detached child pids', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'live-app');
      const childPid = process.pid;
      seedJob(productDir, 'live-job-eeee', {
        product: 'live-app',
        state: 'running',
        pid: childPid,
      });

      const killed = [];
      const originalKill = process.kill;
      const killSpy = mock.method(process, 'kill', (pid, signal) => {
        if (signal && signal !== 0) killed.push({ pid, signal });
        if (signal === 0 || signal === undefined) return originalKill(pid, signal);
        // Do not actually signal.
        return true;
      });

      const handle = await startTestServe(home);
      try {
        assert.equal(readJob(productDir, 'live-job-eeee').pid, childPid);
      } finally {
        await handle.close();
        killSpy.mock.restore();
      }
      assert.ok(
        !killed.some((k) => k.pid === childPid),
        `close must not signal child pid; got ${JSON.stringify(killed)}`,
      );
      assert.equal(readJob(productDir, 'live-job-eeee').state, 'running');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/products/:product/jobs lists that product’s jobs; unknown → 404', async () => {
    const home = makeTmpHome();
    try {
      const aDir = seedProduct(home, 'alpha');
      const bDir = seedProduct(home, 'beta');
      seedJob(aDir, 'a-job-1111', {
        product: 'alpha',
        task: 'alpha older',
        startedAt: '2026-08-01T00:00:00.000Z',
        state: 'done',
        finishedAt: '2026-08-01T01:00:00.000Z',
      });
      seedJob(aDir, 'a-job-2222', {
        product: 'alpha',
        task: 'alpha newer',
        startedAt: '2026-08-02T00:00:00.000Z',
        state: 'running',
        pid: process.pid,
      });
      seedJob(bDir, 'b-job-3333', {
        product: 'beta',
        task: 'beta only',
        startedAt: '2026-08-03T00:00:00.000Z',
        state: 'queued',
      });

      const handle = await startTestServe(home);
      try {
        const missing = await jsonRequest(handle.baseUrl, 'GET', '/api/products/nope/jobs');
        assert.equal(missing.res.status, 404);

        // Dir without product.json is not a product for this route.
        const stray = path.join(productsDir(home), 'stray-dir');
        fs.mkdirSync(stray, { recursive: true });
        const noJson = await jsonRequest(handle.baseUrl, 'GET', '/api/products/stray-dir/jobs');
        assert.equal(noJson.res.status, 404);

        const { res, json } = await jsonRequest(handle.baseUrl, 'GET', '/api/products/alpha/jobs');
        assert.equal(res.status, 200, `expected 200; got ${res.status}: ${JSON.stringify(json)}`);
        const jobs = json?.jobs;
        assert.ok(Array.isArray(jobs), 'GET product jobs must return { jobs: [...] }');
        const slugs = jobs.map((j) => j.slug);
        assert.ok(slugs.includes('a-job-1111'));
        assert.ok(slugs.includes('a-job-2222'));
        assert.ok(!slugs.includes('b-job-3333'), 'must not include other products’ jobs');
        assert.equal(jobs[0].slug, 'a-job-2222', 'newest first');
        assert.ok(jobs.every((j) => j.product === 'alpha'));
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/products/:product/jobs returns the full list (not the product GET 20-slice)', async () => {
    const home = makeTmpHome();
    try {
      const dir = seedProduct(home, 'busy');
      for (let i = 0; i < 21; i += 1) {
        const n = String(i).padStart(2, '0');
        seedJob(dir, `busy-job-${n}aa`, {
          product: 'busy',
          task: `task ${i}`,
          startedAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
          state: 'done',
          finishedAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T01:00:00.000Z`,
          exitCode: 0,
        });
      }

      const handle = await startTestServe(home);
      try {
        const productGet = await jsonRequest(handle.baseUrl, 'GET', '/api/products/busy');
        assert.equal(productGet.res.status, 200);
        const recent = productGet.json?.jobs ?? [];
        assert.ok(Array.isArray(recent));
        assert.ok(recent.length <= 20, `product GET must slice recent jobs; got ${recent.length}`);

        const list = await jsonRequest(handle.baseUrl, 'GET', '/api/products/busy/jobs');
        assert.equal(list.res.status, 200);
        const jobs = list.json?.jobs;
        assert.ok(Array.isArray(jobs));
        assert.equal(jobs.length, 21, 'product jobs GET must return the full list');
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('job scan ignores product dirs that lack product.json', async () => {
    const home = makeTmpHome();
    try {
      const realDir = seedProduct(home, 'real-app');
      seedJob(realDir, 'real-job-ffff', {
        product: 'real-app',
        state: 'done',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T01:00:00.000Z',
        exitCode: 0,
      });

      // Bare directory under products/ with a run.json but no product.json.
      const orphanDir = path.join(productsDir(home), 'orphan-app');
      fs.mkdirSync(orphanDir, { recursive: true });
      seedJob(orphanDir, 'orphan-job-gggg', {
        product: 'orphan-app',
        state: 'running',
        startedAt: '2026-08-02T00:00:00.000Z',
        pid: process.pid,
      });

      const handle = await startTestServe(home);
      try {
        const list = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs');
        assert.equal(list.res.status, 200);
        const jobs = list.json?.jobs ?? list.json;
        assert.ok(Array.isArray(jobs));
        const slugs = jobs.map((j) => j.slug);
        assert.ok(slugs.includes('real-job-ffff'));
        assert.ok(
          !slugs.includes('orphan-job-gggg'),
          'scan must skip dirs without product.json',
        );

        const orphan = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/orphan-job-gggg');
        assert.equal(orphan.res.status, 404);

        const real = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/real-job-ffff');
        assert.equal(real.res.status, 200);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/jobs/:slug/files returns on-demand git name-status from the worktree', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'files-app');
      const worktree = path.join(home, 'files-app-files-job-hhhh');
      fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
      seedJob(productDir, 'files-job-hhhh', {
        product: 'files-app',
        state: 'running',
        pid: process.pid,
        worktree,
        branch: 'orch/files-job-hhhh',
      });

      const baseExec = makeProductExec().execFile;
      const calls = [];
      const execFile = (cmd, args = [], options = {}) => {
        calls.push({ command: cmd, args: [...args], options });
        if (cmd === 'git' && args.includes('--name-status')) {
          return 'M\tsrc/x.ts\nA\tlib/y.js\n';
        }
        if (cmd === 'git' && args.includes('--porcelain')) {
          return ' M src/x.ts\n?? lib/y.js\n';
        }
        return baseExec(cmd, args, options);
      };

      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const { res, json } = await jsonRequest(
          handle.baseUrl,
          'GET',
          '/api/jobs/files-job-hhhh/files',
        );
        assert.equal(res.status, 200, `expected 200; got ${res.status}: ${JSON.stringify(json)}`);
        assert.ok(Array.isArray(json?.files), 'files API must return { files: [...] }');
        assert.ok(json.files.length >= 1, 'expected at least one changed file from stubbed git');
        for (const entry of json.files) {
          assert.equal(typeof entry.path, 'string');
          assert.equal(typeof entry.status, 'string');
          assert.ok(entry.path.length > 0);
          assert.ok(entry.status.length > 0);
        }
        assert.ok(
          json.files.some((f) => f.path === 'src/x.ts' && /M/.test(f.status)),
          `expected M src/x.ts; got ${JSON.stringify(json.files)}`,
        );

        const gitInvokes = calls.filter((c) => c.command === 'git');
        assert.ok(gitInvokes.length >= 1, 'files route must invoke git against the worktree');
        assert.ok(
          gitInvokes.every((c) => !c.args.includes('add')),
          `files route must be read-only (no git add); got ${JSON.stringify(gitInvokes)}`,
        );
        assert.ok(
          gitInvokes.some((c) => c.args.includes(worktree) || c.options?.cwd === worktree),
          `git must target job worktree ${worktree}; got ${JSON.stringify(gitInvokes)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/jobs/:slug/files includes untracked files without git add', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'untracked-files');
      const worktree = path.join(home, 'untracked-files-job-ut01');
      fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
      seedJob(productDir, 'files-job-ut01', {
        product: 'untracked-files',
        state: 'running',
        pid: process.pid,
        worktree,
        branch: 'orch/files-job-ut01',
      });

      const baseExec = makeProductExec().execFile;
      const calls = [];
      const execFile = (cmd, args = [], options = {}) => {
        calls.push({ command: cmd, args: [...args], options });
        // Dirty tracked + brand-new untracked — name-status alone cannot see ??.
        if (cmd === 'git' && args.includes('--name-status') && !args.includes('--porcelain')) {
          return 'M\tsrc/tracked.ts\n';
        }
        if (cmd === 'git' && args.includes('--porcelain')) {
          return ' M src/tracked.ts\n?? src/brand-new.ts\n';
        }
        return baseExec(cmd, args, options);
      };

      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const { res, json } = await jsonRequest(
          handle.baseUrl,
          'GET',
          '/api/jobs/files-job-ut01/files',
        );
        assert.equal(res.status, 200, `expected 200; got ${res.status}: ${JSON.stringify(json)}`);
        assert.ok(Array.isArray(json?.files), 'files API must return { files: [...] }');
        assert.ok(
          json.files.some((f) => f.path === 'src/tracked.ts' && /M/.test(String(f.status))),
          `expected modified tracked file; got ${JSON.stringify(json.files)}`,
        );
        assert.ok(
          json.files.some(
            (f) =>
              f.path === 'src/brand-new.ts'
              && (/\?/.test(String(f.status)) || /^A\b/.test(String(f.status))),
          ),
          `expected untracked/new file src/brand-new.ts; got ${JSON.stringify(json.files)}`,
        );

        const gitInvokes = calls.filter((c) => c.command === 'git');
        assert.ok(gitInvokes.length >= 1, 'files route must invoke git');
        assert.ok(
          gitInvokes.every((c) => !c.args.includes('add')),
          `files route must stay read-only (no git add); got ${JSON.stringify(gitInvokes)}`,
        );
        assert.ok(
          gitInvokes.some(
            (c) =>
              c.args.includes('--porcelain')
              || (c.args.includes('status') && c.args.includes('--porcelain')),
          ),
          `files route must use read-only porcelain/status so untracked files appear; got ${JSON.stringify(gitInvokes)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/jobs/:slug/files still lists files after worktree commit (union with base)', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'committed-files');
      const worktree = path.join(home, 'committed-files-job-pc01');
      fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
      seedJob(productDir, 'files-job-pc01', {
        product: 'committed-files',
        state: 'running',
        pid: process.pid,
        worktree,
        branch: 'orch/files-job-pc01',
        base: 'main',
      });

      const baseExec = makeProductExec().execFile;
      const calls = [];
      const execFile = (cmd, args = [], options = {}) => {
        calls.push({ command: cmd, args: [...args], options });
        if (cmd !== 'git') return baseExec(cmd, args, options);

        // Clean worktree after orch commitWorktree — dirty-only listing would be [].
        if (args.includes('--porcelain')) {
          return '';
        }
        // Plain dirty diff vs HEAD is empty once committed.
        if (
          args.includes('--name-status')
          && args.includes('HEAD')
          && !args.some((a) => typeof a === 'string' && (a.includes('main') || a.includes('..')))
        ) {
          return '';
        }
        // Committed-since-base (or equivalent range) still has the job's files.
        if (
          args.includes('--name-status')
          || args.includes('--name-only')
        ) {
          const rangeish = args.some(
            (a) =>
              typeof a === 'string'
              && (a.includes('main') || a.includes('..') || a.includes('orch/files-job-pc01')),
          );
          if (rangeish || args.includes('log')) {
            return args.includes('--name-only')
              ? 'src/feature.ts\nlib/util.js\n'
              : 'A\tsrc/feature.ts\nM\tlib/util.js\n';
          }
        }
        if (args.includes('log')) {
          return 'A\tsrc/feature.ts\nM\tlib/util.js\n';
        }
        return baseExec(cmd, args, options);
      };

      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const { res, json } = await jsonRequest(
          handle.baseUrl,
          'GET',
          '/api/jobs/files-job-pc01/files',
        );
        assert.equal(res.status, 200, `expected 200; got ${res.status}: ${JSON.stringify(json)}`);
        assert.ok(Array.isArray(json?.files), 'files API must return { files: [...] }');
        assert.ok(
          json.files.length >= 1,
          `after commit, files since job base must still list; got ${JSON.stringify(json.files)}`,
        );
        assert.ok(
          json.files.some((f) => f.path === 'src/feature.ts'),
          `expected src/feature.ts from commits since base; got ${JSON.stringify(json.files)}`,
        );
        assert.ok(
          json.files.some((f) => f.path === 'lib/util.js'),
          `expected lib/util.js from commits since base; got ${JSON.stringify(json.files)}`,
        );
        for (const entry of json.files) {
          assert.equal(typeof entry.path, 'string');
          assert.equal(typeof entry.status, 'string');
          assert.ok(entry.path.length > 0);
          assert.ok(entry.status.length > 0);
        }

        const gitInvokes = calls.filter((c) => c.command === 'git');
        assert.ok(
          gitInvokes.every((c) => !c.args.includes('add')),
          `files route must stay read-only (no git add); got ${JSON.stringify(gitInvokes)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/jobs/:slug/files returns { files: [] } when job/worktree/git unavailable', async () => {
    const home = makeTmpHome();
    try {
      const productDir = seedProduct(home, 'empty-files');
      seedJob(productDir, 'no-wt-iiii', {
        product: 'empty-files',
        state: 'queued',
        worktree: null,
      });
      const missingWt = path.join(home, 'does-not-exist-wt');
      seedJob(productDir, 'missing-wt-jjjj', {
        product: 'empty-files',
        state: 'running',
        pid: process.pid,
        worktree: missingWt,
      });
      const brokenWt = path.join(home, 'broken-wt-kkkk');
      fs.mkdirSync(brokenWt, { recursive: true });
      seedJob(productDir, 'git-fail-kkkk', {
        product: 'empty-files',
        state: 'running',
        pid: process.pid,
        worktree: brokenWt,
      });

      const baseExec = makeProductExec().execFile;
      const execFile = (cmd, args = [], options = {}) => {
        if (
          cmd === 'git'
          && (args.includes(brokenWt) || options?.cwd === brokenWt)
          && (args.includes('--name-status') || args.includes('--porcelain') || args.includes('diff') || args.includes('status'))
        ) {
          const err = new Error('fatal: not a git repository');
          err.stderr = 'fatal: not a git repository';
          throw err;
        }
        return baseExec(cmd, args, options);
      };

      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const unknown = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/no-such-slug/files');
        assert.equal(unknown.res.status, 200);
        assert.deepEqual(unknown.json, { files: [] });

        const noWt = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/no-wt-iiii/files');
        assert.equal(noWt.res.status, 200);
        assert.deepEqual(noWt.json, { files: [] });

        const missing = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/missing-wt-jjjj/files');
        assert.equal(missing.res.status, 200);
        assert.deepEqual(missing.json, { files: [] });

        const gitFail = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/git-fail-kkkk/files');
        assert.equal(gitFail.res.status, 200);
        assert.deepEqual(gitFail.json, { files: [] });
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('serve products API (phase 2)', () => {
  it('GET /api/products lists product.json records under the products dir', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'alpha', { name: 'Alpha' });
      seedProduct(home, 'beta', { name: 'Beta' });
      const handle = await startTestServe(home);
      try {
        const { res, json } = await jsonRequest(handle.baseUrl, 'GET', '/api/products');
        assert.equal(res.status, 200);
        const products = json?.products ?? json;
        assert.ok(Array.isArray(products), 'response must include a products array');
        const slugs = products.map((p) => p.slug).sort();
        assert.deepEqual(slugs, ['alpha', 'beta']);
        const alpha = products.find((p) => p.slug === 'alpha');
        assert.equal(alpha.name, 'Alpha');
        assert.equal(alpha.source, 'clone');
        assert.equal(alpha.remote?.owner, 'acme');
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/products init runs locked git pipeline, private gh repo create, product.json → 201', async () => {
    const home = makeTmpHome();
    try {
      const { execFile, calls } = makeProductExec({ login: 'login-user' });
      const handle = await startTestServe(home, {
        githubOwner: undefined,
        execFile,
        execFileSync: execFile,
      });
      try {
        const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'My App', slug: 'my-app', source: 'init', owner: 'acme' },
        });
        assert.equal(res.status, 201, `expected 201; got ${res.status}: ${JSON.stringify(json)}`);
        const product = json?.product ?? json;
        assert.equal(product.slug, 'my-app');
        assert.equal(product.name, 'My App');
        assert.equal(product.source, 'init');
        assert.equal(product.remote?.visibility, 'private');
        assert.equal(product.remote?.owner, 'acme');
        assert.ok(product.createdAt);

        const onDisk = readProductJson(home, 'my-app');
        assert.equal(onDisk.slug, 'my-app');
        assert.equal(onDisk.name, 'My App');
        assert.equal(onDisk.source, 'init');
        assert.equal(onDisk.remote.visibility, 'private');
        assert.equal(onDisk.remote.owner, 'acme');
        assert.ok(fs.statSync(path.join(productsDir(home), 'my-app')).isDirectory());

        // Spec-locked init: git init -b main → empty commit → gh repo create --private
        // → git remote add origin → push main (order matters).
        assertInitGitPipeline(calls, { owner: 'acme', slug: 'my-app' });
        // Request owner wins — must not need gh api user for owner resolution.
        assert.equal(ghApiUserCalls(calls).length, 0);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('init owner falls back: request owner → githubOwner → gh login', async () => {
    const home = makeTmpHome();
    try {
      // 1) request owner wins over githubOwner and login
      {
        const { execFile, calls } = makeProductExec({ login: 'login-user' });
        const handle = await startTestServe(home, {
          githubOwner: 'serve-org',
          execFile,
          execFileSync: execFile,
        });
        try {
          const { res } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
            body: { name: 'A', slug: 'owner-req', source: 'init', owner: 'req-org' },
          });
          assert.equal(res.status, 201);
          const creates = ghRepoCreateCalls(calls);
          assert.ok(creates[0].args.some((a) => String(a).includes('req-org/owner-req')));
          assert.equal(ghApiUserCalls(calls).length, 0);
        } finally {
          await handle.close();
        }
      }

      // 2) --github-owner when request omits owner
      {
        const { execFile, calls } = makeProductExec({ login: 'login-user' });
        const handle = await startTestServe(home, {
          githubOwner: 'serve-org',
          execFile,
          execFileSync: execFile,
        });
        try {
          const { res } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
            body: { name: 'B', slug: 'owner-serve', source: 'init' },
          });
          assert.equal(res.status, 201);
          const creates = ghRepoCreateCalls(calls);
          assert.ok(creates[0].args.some((a) => String(a).includes('serve-org/owner-serve')));
          assert.equal(ghApiUserCalls(calls).length, 0);
        } finally {
          await handle.close();
        }
      }

      // 3) gh login when neither request nor serve owner set
      {
        const { execFile, calls } = makeProductExec({ login: 'login-user' });
        const handle = await startTestServe(home, {
          githubOwner: undefined,
          execFile,
          execFileSync: execFile,
        });
        try {
          const { res } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
            body: { name: 'C', slug: 'owner-login', source: 'init' },
          });
          assert.equal(res.status, 201);
          assert.ok(ghApiUserCalls(calls).length >= 1);
          const creates = ghRepoCreateCalls(calls);
          assert.ok(creates[0].args.some((a) => String(a).includes('login-user/owner-login')));
          assert.equal(readProductJson(home, 'owner-login').remote.owner, 'login-user');
        } finally {
          await handle.close();
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/products clone clones url into products/<slug> and writes product.json', async () => {
    const home = makeTmpHome();
    try {
      const { execFile, calls } = makeProductExec();
      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const url = 'https://github.com/org/cloned-app.git';
        const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'Cloned App', slug: 'cloned-app', source: 'clone', url },
        });
        assert.equal(res.status, 201, `expected 201; got ${res.status}: ${JSON.stringify(json)}`);
        const product = json?.product ?? json;
        assert.equal(product.slug, 'cloned-app');
        assert.equal(product.source, 'clone');
        assert.ok(
          product.remote?.url === url || String(product.remote?.url).includes('cloned-app'),
          'clone product.json must record remote url',
        );

        const onDisk = readProductJson(home, 'cloned-app');
        assert.equal(onDisk.source, 'clone');
        assert.ok(fs.existsSync(path.join(productsDir(home), 'cloned-app', '.git')));

        const cloneCalls = calls.filter(
          (c) => c.command === 'git' && (c.args[0] === 'clone' || c.args.includes('clone')),
        );
        assert.equal(cloneCalls.length, 1);
        assert.ok(cloneCalls[0].args.includes(url));
        const dest = path.join(productsDir(home), 'cloned-app');
        assert.ok(
          cloneCalls[0].args.some((a) => path.resolve(String(a)) === path.resolve(dest)),
          `clone dest must be ${dest}; args=${cloneCalls[0].args.join(' ')}`,
        );
        // Non-empty clone: no heal push / set-head main; optional set-head --auto only.
        assert.equal(
          firstGitCallIndex(
            calls,
            (args) =>
              (args[0] === 'push' || args.includes('push')) && args.includes('main'),
          ),
          -1,
          'non-empty clone must not push main',
        );
        assert.equal(
          firstGitCallIndex(
            calls,
            (args) =>
              args.includes('remote')
              && args.includes('set-head')
              && args.includes('main')
              && !args.includes('--auto'),
          ),
          -1,
          'non-empty clone must not set-head origin main',
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/products clone heals empty remotes onto main with upstream', async () => {
    const home = makeTmpHome();
    try {
      const { execFile, calls } = makeProductExec({ emptyClone: true });
      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const url = 'https://github.com/org/empty-remote.git';
        const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'Empty Remote', slug: 'empty-remote', source: 'clone', url },
        });
        assert.equal(res.status, 201, `expected 201; got ${res.status}: ${JSON.stringify(json)}`);
        const product = json?.product ?? json;
        assert.equal(product.slug, 'empty-remote');
        assert.equal(product.source, 'clone');
        assert.ok(fs.existsSync(path.join(productsDir(home), 'empty-remote', 'product.json')));
        assertEmptyCloneHealPipeline(calls);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects invalid slug / missing name (400) and existing slug for init+clone (409)', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'taken');
      const { execFile, calls } = makeProductExec();
      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        for (const slug of ['Bad_Slug', '-leading', 'trailing-', 'has space', 'UPPER', 'a'.repeat(65)]) {
          const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
            body: { name: 'X', slug, source: 'init' },
          });
          assert.equal(res.status, 400, `slug ${JSON.stringify(slug)} → ${res.status}: ${JSON.stringify(json)}`);
        }

        const missingSlug = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'X', source: 'init' },
        });
        assert.equal(missingSlug.res.status, 400);

        // Required name (+ slug): missing or empty name → 400.
        const missingName = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { slug: 'needs-name', source: 'init' },
        });
        assert.equal(missingName.res.status, 400, 'missing name must be 400');

        const emptyName = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: '', slug: 'empty-name', source: 'init' },
        });
        assert.equal(emptyName.res.status, 400, 'empty name must be 400');

        const emptyNameClone = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: {
            name: '',
            slug: 'empty-name-clone',
            source: 'clone',
            url: 'https://github.com/org/empty-name-clone.git',
          },
        });
        assert.equal(emptyNameClone.res.status, 400, 'empty name on clone must be 400');

        const badSource = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'X', slug: 'ok-slug', source: 'local' },
        });
        assert.equal(badSource.res.status, 400);

        const cloneNoUrl = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'X', slug: 'needs-url', source: 'clone' },
        });
        assert.equal(cloneNoUrl.res.status, 400);

        const conflictInit = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'Taken', slug: 'taken', source: 'init' },
        });
        assert.equal(conflictInit.res.status, 409, 'init into existing products/<slug> → 409');

        // Clone into an existing products/<slug> dir is also 409 (not only init).
        const callsBeforeCloneConflict = calls.length;
        const conflictClone = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: {
            name: 'Taken Clone',
            slug: 'taken',
            source: 'clone',
            url: 'https://github.com/org/taken.git',
          },
        });
        assert.equal(conflictClone.res.status, 409, 'clone into existing products/<slug> → 409');
        const cloneAttempts = calls
          .slice(callsBeforeCloneConflict)
          .filter((c) => c.command === 'git' && (c.args[0] === 'clone' || c.args.includes('clone')));
        assert.equal(
          cloneAttempts.length,
          0,
          '409 existing slug must reject before git clone runs',
        );

        // Must not have wiped the existing product.
        assert.ok(fs.existsSync(path.join(productsDir(home), 'taken', 'product.json')));
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('502 on gh/git failure best-effort deletes the half-created product dir', async () => {
    const home = makeTmpHome();
    try {
      const { execFile } = makeProductExec({ failRepoCreate: true });
      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'Boom', slug: 'boom-app', source: 'init', owner: 'acme' },
        });
        assert.equal(res.status, 502, `expected 502; got ${res.status}: ${JSON.stringify(json)}`);
        assert.equal(
          fs.existsSync(path.join(productsDir(home), 'boom-app')),
          false,
          'half-created product dir must be removed after init failure',
        );
      } finally {
        await handle.close();
      }

      const { execFile: execClone } = makeProductExec({ failClone: true });
      const handle2 = await startTestServe(home, { execFile: execClone, execFileSync: execClone });
      try {
        const { res } = await jsonRequest(handle2.baseUrl, 'POST', '/api/products', {
          body: {
            name: 'Clone Boom',
            slug: 'clone-boom',
            source: 'clone',
            url: 'https://github.com/org/missing.git',
          },
        });
        assert.equal(res.status, 502);
        assert.equal(
          fs.existsSync(path.join(productsDir(home), 'clone-boom')),
          false,
          'half-created product dir must be removed after clone failure',
        );
      } finally {
        await handle2.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('GET /api/products/:product returns product + recent jobs summary; unknown → 404', async () => {
    const home = makeTmpHome();
    try {
      const dir = seedProduct(home, 'solo', { name: 'Solo App' });
      seedJob(dir, 'job-aaaa-1111', {
        product: 'solo',
        state: 'done',
        task: 'first',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
      });
      seedJob(dir, 'job-bbbb-2222', {
        product: 'solo',
        state: 'running',
        task: 'second',
        startedAt: '2026-01-02T00:00:00.000Z',
        pid: process.pid,
      });
      const handle = await startTestServe(home);
      try {
        const missing = await jsonRequest(handle.baseUrl, 'GET', '/api/products/nope');
        assert.equal(missing.res.status, 404);

        const { res, json } = await jsonRequest(handle.baseUrl, 'GET', '/api/products/solo');
        assert.equal(res.status, 200);
        const product = json?.product ?? json;
        assert.equal(product.slug, 'solo');
        assert.equal(product.name, 'Solo App');
        const jobs = json?.jobs ?? product.jobs ?? json?.recentJobs;
        assert.ok(Array.isArray(jobs), 'GET product must include a recent jobs summary array');
        assert.ok(jobs.length >= 1);
        assert.ok(jobs.some((j) => j.slug === 'job-bbbb-2222' || j.slug === 'job-aaaa-1111'));
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('PATCH /api/products/:product merges name / remote / defaults; unknown → 404', async () => {
    const home = makeTmpHome();
    try {
      const dir = seedProduct(home, 'patch-me', { name: 'Before' });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      const { execFile, calls } = makeProductExec();
      const handle = await startTestServe(home, { execFile, execFileSync: execFile });
      try {
        const missing = await jsonRequest(handle.baseUrl, 'PATCH', '/api/products/nope', {
          body: { name: 'X' },
        });
        assert.equal(missing.res.status, 404);

        const bad = await jsonRequest(handle.baseUrl, 'PATCH', '/api/products/patch-me', {
          body: '{',
        });
        assert.equal(bad.res.status, 400, `invalid JSON body must be 400; got ${bad.res.status}`);

        const { res, json } = await jsonRequest(handle.baseUrl, 'PATCH', '/api/products/patch-me', {
          body: {
            name: 'After',
            remote: { url: 'https://github.com/acme/patch-me-v2.git' },
            defaults: { agent: 'cursor', base: 'develop' },
          },
        });
        assert.equal(res.status, 200, `expected 200; got ${res.status}: ${JSON.stringify(json)}`);
        const product = json?.product ?? json;
        assert.equal(product.name, 'After');
        assert.equal(product.defaults?.agent, 'cursor');
        assert.equal(product.defaults?.base, 'develop');
        assert.ok(
          String(product.remote?.url).includes('patch-me-v2'),
          'PATCH should update remote.url',
        );

        const onDisk = readProductJson(home, 'patch-me');
        assert.equal(onDisk.name, 'After');
        assert.equal(onDisk.defaults.agent, 'cursor');
        assert.ok(String(onDisk.remote.url).includes('patch-me-v2'));

        // When remote URL changes, sync git remote if practical.
        const setUrl = calls.filter(
          (c) => c.command === 'git' && c.args.includes('remote') && c.args.includes('set-url'),
        );
        assert.ok(
          setUrl.length >= 1,
          `expected git remote set-url after remote.url PATCH; calls=${JSON.stringify(calls.filter((c) => c.command === 'git'))}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not expose DELETE /api/products/:product', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'keep-me');
      const handle = await startTestServe(home);
      try {
        const { res } = await jsonRequest(handle.baseUrl, 'DELETE', '/api/products/keep-me');
        assert.ok(
          res.status === 404 || res.status === 405,
          `DELETE must not be implemented; got ${res.status}`,
        );
        assert.ok(fs.existsSync(path.join(productsDir(home), 'keep-me', 'product.json')));
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('existing product dirs still accept POST /api/products/:product/jobs after products API', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'job-ready');
      const started = [];
      const handle = await startTestServe(home, {
        concurrency: 1,
        runDetached: mock.fn(async (prompt, options = {}) => {
          started.push({ prompt, cwd: options.cwd, pr: options.pr });
          if (typeof options.exit === 'function') options.exit(0);
        }),
      });
      try {
        const { res, json } = await jsonRequest(handle.baseUrl, 'POST', '/api/products/job-ready/jobs', {
          body: { task: 'still works', id: 'id-still' },
        });
        assert.ok(
          res.status === 200 || res.status === 201 || res.status === 202,
          `jobs route must still work; got ${res.status}`,
        );
        assert.ok(json?.slug);
        await new Promise((r) => setTimeout(r, 50));
        if (started.length > 0) {
          assert.equal(started[0].pr, true);
          assert.equal(
            path.resolve(started[0].cwd),
            path.resolve(path.join(productsDir(home), 'job-ready')),
          );
        }
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('serve handle surface', () => {
  it('startServe returns close() and uses injectable homedir (never process cwd as products root)', async () => {
    const home = makeTmpHome();
    try {
      const handle = await startTestServe(home);
      try {
        const dir = handle.productsDir ?? productsDir(home);
        assert.equal(path.resolve(dir), path.resolve(productsDir(home)));
        assert.notEqual(path.resolve(dir), path.resolve(process.cwd()));
        assert.equal(typeof handle.close, 'function');
        // Sanity: bound server is an http.Server when exposed.
        if (handle.server) assert.ok(handle.server instanceof http.Server);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('02-serve-static — static UI delivery + packaging', () => {
  it('package.json files includes the built UI under ui/', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    assert.ok(Array.isArray(pkg.files));
    assert.ok(
      pkg.files.some((entry) => String(entry).includes('ui')),
      `expected package.json "files" to include ui; got ${JSON.stringify(pkg.files)}`,
    );
  });

  it('GET / serves index.html from injectable staticDir; /api still JSON', async () => {
    const home = makeTmpHome();
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-serve-static-'));
    try {
      fs.writeFileSync(
        path.join(staticRoot, 'index.html'),
        '<!doctype html><html><body>orch-ui</body></html>\n',
      );
      fs.mkdirSync(path.join(staticRoot, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(staticRoot, 'assets', 'app.js'), 'console.log("ui");\n');

      const handle = await startTestServe(home, { staticDir: staticRoot });
      try {
        const index = await fetch(new URL('/', handle.baseUrl));
        assert.equal(index.status, 200);
        assert.match(index.headers.get('content-type') || '', /text\/html/);
        const html = await index.text();
        assert.match(html, /orch-ui/);

        const asset = await fetch(new URL('/assets/app.js', handle.baseUrl));
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get('content-type') || '', /javascript/);
        assert.match(await asset.text(), /console\.log/);

        const health = await jsonRequest(handle.baseUrl, 'GET', '/api/healthz');
        assert.equal(health.res.status, 200);
        assert.deepEqual(health.json, { ok: true });

        const missing = await fetch(new URL('/no-such-asset.css', handle.baseUrl));
        assert.equal(missing.status, 404);
      } finally {
        await handle.close();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(staticRoot, { recursive: true, force: true });
    }
  });

  it('blocks path traversal outside staticDir', async () => {
    const home = makeTmpHome();
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-serve-static-'));
    try {
      fs.writeFileSync(path.join(staticRoot, 'index.html'), '<html>ok</html>\n');
      const secret = path.join(os.tmpdir(), `orch-serve-secret-${process.pid}.txt`);
      fs.writeFileSync(secret, 'secret-data\n');

      const handle = await startTestServe(home, { staticDir: staticRoot });
      try {
        const escaped = await fetch(
          new URL(`/${'..%2F'.repeat(8)}${path.basename(secret)}`, handle.baseUrl),
        );
        // Must not leak the secret file; 404 JSON or empty is fine.
        const body = await escaped.text();
        assert.doesNotMatch(body, /secret-data/);
        assert.notEqual(escaped.status, 200);
      } finally {
        await handle.close();
      }
      fs.unlinkSync(secret);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(staticRoot, { recursive: true, force: true });
    }
  });
});
