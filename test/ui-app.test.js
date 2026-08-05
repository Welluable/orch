import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract for unit 01-ui-app (`.spec/server.md` phase 4 UI only):
 *
 * - Nested Next.js App Router + TypeScript app under `ui/` with its own
 *   `package.json` and `next.config` set to `output: 'export'` (static `out/`).
 * - Client-side routing works under static export for product/job paths
 *   (query params or client-only segments — no per-slug SSG at build time).
 * - Same-origin `/api/...` fetch helper surfaces `{ error }` from non-OK
 *   responses; no auth headers or login UI.
 * - Screens: Products (`/` init + clone, navigate to Product on 201),
 *   Product (GET product detail or GET .../jobs — not Run POST alone — +
 *   job→Job links + Run with uuid `id` + exclusive default/SEQ/Fan-out/
 *   Decompose mode before submit (POST mode with task+id) + danger “Clean
 *   jobs” via POST …/jobs/clean with confirm), Job (poll/refresh of GET
 *   /api/jobs/:slug for state/prUrl — not logs-only SSE; also poll/refresh
 *   GET /api/jobs/:slug/files so the Files card updates without manual Reload;
 *   logs, files file.path+file.status, Pause/Resume/Stop). No per-job delete /
 *   continue; no HTTP DELETE (bulk clean is POST).
 * - When GET /api/jobs/:slug returns `job.seq` (serve enrichment: doc `state` +
 *   ordered `units[]` with id/title/subtask/state/slug|childSlug), JobScreen
 *   must render that backlog in a sidebar section-panel peer to Controls/Files
 *   so plan-only decompose results stay visible. Omit the section when
 *   `job.seq` is absent. Display only — no Start / POST …/start (out of scope).
 * - Mobile-responsive layout cues; root `package.json` `files` includes the
 *   built UI (`ui/out/**`) and `lib/serve.js` serves non-/api static export
 *   (unit 02 packaging + static middleware).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const uiRoot = path.join(root, 'ui');

function exists(p) {
  return fs.existsSync(p);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function readJson(p) {
  return JSON.parse(read(p));
}

/** Walk ui/ for source files (skip node_modules, .next, out). */
function walkUiSources(dir = uiRoot, acc = []) {
  if (!exists(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.next' || ent.name === 'out') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkUiSources(full, acc);
      continue;
    }
    if (/\.(tsx?|jsx?|mjs|cjs|css)$/.test(ent.name)) acc.push(full);
  }
  return acc;
}

function allUiSourceText() {
  return walkUiSources().map(read).join('\n');
}

function findNextConfigPath() {
  for (const name of ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']) {
    const p = path.join(uiRoot, name);
    if (exists(p)) return p;
  }
  return null;
}

function assertAppRouterLayout() {
  const candidates = [
    path.join(uiRoot, 'app', 'layout.tsx'),
    path.join(uiRoot, 'app', 'layout.jsx'),
    path.join(uiRoot, 'src', 'app', 'layout.tsx'),
    path.join(uiRoot, 'src', 'app', 'layout.jsx'),
  ];
  const hit = candidates.find(exists);
  assert.ok(hit, 'expected App Router layout at ui/app/layout.tsx (or ui/src/app/...)');
  return hit;
}

function assertAppRouterPage() {
  const candidates = [
    path.join(uiRoot, 'app', 'page.tsx'),
    path.join(uiRoot, 'app', 'page.jsx'),
    path.join(uiRoot, 'src', 'app', 'page.tsx'),
    path.join(uiRoot, 'src', 'app', 'page.jsx'),
  ];
  const hit = candidates.find(exists);
  assert.ok(hit, 'expected App Router page at ui/app/page.tsx (or ui/src/app/...)');
  return hit;
}

/**
 * Static-export-safe dynamic routing: must read product/job identity from the
 * client URL (query/searchParams/hash/location) — bare `use client` or a
 * catch-all segment alone is not enough under output:export.
 */
function hasStaticExportSafeDynamicRouting(src) {
  const readsClientUrl =
    /useSearchParams|URLSearchParams|searchParams/.test(src) ||
    /\?product=|\?slug=|\?job=/.test(src) ||
    /window\.location\.(search|hash|href)/.test(src) ||
    /location\.(search|hash)/.test(src);
  if (!readsClientUrl) return false;

  // Must wire that client URL into product and job navigation/API paths.
  const productPathWiring =
    /\/api\/products\/[`$]|\/api\/products\/\$\{|\/api\/products\/['"`]\s*\+|products\/\$\{|product=|['"`]product['"`]\s*[:=]/.test(
      src,
    );
  const jobPathWiring =
    /\/api\/jobs\/[`$]|\/api\/jobs\/\$\{|\/api\/jobs\/['"`]\s*\+|jobs\/\$\{|job=|['"`](?:slug|job)['"`]\s*[:=]/.test(
      src,
    );
  return productPathWiring && jobPathWiring;
}

/** Slice each setInterval/setTimeout first argument (callback or function ref). */
function eachTimerFirstArg(src, visit) {
  const re = /set(?:Interval|Timeout)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    const start = i;
    let depth = 1;
    let inStr = null;
    let escaped = false;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') {
        depth += 1;
        continue;
      }
      if (ch === ')' || ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          visit(src.slice(start, i));
          break;
        }
        continue;
      }
      if (ch === ',' && depth === 1) {
        visit(src.slice(start, i));
        break;
      }
    }
  }
}

/**
 * True when `s` references GET /api/jobs/:slug (job record for state/prUrl),
 * not /logs, /files, or pause|resume|stop control paths.
 */
