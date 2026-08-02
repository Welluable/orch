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
 * Contract for `.spec/server.md` phase 1 (unit 02-serve-jobs-api):
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
 * - HTTP (no auth): `GET /api/healthz`; `POST /api/products/:product/jobs` for
 *   an existing product dir only; `GET /api/jobs`, `GET /api/jobs/:slug`,
 *   `GET /api/jobs/:slug/logs`, `POST .../pause|resume|stop`.
 * - Durable `state: "queued"` jobs are re-enqueued on boot; shutdown does not
 *   kill children. Product create/PATCH and files API are out of scope here.
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

function serveBaseOptions(home, overrides = {}) {
  const runDetached = overrides.runDetached ?? mock.fn(async (_prompt, options = {}) => {
    // Mimic detach-parent success without exiting the test process.
    if (typeof options.exit === 'function') options.exit(0);
  });
  return {
    homedir: () => home,
    host: '127.0.0.1',
    port: 0,
    concurrency: 2,
    maxQueue: 64,
    agent: 'claude',
    maxRounds: 5,
    runDetached,
    isBinaryOnPath: (bin) => bin === 'gh' || bin === 'claude' || bin === 'agent',
    execFileSync: okGhExecFileSync,
    log: () => {},
    warn: () => {},
    ...overrides,
    runDetached: overrides.runDetached ?? runDetached,
  };
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

  it('does not expose product create/PATCH or files routes in this unit', async () => {
    const home = makeTmpHome();
    try {
      seedProduct(home, 'solo');
      const handle = await startTestServe(home);
      try {
        // Phase 1 may 404 these; must not succeed as implemented product APIs.
        const create = await jsonRequest(handle.baseUrl, 'POST', '/api/products', {
          body: { name: 'X', slug: 'x', source: 'init' },
        });
        assert.ok(
          create.res.status === 404 || create.res.status === 405 || create.res.status === 501,
          `product create must be deferred; got ${create.res.status}`,
        );

        const patch = await jsonRequest(handle.baseUrl, 'PATCH', '/api/products/solo', {
          body: { name: 'Nope' },
        });
        assert.ok(
          patch.res.status === 404 || patch.res.status === 405 || patch.res.status === 501,
          `product PATCH must be deferred; got ${patch.res.status}`,
        );

        const files = await jsonRequest(handle.baseUrl, 'GET', '/api/jobs/any/files');
        assert.ok(
          files.res.status === 404 || files.res.status === 405 || files.res.status === 501,
          `files API must be deferred; got ${files.res.status}`,
        );
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