function mentionsJobStatusApi(s) {
  // Template / concat forms: `/api/jobs/${slug}` or '/api/jobs/' + id
  if (
    /\/api\/jobs\/\$\{[^}]+\}(?!\/(?:logs|files|pause|resume|stop))/.test(s) ||
    /\/api\/jobs\/['"`]\s*\+\s*[^;]+(?![\s\S]{0,40}\/(?:logs|files|pause|resume|stop))/.test(s)
  ) {
    // Reject if the only /api/jobs/ hits in this slice are clearly sub-resources.
    const withoutSubs = s.replace(
      /\/api\/jobs\/(?:\$\{[^}]+\}|[^/'"`\s]+)\/(?:logs|files|pause|resume|stop)/g,
      '',
    );
    return /\/api\/jobs\//.test(withoutSubs);
  }
  // Literal or generic `/api/jobs/` then slug token, not a known subpath.
  if (!/\/api\/jobs\//.test(s)) return false;
  const withoutSubs = s.replace(
    /\/api\/jobs\/(?:\$\{[^}]+\}|[^/'"`\s]+)\/(?:logs|files|pause|resume|stop)/g,
    '',
  );
  return /\/api\/jobs\/(?:\$\{[^}]+\}|[A-Za-z0-9_$'"`+][^/'"`\s]*)/.test(withoutSubs);
}

/** Function/const whose body (≤1200 chars) hits the job *status* API. */
function fnHitsJobStatus(src, fn) {
  const re = new RegExp(
    `(?:function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)([\\s\\S]{0,1200})`,
  );
  const m = re.exec(src);
  return m ? mentionsJobStatusApi(m[1]) : false;
}

/** True when `s` references GET /api/jobs/:slug/files (not bare status or /logs). */
function mentionsJobFilesApi(s) {
  return (
    /\/api\/jobs\/\$\{[^}]+\}\/files\b/.test(s) ||
    /\/api\/jobs\/['"`]\s*\+\s*[^;]+\/files\b/.test(s) ||
    /\/api\/jobs\/[^'"\`\n]*\/files\b/.test(s) ||
    /['"`]\/files['"`]/.test(s) && /\/api\/jobs\//.test(s)
  );
}

/** Function/const whose body (≤1200 chars) hits the job *files* API. */
function fnHitsJobFiles(src, fn) {
  const re = new RegExp(
    `(?:function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)([\\s\\S]{0,1200})`,
  );
  const m = re.exec(src);
  return m ? mentionsJobFilesApi(m[1]) : false;
}

/**
 * Job files poll/refresh of GET /api/jobs/:slug/files.
 * Manual Reload-only (button without a timer) is insufficient — the Files card
 * must refresh on an interval (or equivalent) while the Job screen is open.
 */
function hasJobFilesPollOrRefresh(src) {
  let timerTiedToFiles = false;
  eachTimerFirstArg(src, (arg) => {
    if (timerTiedToFiles) return;
    const trimmed = arg.trim();
    const named = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (named && fnHitsJobFiles(src, named[1])) {
      timerTiedToFiles = true;
      return;
    }
    if (mentionsJobFilesApi(arg)) {
      timerTiedToFiles = true;
      return;
    }
    for (const call of arg.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (
        name === 'function' ||
        name === 'async' ||
        name === 'if' ||
        name === 'while' ||
        name === 'for' ||
        name === 'switch' ||
        name === 'catch'
      ) {
        continue;
      }
      if (fnHitsJobFiles(src, name)) {
        timerTiedToFiles = true;
        return;
      }
    }
  });
  if (timerTiedToFiles) return true;

  if (
    /\brefetchInterval\b/.test(src) &&
    [...src.matchAll(/\brefetchInterval\b/g)].some((m) => {
      const win = src.slice(Math.max(0, m.index - 500), m.index + 500);
      return mentionsJobFilesApi(win);
    })
  ) {
    return true;
  }

  return false;
}

/**
 * Visit every `function <name>(...){...}` body in `src` (minified builds reuse
 * single-letter names; first-match alone is unsafe).
 */
function eachFnBodyNamed(src, name, visit) {
  const re = new RegExp(
    `(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{`,
    'g',
  );
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < src.length && depth > 0; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    visit(src.slice(start, i - 1));
  }
}

/**
 * True when a Job-style setInterval(()=>{a().catch();b().catch();...},2500)
 * invokes at least one loader whose *own* body GETs .../files.
 *
 * Unlike first-match extractFnBody, accepts any same-named function body that
 * contains /files (minified name collisions across IIFEs/modules).
 */
function pollIntervalInvokesFilesLoader(src) {
  // Prefer looking near each setInterval (same chunk) rather than whole-bundle first match.
  for (const m of src.matchAll(/setInterval\(\(\)=>\{([\s\S]*?)\},(?:2500|2e3|2\.5e3)\)/g)) {
    const intervalBody = m[1];
    if (/\/files/.test(intervalBody)) return true;

    const names = [
      ...intervalBody.matchAll(/\b([A-Za-z_$][\w$]*)\(\)\.catch\(/g),
    ].map((x) => x[1]);
    // Scope lookup to the setInterval's surrounding chunk when possible.
    const windowStart = Math.max(0, m.index - 8000);
    const windowEnd = Math.min(src.length, m.index + m[0].length + 2000);
    const scoped = src.slice(windowStart, windowEnd);

    for (const name of names) {
      let hit = false;
      eachFnBodyNamed(scoped, name, (fnBody) => {
        if (hit) return;
        if (/\/files/.test(fnBody)) hit = true;
      });
      if (hit) return true;
      // Fallback: any same-named body in the full src (cross-IIFE reuse).
      eachFnBodyNamed(src, name, (fnBody) => {
        if (hit) return;
        if (/\/files/.test(fnBody)) hit = true;
      });
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Job status poll/refresh of GET /api/jobs/:slug for state/prUrl.
 *
 * Must NOT pass for: logs-only EventSource/text/event-stream, a bare Refresh
 * label anywhere, any refetch(), or one-shot status fetch + logs SSE.
 * Accept: timer/refetch/Refresh/SSE tied to the job *status* path (not /logs).
 */
function hasJobStatusPollOrRefresh(src) {
  let timerTiedToStatus = false;
  eachTimerFirstArg(src, (arg) => {
    if (timerTiedToStatus) return;
    const trimmed = arg.trim();
    const named = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
    if (named && fnHitsJobStatus(src, named[1])) {
      timerTiedToStatus = true;
      return;
    }
    if (mentionsJobStatusApi(arg)) {
      timerTiedToStatus = true;
      return;
    }
    for (const call of arg.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (
        name === 'function' ||
        name === 'async' ||
        name === 'if' ||
        name === 'while' ||
        name === 'for' ||
        name === 'switch' ||
        name === 'catch'
      ) {
        continue;
      }
      if (fnHitsJobStatus(src, name)) {
        timerTiedToStatus = true;
        return;
      }
    }
  });
  if (timerTiedToStatus) return true;

  // react-query style: refetchInterval (or similar) near job *status* fetch —
  // bare refetch() coexisting with a one-shot status GET must NOT pass.
  if (
    /\brefetchInterval\b/.test(src) &&
    [...src.matchAll(/\brefetchInterval\b/g)].some((m) => {
      const win = src.slice(Math.max(0, m.index - 500), m.index + 500);
      return mentionsJobStatusApi(win);
    })
  ) {
    return true;
  }

  // EventSource / SSE only counts if connected to job *status* URL, not /logs.
  if (/EventSource|text\/event-stream/.test(src)) {
    const sseStatus =
      /new\s+EventSource\s*\(\s*[`'"][^'"`]*\/api\/jobs\/(?![^'"`]*\/logs)/.test(src) ||
      /EventSource\s*\(\s*[`'"][^'"`]*\/api\/jobs\/\$\{[^}]+\}(?!\/logs)/.test(src) ||
      /(?:EventSource|text\/event-stream)[\s\S]{0,200}\/api\/jobs\/(?![\s\S]{0,80}\/logs)/.test(
        src,
      );
    // Reject logs-oriented Accept: text/event-stream on .../logs
    const logsOnlySse =
      /\/api\/jobs\/[^'"\`\n]*\/logs[\s\S]{0,200}text\/event-stream|text\/event-stream[\s\S]{0,200}\/api\/jobs\/[^'"\`\n]*\/logs/.test(
        src,
      ) || /EventSource\s*\(\s*[`'"][^'"`]*\/logs/.test(src);
    if (sseStatus && !logsOnlySse && mentionsJobStatusApi(src)) {
      // Still require the EventSource URL itself targets status, not merely
      // coexisting with a one-shot status fetch + logs SSE.
      const esHitsStatus = [...src.matchAll(/EventSource\s*\(\s*([^)]*)\)/g)].some((m) =>
        mentionsJobStatusApi(m[1]),
      );
      const acceptNearStatus =
        /text\/event-stream[\s\S]{0,160}\/api\/jobs\/|\/api\/jobs\/[\s\S]{0,160}text\/event-stream/.test(
          src,
        ) &&
        [...src.matchAll(/text\/event-stream/g)].some((m) => {
          const win = src.slice(Math.max(0, m.index - 160), m.index + 160);
          return mentionsJobStatusApi(win) && !/\/logs/.test(win);
        });
      if (esHitsStatus || acceptNearStatus) return true;
    }
  }

  // Manual Refresh: label alone is insufficient — handler must hit status API.
  const hasRefreshLabel = />\s*Refresh\s*</.test(src) || /['"`]Refresh['"`]/.test(src);
  if (hasRefreshLabel) {
    if (/onClick=\{[^}]*\/api\/jobs\/(?![^}]*\/(?:logs|files|pause|resume|stop))/.test(src)) {
      return true;
    }
    for (const m of src.matchAll(/>\s*Refresh\s*<|['"`]Refresh['"`]/g)) {
      const win = src.slice(Math.max(0, m.index - 500), m.index + 500);
      // Inline status fetch inside an onClick/onPress near Refresh.
      if (mentionsJobStatusApi(win) && /on(?:Click|Press)=\{[^}]*\/api\/jobs\//.test(win)) {
        return true;
      }
      // Named handler wired to the control: onClick={loadJob} / onClick={() => loadJob()}
      for (const h of win.matchAll(
        /on(?:Click|Press)=\{(?:\(\)\s*=>\s*)?([A-Za-z_$][\w$]*)\s*(?:\(|\})/g,
      )) {
        if (fnHitsJobStatus(src, h[1])) return true;
      }
    }
  }

  // onClick that directly fetches job status (without requiring "Refresh" text).
  if (
    /onClick=\{[^}]*\/api\/jobs\/(?![^}]*\/(?:logs|files|pause|resume|stop))/.test(src)
  ) {
    return true;
  }

  return false;
}

/** Explicit HTTP 201 check on a response (status === 201 or equivalent). */
function hasHttp201Check(s) {
  return (
    /(?:res|response|r|result)\.status\s*===?\s*201\b/.test(s) ||
    /\.status\s*===?\s*201\b/.test(s) ||
    /status\s*===?\s*201\b/.test(s) ||
    /\b(?:res|response|r)\s*===?\s*201\b/.test(s)
  );
}

/**
 * After Products init/clone POST, navigate to Product when response is 201.
 * Requires status===201 (or equivalent) plus router/Link/search navigation
 * toward the Product screen — create POST alone is insufficient.
 */
function hasNavigateToProductOn201(src) {
  const nav =
    /router\.(?:push|replace)|navigate\s*\(|setSearchParams|pushState|replaceState|location\.(?:assign|href\s*=)/;
  const toProduct =
    /(?:\?[^'"`]*(?:product|slug)=|['"`]\/\?[^'"`]*(?:product|slug)=|\/(?:product|products)\/|['"`]product['"`]\s*[:=]|product\.slug|(?:data|body|json|payload|result|res)\.product\b)/;

  // Windows centered on each `201` status check.
  for (const m of src.matchAll(/\b201\b/g)) {
    const win = src.slice(Math.max(0, m.index - 120), m.index + 500);
    if (!hasHttp201Check(win)) continue;
    if (nav.test(win) && toProduct.test(win)) return true;
  }

  // Navigation call sites looking backward for a 201 check.
  for (const m of src.matchAll(
    /router\.(?:push|replace)\s*\(|navigate\s*\(|setSearchParams\s*\(|pushState\s*\(|replaceState\s*\(/g,
  )) {
    const win = src.slice(Math.max(0, m.index - 500), m.index + 220);
    if (hasHttp201Check(win) && toProduct.test(win)) return true;
  }

  return false;
}

describe('01-ui-app contract helpers (false-pass guards)', () => {
  it('hasJobStatusPollOrRefresh rejects logs-only SSE, bare Refresh, bare refetch, one-shot+logs', () => {
    assert.equal(
      hasJobStatusPollOrRefresh(`
        fetch(\`/api/jobs/\${slug}\`);
        const es = new EventSource(\`/api/jobs/\${slug}/logs\`);
        Accept: text/event-stream
      `),
      false,
      'one-shot status + logs EventSource must not count as status poll/refresh',
    );
    assert.equal(
      hasJobStatusPollOrRefresh(`
        fetch(\`/api/jobs/\${slug}/logs\`, { headers: { Accept: 'text/event-stream' } });
        <button>Refresh</button>
      `),
      false,
      'logs-only SSE and a bare Refresh label must not pass',
    );
    assert.equal(
      hasJobStatusPollOrRefresh(`
        const { refetch } = useQuery(...);
        refetch();
        fetch(\`/api/jobs/\${slug}\`);
      `),
      false,
      'bare refetch() coexisting with one-shot status fetch must not pass',
    );
    assert.equal(
      hasJobStatusPollOrRefresh(`
        async function loadJob() { await fetch(\`/api/jobs/\${slug}\`); }
        loadJob();
        <span>Refresh</span>
      `),
      false,
      'one-shot loadJob + Refresh text without wiring must not pass',
    );
  });

  it('hasJobStatusPollOrRefresh accepts timer/Refresh wired to job status API', () => {
    assert.equal(
      hasJobStatusPollOrRefresh(`
        async function loadJob() { await fetch(\`/api/jobs/\${slug}\`); }
        setInterval(loadJob, 2000);
      `),
      true,
      'setInterval(loadJob) where loadJob GETs /api/jobs/:slug must pass',
    );
    assert.equal(
      hasJobStatusPollOrRefresh(`
        setInterval(() => { fetch('/api/jobs/' + slug); }, 3000);
      `),
      true,
      'setInterval inline status fetch must pass',
    );
    assert.equal(
      hasJobStatusPollOrRefresh(`
        async function loadJob() { return fetch(\`/api/jobs/\${id}\`); }
        <button onClick={loadJob}>Refresh</button>
      `),
      true,
      'Refresh control calling a status loader must pass',
    );
  });

  it('hasJobFilesPollOrRefresh rejects mount-only / Reload-only files fetches', () => {
    assert.equal(
      hasJobFilesPollOrRefresh(`
        async function loadFiles() { await fetch(\`/api/jobs/\${slug}/files\`); }
        loadFiles();
        <button onClick={loadFiles}>Reload files</button>
      `),
      false,
      'one-shot + manual Reload files must not count as files poll',
    );
    assert.equal(
      hasJobFilesPollOrRefresh(`
        async function loadJob() { await fetch(\`/api/jobs/\${slug}\`); }
        setInterval(loadJob, 2500);
      `),
      false,
      'status-only interval must not count as files poll',
    );
  });

  it('hasJobFilesPollOrRefresh accepts timer wired to job files API', () => {
    assert.equal(
      hasJobFilesPollOrRefresh(`
        async function loadFiles() { await fetch(\`/api/jobs/\${slug}/files\`); }
        setInterval(loadFiles, 2500);
      `),
      true,
      'setInterval(loadFiles) where loadFiles GETs .../files must pass',
    );
    assert.equal(
      hasJobFilesPollOrRefresh(`
        async function loadJob() { await fetch(\`/api/jobs/\${slug}\`); }
        async function loadFiles() { await fetch(\`/api/jobs/\${slug}/files\`); }
        setInterval(() => { loadJob(); loadFiles(); }, 2500);
      `),
      true,
      'setInterval that also calls loadFiles must pass',
    );
  });

  it('built-export files-poll lookup survives minified same-name collisions', () => {
    // Minified bundles reuse single-letter names across IIFEs/modules. Looking up
    // only the *first* `function y(` misses the real async loader that GETs /files.
    const colliding = [
      'function y(){return 1}',
      'function g(){fetch("/api/jobs/"+s)}',
      'async function y(){await fetch("/api/jobs/"+s+"/files")}',
      'setInterval(()=>{g().catch(()=>{}),y().catch(()=>{})},2500)',
    ].join(';');
    assert.equal(
      pollIntervalInvokesFilesLoader(colliding),
      true,
      'must accept when *any* same-named function body hits /files, not only the first match',
    );

    const statusOnly = [
      'function y(){return 1}',
      'async function y(){await fetch("/api/jobs/"+s)}',
      'setInterval(()=>{y().catch(()=>{})},2500)',
    ].join(';');
    assert.equal(
      pollIntervalInvokesFilesLoader(statusOnly),
      false,
      'must reject when no same-named body GETs /files',
    );
  });

  it('hasNavigateToProductOn201 requires status 201 plus product navigation', () => {
    assert.equal(
      hasNavigateToProductOn201(`
        await api('/api/products', { method: 'POST', body: { source: 'init', name, slug } });
        // no status check, no navigate
      `),
      false,
      'init POST without 201+navigate must not pass',
    );
    assert.equal(
      hasNavigateToProductOn201(`
        const res = await api('/api/products', { method: 'POST', body });
        if (res.ok) setError(null);
      `),
      false,
      'res.ok without status===201 and product navigation must not pass',
    );
    assert.equal(
      hasNavigateToProductOn201(`
        const res = await fetch('/api/products', { method: 'POST', body });
        if (res.status === 201) {
          router.push('/?product=' + slug);
        }
      `),
      true,
      'status===201 then router.push to product must pass',
    );
    assert.equal(
      hasNavigateToProductOn201(`
        const res = await createProduct(body);
        if (res.status === 201) {
          navigate(\`/?product=\${res.product.slug}\`);
        }
      `),
      true,
      'status===201 then navigate to product query must pass',
    );
  });
});

describe('01-ui-app scaffold', () => {
  it('has a nested ui/ package with Next.js and a build script', () => {
    assert.ok(exists(uiRoot), 'expected ui/ directory');
    const pkgPath = path.join(uiRoot, 'package.json');
    assert.ok(exists(pkgPath), 'expected ui/package.json');
    const pkg = readJson(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(deps.next, 'ui/package.json must depend on next');
    assert.ok(deps.react, 'ui/package.json must depend on react');
    assert.ok(deps.typescript || exists(path.join(uiRoot, 'tsconfig.json')),
      'TypeScript required (typescript dep or ui/tsconfig.json)');
    assert.equal(typeof pkg.scripts?.build, 'string');
    assert.match(pkg.scripts.build, /next\s+build/);
  });

  it('configures next output: export for static out/', () => {
    const cfgPath = findNextConfigPath();
    assert.ok(cfgPath, 'expected ui/next.config.{ts,mjs,js}');
    const cfg = read(cfgPath);
    assert.match(cfg, /output\s*:\s*['"]export['"]/);
  });

  it('uses App Router entrypoints (layout + page)', () => {
    assertAppRouterLayout();
    assertAppRouterPage();
  });

  it('supports static-export-safe dynamic product/job routing (no generateStaticParams for slugs)', () => {
    const src = allUiSourceText();
    assert.ok(src.length > 0, 'expected ui source files');
    assert.match(src, /product/i);
    assert.match(src, /job/i);

    // Bare `use client` or [[...catchAll]] alone must not pass.
    assert.ok(
      hasStaticExportSafeDynamicRouting(src),
      'under output:export, product/job paths must read client URL ' +
        '(searchParams / URLSearchParams / location.search|hash) and wire ' +
        'those values into /api/products/... and /api/jobs/... (or navigation); ' +
        '`use client` or catch-all segments alone are insufficient',
    );

    // Dynamic segment SSG for every slug is not required; if present, still
    // require the client URL wiring above (already asserted).
    if (/generateStaticParams/.test(src)) {
      assert.ok(
        /searchParams|useSearchParams|URLSearchParams|window\.location/.test(src),
        'generateStaticParams alone is insufficient under output:export; use query/client routing for product/job paths',
      );
    }
  });
});

describe('01-ui-app api helper', () => {
  it('provides a same-origin /api fetch helper that surfaces { error }', () => {
    const src = allUiSourceText();
    assert.match(src, /\/api\//);
    // Helper should use relative same-origin paths (not a hardcoded remote host for API).
    assert.doesNotMatch(src, /fetch\(\s*['"]https?:\/\/[^'"]+\/api\//);
    // Must parse JSON and read .error from the body on non-OK responses.
    assert.ok(
      /\.json\s*\(/.test(src),
      'expected response.json() (or equivalent) to parse /api error bodies',
    );
    const readsJsonError =
      /(?:body|data|json|payload|result)\s*\.\s*error\b/.test(src) ||
      /\{\s*error\s*\}/.test(src) ||
      /(?:body|data|json|payload)\s*\?\.\s*error\b/.test(src);
    const handlesNonOk =
      /!\s*(?:res|response|r)\.ok\b/.test(src) ||
      /(?:res|response|r)\.ok\s*===?\s*false/.test(src) ||
      /(?:res|response|r)\.status\s*[>=!]/.test(src);
    assert.ok(
      readsJsonError && handlesNonOk,
      'expected reading JSON error (body.error / data.error / { error }) from non-OK /api responses',
    );
  });

  it('does not send auth headers or render login UI', () => {
    const src = allUiSourceText();
    assert.doesNotMatch(src, /Authorization\s*:/i);
    assert.doesNotMatch(src, /['"]Bearer\s/);
    // Forbid login/sign-in controls (comments saying "no login" are fine).
    assert.doesNotMatch(src, /<(button|a|Link)[^>]*>\s*[^<]*(log\s*in|sign\s*in)/i);
    assert.doesNotMatch(src, /\btype\s*=\s*['"]password['"]/);
  });
});

describe('01-ui-app Products screen', () => {
  it('lists products and posts init + clone forms', () => {
    const src = allUiSourceText();

    // GET list
    assert.ok(
      /(?:fetch|get|api)\s*\(\s*[`'"]\/api\/products[`'"]|['"`]\/api\/products['"`]/.test(src) ||
        /\/api\/products(?!\/)/.test(src),
      'Products screen must GET /api/products for the list',
    );

    // Blank init POST body: name, slug, source:"init", optional owner
    assert.match(src, /source\s*:\s*['"]init['"]/);
    assert.ok(
      /owner/.test(src),
      'blank init form must include optional owner field (posted when set)',
    );
    assert.ok(
      /name\s*:/.test(src) && /slug\s*:/.test(src),
      'init/clone POST bodies must include name and slug properties',
    );

    // Clone POST body: name, slug, source:"clone", url
    assert.match(src, /source\s*:\s*['"]clone['"]/);
    assert.ok(
      /url\s*:/.test(src),
      'clone POST body must include url property',
    );

    // Both sources appear near product create payloads (not just stray words)
    assert.ok(
      /source\s*:\s*['"]init['"][\s\S]{0,400}(?:name|slug|owner)/.test(src) ||
        /(?:name|slug|owner)[\s\S]{0,400}source\s*:\s*['"]init['"]/.test(src),
      'init payload should include name/slug/owner alongside source:"init"',
    );
    assert.ok(
      /source\s*:\s*['"]clone['"][\s\S]{0,400}(?:name|slug|url)/.test(src) ||
        /(?:name|slug|url)[\s\S]{0,400}source\s*:\s*['"]clone['"]/.test(src),
      'clone payload should include name/slug/url alongside source:"clone"',
    );

    // Navigate to Product on 201 after init/clone — POST alone must NOT pass.
    assert.ok(
      hasNavigateToProductOn201(src),
      'Products init/clone must navigate to the Product screen when status===201 ' +
        '(or equivalent): check response status 201 and router.push/replace, ' +
        'navigate(), setSearchParams, or Link toward product/slug — ' +
        'create POST without 201+navigation is insufficient',
    );
  });

  it('omits product delete API calls', () => {
    const src = allUiSourceText();
    assert.doesNotMatch(src, /method\s*:\s*['"]DELETE['"]/);
    assert.doesNotMatch(src, /['"]DELETE['"]\s*,\s*\{/);
  });
});

describe('01-ui-app Product screen', () => {
  it('loads product + jobs via GET and Runs with a caller-generated uuid id', () => {
    const src = allUiSourceText();

    // Product detail load: GET /api/products/:product (and/or GET .../jobs).
    // Run-only POST `fetch('/api/products/${...}/jobs', { method:'POST' })` must NOT pass:
    // - detail path must be /api/products/${...} WITHOUT a trailing /jobs
    // - jobs list GET is fetch(url) with no POST options, or explicit method GET —
    //   not a bare `/api/products/${` / `/jobs` substring that also matches Run POST.
    const getsProductDetail =
      /\/api\/products\/\$\{[^}]+\}(?!\/jobs)/.test(src) ||
      /(?:fetch|get|apiGet|api)\s*\(\s*[`'"]\/api\/products\/[^`'"]+[`'"]\s*\)/.test(src) ||
      /method\s*:\s*['"]GET['"][\s\S]{0,160}\/api\/products\/(?![\s\S]{0,80}\/jobs)/.test(src);
    // GET .../jobs: closing quote immediately followed by `)` (no POST options), or method GET.
    const getsProductJobs =
      /\/api\/products\/\$\{[^}]+\}\/jobs[`'"]\s*\)/.test(src) ||
      /\/api\/products\/[^`'"]+\/jobs[`'"]\s*\)/.test(src) ||
      /method\s*:\s*['"]GET['"][\s\S]{0,200}\/api\/products\/[\s\S]{0,100}\/jobs/.test(src) ||
      /\/api\/products\/[\s\S]{0,100}\/jobs[\s\S]{0,120}method\s*:\s*['"]GET['"]/.test(src);
    assert.ok(
      getsProductDetail || getsProductJobs,
      'Product screen must GET /api/products/:product (product + recent jobs) ' +
        'and/or GET /api/products/:product/jobs — Run POST alone is insufficient',
    );

    // Job list must link/navigate to the Job screen (not just render text).
    const linksToJob =
      /href\s*=\s*\{?[`'"][^'"`]*\b(?:job|slug)=/.test(src) ||
      /href\s*=\s*\{?[`'"][^'"`]*\/(?:job|jobs)\//.test(src) ||
      /(?:Link|router\.(?:push|replace)|navigate)\s*\(\s*[`'"][^'"`]*(?:\?[^'"`]*(?:job|slug)=|\/(?:job|jobs)\/)/.test(
        src,
      ) ||
      /(?:setSearchParams|pushState|replaceState)[\s\S]{0,200}(?:job|slug)/.test(src) ||
      /(?:href|to)\s*=\s*\{[^}]*(?:job\.slug|job\.id|j\.slug|\.slug)/.test(src);
    assert.ok(
      linksToJob,
      'Product job list must link/navigate to the Job screen ' +
        '(href/Link/router with job slug or /job path) — listing jobs without links is insufficient',
    );

    assert.ok(
      /crypto\.randomUUID|uuidv4|uuid\(|randomUUID/.test(src),
      'Run must send a caller-generated uuid id',
    );
    // POST .../jobs payload must include both task and id together
    assert.ok(
      /(?:task\s*:\s*[^,\n}]+[\s\S]{0,200}\bid\s*:|\bid\s*:\s*[^,\n}]+[\s\S]{0,200}\btask\s*:)/.test(
        src,
      ) ||
        /JSON\.stringify\s*\(\s*\{[^}]*\btask\b[^}]*\bid\b|JSON\.stringify\s*\(\s*\{[^}]*\bid\b[^}]*\btask\b/.test(
          src,
        ) ||
        /\{\s*task\s*,\s*id\s*\}|\{\s*id\s*,\s*task\s*\}/.test(src),
      'POST .../jobs body must include both task and caller uuid id together',
    );
    // No Continue control labeled for users (forbid Continue button/link text).
    assert.doesNotMatch(src, /<(button|a|Link)[^>]*>\s*[^<]*\bContinue\b/);
    assert.doesNotMatch(src, />\s*Continue\s*</);
  });

  it('lets the user choose default / SEQ / Fan out / Decompose before Run and POSTs mode with task+id', () => {
    const productSrc = exists(path.join(uiRoot, 'components', 'ProductScreen.tsx'))
      ? read(path.join(uiRoot, 'components', 'ProductScreen.tsx'))
      : allUiSourceText();
    const typesSrc = exists(path.join(uiRoot, 'lib', 'types.ts'))
      ? read(path.join(uiRoot, 'lib', 'types.ts'))
      : '';

    // Exclusive mode control on the Run form (before submit).
    assert.ok(
      /\bSEQ\b/.test(productSrc) && /Fan\s*out|fan-out|Fan-out/i.test(productSrc),
      'Product Run form must expose SEQ and Fan out choices',
    );
    assert.ok(
      /\bDecompose\b/.test(productSrc),
      'Product Run form must expose a Decompose choice beside Default / SEQ / Fan out',
    );
    assert.ok(
      /Default|Normal|Pipeline|standard/i.test(productSrc),
      'Product Run form must expose a default (neither SEQ, Fan out, nor Decompose) choice',
    );
    assert.ok(
      /type\s*=\s*['"]radio['"]|role\s*=\s*['"]radiogroup['"]|<select\b|mode/.test(productSrc),
      'mode choice must be an exclusive control (radio, select, or mode state)',
    );
    // Decompose must be a radio in the same exclusive group (value="decompose").
    assert.ok(
      /value\s*=\s*['"]decompose['"]/.test(productSrc) &&
        /type\s*=\s*['"]radio['"][\s\S]{0,200}value\s*=\s*['"]decompose['"]|value\s*=\s*['"]decompose['"][\s\S]{0,200}type\s*=\s*['"]radio['"]/.test(
          productSrc,
        ),
      'Decompose must be a radio with value="decompose" in the Run mode group',
    );

    // Run POST body must include mode alongside task and id.
    assert.ok(
      /\bmode\b/.test(productSrc) &&
        (
          /(?:task|id|mode)[\s\S]{0,220}(?:task|id|mode)[\s\S]{0,220}(?:task|id|mode)/.test(
            productSrc,
          ) ||
          /JSON\.stringify\s*\(\s*\{[^}]*(?:\btask\b|\bid\b|\bmode\b)[^}]*(?:\btask\b|\bid\b|\bmode\b)/.test(
            productSrc,
          ) ||
          /\{\s*task[\s\S]{0,80}id[\s\S]{0,80}mode|\{\s*task[\s\S]{0,80}mode[\s\S]{0,80}id/.test(
            productSrc,
          )
        ),
      'POST .../jobs body must include mode with task and caller uuid id',
    );
    assert.ok(
      /['"]seq['"]/.test(productSrc) &&
        /['"]fan-out['"]/.test(productSrc) &&
        /['"]decompose['"]/.test(productSrc),
      'mode values posted must include "seq", "fan-out", and "decompose"',
    );
    // runJob gate must POST mode when decompose is selected (same as seq/fan-out).
    assert.ok(
      /mode\s*===\s*['"]decompose['"]|mode\s*===\s*['"]seq['"][\s\S]{0,120}decompose|decompose[\s\S]{0,120}mode\s*===\s*['"]seq['"]/.test(
        productSrc,
      ),
      'runJob must set body.mode = "decompose" when the Decompose radio is selected',
    );

    // Types know about the request mode field (or Job.mode if surfaced).
    if (typesSrc) {
      assert.ok(
        /JobMode\s*=\s*['"]seq['"]\s*\|\s*['"]fan-out['"]\s*\|\s*['"]decompose['"]|'decompose'|"decompose"/.test(
          typesSrc,
        ) &&
          /'seq'|"seq"/.test(typesSrc) &&
          /fan-out/.test(typesSrc),
        "ui/lib/types.ts JobMode must include 'seq' | 'fan-out' | 'decompose'",
      );
    }
  });

  it('exposes a danger Clean jobs control that POSTs …/jobs/clean after confirm', () => {
    const productSrc = exists(path.join(uiRoot, 'components', 'ProductScreen.tsx'))
      ? read(path.join(uiRoot, 'components', 'ProductScreen.tsx'))
      : allUiSourceText();
    const src = allUiSourceText();

    assert.ok(
      />\s*Clean jobs\s*</.test(productSrc) || /['"`]Clean jobs['"`]/.test(productSrc),
      'Product screen must expose a user-facing “Clean jobs” control label',
    );

    assert.ok(
      /\/api\/products\/[^'"`\n]*\/jobs\/clean|\/jobs\/clean/.test(productSrc),
      'Clean jobs must POST /api/products/:product/jobs/clean',
    );
    assert.ok(
      /method\s*:\s*['"]POST['"]/.test(productSrc) &&
        /\/jobs\/clean/.test(productSrc),
      'Clean jobs must use POST (not DELETE) to …/jobs/clean',
    );

    assert.ok(
      /window\.confirm|confirm\s*\(/.test(productSrc),
      'Clean jobs must confirm with window.confirm before POST',
    );

    assert.ok(
      /className=\{?['"`][^'"`]*\bdanger\b|className=\{[^}]*danger|\.danger|['"`]danger['"`]/.test(
        productSrc,
      ),
      'Clean jobs control must use button.danger styling',
    );

    // Disabled when busy, loading, or no jobs (jobs.length === 0).
    assert.ok(
      /disabled=\{[^}]*(?:busy|loading|jobs\.length)/.test(productSrc) ||
        /disabled=\{[^}]*jobs\.length\s*===\s*0/.test(productSrc) ||
        (/\bbusy\b/.test(productSrc) &&
          /\bloading\b/.test(productSrc) &&
          /jobs\.length/.test(productSrc) &&
          /disabled=/.test(productSrc)),
      'Clean jobs must disable when busy, loading, or jobs.length === 0',
    );

    // Still no HTTP DELETE anywhere in the UI (bulk clean is POST).
    assert.doesNotMatch(src, /method\s*:\s*['"]DELETE['"]/);
    // No per-job delete control label on Job screen.
    const jobSrc = exists(path.join(uiRoot, 'components', 'JobScreen.tsx'))
      ? read(path.join(uiRoot, 'components', 'JobScreen.tsx'))
      : '';
    if (jobSrc) {
      assert.doesNotMatch(jobSrc, />\s*Delete\s*</);
      assert.doesNotMatch(jobSrc, /['"`]Delete job['"`]|['"`]Delete['"`]/);
    }
  });
});

describe('01-ui-app Job screen', () => {
  it('shows status, prUrl, logs, files, and pause/resume/stop', () => {
    const src = allUiSourceText();
    assert.match(src, /\/api\/jobs\//);
    assert.match(src, /\/logs/);
    assert.match(src, /\/files/);
    assert.match(src, /\/pause/);
    assert.match(src, /\/resume/);
    assert.match(src, /\/stop/);
    assert.ok(/prUrl|pr_url|pr-url/i.test(src), 'Job screen must surface prUrl');
    assert.ok(/\bstate\b/i.test(src), 'Job screen must surface job state');

    // Must poll or refresh GET /api/jobs/:slug for live state/prUrl.
    // Must NOT pass: logs-only EventSource/text/event-stream, bare Refresh label,
    // bare refetch(), or one-shot status + logs SSE.
    assert.ok(
      hasJobStatusPollOrRefresh(src),
      'Job screen must poll or refresh GET /api/jobs/:slug for state/prUrl ' +
        '(timer/refetchInterval/Refresh-onClick/status-SSE tied to the job status ' +
        'path — not /logs). Logs-only SSE, a bare Refresh label, or bare refetch() ' +
        'are insufficient',
    );

    // Files card must poll GET /api/jobs/:slug/files (not mount/Reload-only).
    assert.ok(
      hasJobFilesPollOrRefresh(src),
      'Job screen must poll or refresh GET /api/jobs/:slug/files on a timer ' +
        '(same interval as status/logs or equivalent) so the Files card updates ' +
        'without relying on manual Reload files',
    );

    // Pause / Resume / Stop must be user-facing control labels (not only /pause paths).
    assert.ok(
      />\s*Pause\s*</.test(src) || /['"`]Pause['"`]/.test(src),
      'Job screen must expose a user-facing Pause control label',
    );
    assert.ok(
      />\s*Resume\s*</.test(src) || /['"`]Resume['"`]/.test(src),
      'Job screen must expose a user-facing Resume control label',
    );
    assert.ok(
      />\s*Stop\s*</.test(src) || /['"`]Stop['"`]/.test(src),
      'Job screen must expose a user-facing Stop control label',
    );

    // Files list must read both path and status from each files[] entry.
    // Do NOT accept any object literal that merely contains `status` (e.g. job
    // `{ status: ... }` plus unrelated `file.path`) — require the same binding
    // (file.status / destructure { path, status }) or a map that uses both.
    const readsFilePath =
      /(?:file|f|entry|item|row)\s*\.\s*path\b/.test(src) ||
      /(?:file|f|entry|item|row)\s*\[\s*['"]path['"]\s*\]/.test(src);
    const readsFileStatus =
      /(?:file|f|entry|item|row)\s*\.\s*status\b/.test(src) ||
      /(?:file|f|entry|item|row)\s*\[\s*['"]status['"]\s*\]/.test(src);
    const destructuresPathAndStatus =
      /\{\s*path\s*,\s*status\s*\}|\{\s*status\s*,\s*path\s*\}/.test(src);
    const mapsFilesWithBoth =
      /files[\s\S]{0,300}(?:file|f|entry|item|row)\.(?:path|status)[\s\S]{0,200}\.(?:path|status)/.test(
        src,
      ) ||
      /\.map\s*\(\s*\(?\s*(?:file|f|entry|item|row)[^)]*\)?\s*=>[\s\S]{0,200}\.path[\s\S]{0,200}\.status/.test(
        src,
      ) ||
      /\.map\s*\(\s*\(?\s*(?:file|f|entry|item|row)[^)]*\)?\s*=>[\s\S]{0,200}\.status[\s\S]{0,200}\.path/.test(
        src,
      );
    assert.ok(
      (readsFilePath && readsFileStatus) || destructuresPathAndStatus || mapsFilesWithBoth,
      'Job files UI must read each entry’s path and status from ' +
        '{ files: [{ path, status }] } (e.g. file.path + file.status in a map) — ' +
        'file.path plus an unrelated { status } object is insufficient',
    );

    assert.doesNotMatch(src, /<(button|a|Link)[^>]*>\s*[^<]*\bContinue\b/);
    assert.doesNotMatch(src, />\s*Continue\s*</);
  });

  it('renders job.seq state + ordered units backlog when enrichment is present', () => {
    /**
     * Unit 05-ui-task-units: plan-only decompose leaves seq.json `state:planned`
     * with units; serve already attaches `job.seq` on GET /api/jobs/:slug.
     * JobScreen must surface that payload so the backlog stays visible on the
     * task detail screen. Display only — Start / POST …/start is out of scope.
     */
    const jobPath = path.join(uiRoot, 'components', 'JobScreen.tsx');
    assert.ok(exists(jobPath), 'expected ui/components/JobScreen.tsx');
    const jobSrc = read(jobPath);
    const typesSrc = exists(path.join(uiRoot, 'lib', 'types.ts'))
      ? read(path.join(uiRoot, 'lib', 'types.ts'))
      : '';

    // Gate on job.seq from the existing loadJob / GET payload (not a separate fetch).
    assert.ok(
      /job\?\.seq\b|job\.seq\b/.test(jobSrc),
      'JobScreen must read job.seq from the GET /api/jobs/:slug payload (loadJob state)',
    );

    // Document-level seq.state (badge or muted label).
    assert.ok(
      /seq\.state\b|job\.seq\.state\b|\.seq\.state\b/.test(jobSrc),
      'JobScreen must render job.seq.state (document-level planned|running|done|failed)',
    );

    // Ordered units list: map over seq.units (or job.seq.units).
    assert.ok(
      /(?:seq|job\.seq)\.units\b/.test(jobSrc) &&
        /\.map\s*\(/.test(jobSrc) &&
        /(?:seq|job\.seq)\.units[\s\S]{0,200}\.map\s*\(|\.units\.map\s*\(/.test(jobSrc),
      'JobScreen must map over job.seq.units in order for the backlog list',
    );

    // Per-unit enrichment fields from serve: id, title, subtask, state, slug|childSlug.
    assert.ok(
      /\.id\b/.test(jobSrc) && /\.title\b/.test(jobSrc),
      'seq unit rows must surface unit.id and unit.title',
    );
    assert.ok(
      /\.subtask\b/.test(jobSrc),
      'seq unit rows must surface unit.subtask',
    );
    assert.ok(
      /(?:unit|u|entry|row|item)\s*\.\s*state\b|units[\s\S]{0,400}\.state\b/.test(jobSrc),
      'seq unit rows must surface each unit.state (distinct from job.state / seq.state)',
    );
    assert.ok(
      /\.slug\b|\.childSlug\b/.test(jobSrc),
      'seq unit rows must surface child job id via unit.slug and/or unit.childSlug',
    );

    // Sidebar section-panel peer to Controls/Files (reuse chrome classes).
    assert.ok(
      /section-panel/.test(jobSrc),
      'seq backlog must live in a section-panel (peer to Controls/Files)',
    );
    assert.ok(
      /list-row|\bbadge\b|\bmono\b|\bmuted\b/.test(jobSrc),
      'seq backlog should reuse list-row / badge / mono / muted chrome classes',
    );

    // Omit the section when job.seq is absent (conditional render, no empty placeholder required).
    assert.ok(
      /job\?\.seq\b|job\.seq\s*&&|\{[^}]*job\.seq[^}]*&&|if\s*\(\s*job\?\.seq|if\s*\(\s*job\.seq/.test(
        jobSrc,
      ),
      'seq section must render only when job.seq is present (omit when enrichment absent)',
    );

    // Out of scope: do not wire Start / POST …/start on JobScreen.
    assert.doesNotMatch(
      jobSrc,
      /\/api\/jobs\/[^'"`\n]*\/start|\/start['"`]/,
      'JobScreen must not call POST /api/jobs/:slug/start in this unit',
    );
    assert.doesNotMatch(
      jobSrc,
      />\s*Start\s*(?:seq|backlog|job)?\s*</i,
      'JobScreen must not expose a Start control for the seq backlog in this unit',
    );

    // Optional typed Job.seq shape — pin when types declare it.
    if (
      /JobSeq|seq\??\s*:\s*|interface\s+\w*Seq|type\s+\w*Seq/.test(typesSrc) ||
      /units\s*:\s*/.test(typesSrc) && /childSlug|subtask/.test(typesSrc)
    ) {
      assert.ok(
        /state/.test(typesSrc) &&
          /units/.test(typesSrc) &&
          /id/.test(typesSrc) &&
          /title/.test(typesSrc) &&
          /subtask/.test(typesSrc) &&
          (/slug/.test(typesSrc) || /childSlug/.test(typesSrc)),
        'ui/lib/types.ts Job.seq / JobSeq must include state + units[] ' +
          '(id, title, subtask, state, slug|childSlug)',
      );
    }
  });
});

describe('01-ui-app mobile + packaging boundaries', () => {
  it('includes mobile viewport or responsive layout cues', () => {
    const layout = assertAppRouterLayout();
    const layoutSrc = read(layout);
    const cssAndSrc = `${layoutSrc}\n${allUiSourceText()}`;
    const hasViewport =
      /viewport/i.test(cssAndSrc) ||
      /width\s*=\s*device-width/i.test(cssAndSrc) ||
      /@media\b/.test(cssAndSrc) ||
      /max-width|min-width|clamp\(/i.test(cssAndSrc);
    assert.ok(hasViewport, 'expected viewport meta export and/or responsive CSS for phone viewports');
  });

  it('packages built UI and serves static export from lib/serve.js', () => {
    const rootPkg = readJson(path.join(root, 'package.json'));
    assert.ok(
      rootPkg.files.some((f) => String(f).includes('ui')),
      'root package.json files must include ui/out (or ui) for npm packaging',
    );

    const serveSrc = read(path.join(root, 'lib', 'serve.js'));
    assert.match(serveSrc, /ui\/out|staticDir/);
    assert.ok(
      /resolveStaticPath|sendStaticFile|contentTypeFor|DEFAULT_STATIC_DIR/.test(serveSrc),
      'lib/serve.js must deliver the static Next export for non-/api routes',
    );
  });

  it('built ui/out Job poll refreshes /files (not a stale export)', () => {
    const outDir = path.join(uiRoot, 'out');
    assert.ok(exists(outDir), 'expected ui/out static export (run npm run build in ui/)');

    const jsFiles = [];
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.js$/.test(ent.name)) jsFiles.push(full);
      }
    }
    walk(outDir);
    assert.ok(
      jsFiles.some((f) => /\/files/.test(read(f))),
      'ui/out must reference GET .../files',
    );

    // Per-chunk + any-same-named-body lookup (see pollIntervalInvokesFilesLoader).
    // First-match extractFnBody on concatenated outSrc false-fails after rebuild
    // when minified single-letter names collide (many function y(/g(/…).
    let pollsFiles = false;
    for (const file of jsFiles) {
      if (pollIntervalInvokesFilesLoader(read(file))) {
        pollsFiles = true;
        break;
      }
    }
    assert.ok(
      pollsFiles,
      'ui/out setInterval must call a loader that GETs /api/jobs/.../files ' +
        '(rebuild ui/ after adding loadFiles to the Job poll — source alone is not served)',
    );
  });

  it('ignores ui node_modules / build artifacts at repo or ui level', () => {
    const rootIgnore = exists(path.join(root, '.gitignore'))
      ? read(path.join(root, '.gitignore'))
      : '';
    const uiIgnore = exists(path.join(uiRoot, '.gitignore'))
      ? read(path.join(uiRoot, '.gitignore'))
      : '';
    const combined = `${rootIgnore}\n${uiIgnore}`;
    // Root already ignores node_modules/; accept that or ui-local ignore for .next/out.
    assert.match(combined, /node_modules/);
    assert.ok(
      /\.next\b/.test(combined) || /\bout\b/.test(combined) || /node_modules\//.test(rootIgnore),
      'expected ignore coverage for ui build artifacts (.next and/or out) or rely on root node_modules ignore with ui/.gitignore for .next/out',
    );
    // If only root node_modules is ignored, require ui/.gitignore to cover .next or out once ui exists.
    if (exists(uiRoot)) {
      assert.ok(
        /\.next\b/.test(combined) || /\bout\b/.test(combined),
        'ui/.gitignore (or root) must ignore .next and/or out build output',
      );
    }
  });
});
