import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync as realExecFileSync } from 'node:child_process';
import { allocateJob } from './job-lifecycle.js';
import {
    cleanJobs,
    jobPaths,
    listJobs,
    readJob,
    requestPause,
    requestResume,
    stopJob,
    isPidAlive,
} from './jobs.js';
import {
    cloneProduct,
    initProduct,
    isValidProductSlug,
    listProducts,
    patchProduct,
    readProduct,
} from './products.js';

const MAX_JSON_BYTES = 64 * 1024;
const LIVE_STATES = new Set(['starting', 'running', 'pausing', 'paused']);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATIC_DIR = path.join(PACKAGE_ROOT, 'ui', 'out');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Resolve a URL pathname to a file under staticRoot, or null.
 * Blocks path traversal. Tries trailingSlash index.html and bare `.html`.
 */
function resolveStaticPath(staticRoot, pathname) {
    if (!staticRoot) return null;
    let root;
    try {
        root = fs.realpathSync(staticRoot);
    } catch {
        return null;
    }
    if (!fs.statSync(root).isDirectory()) return null;

    let decoded;
    try {
        decoded = decodeURIComponent(pathname || '/');
    } catch {
        return null;
    }
    if (!decoded.startsWith('/')) decoded = `/${decoded}`;

    const candidates = [];
    if (decoded === '/' || decoded === '') {
        candidates.push('index.html');
    } else {
        const trimmed = decoded.replace(/^\/+/, '');
        candidates.push(trimmed);
        if (trimmed.endsWith('/')) {
            candidates.push(`${trimmed}index.html`);
        } else if (!path.extname(trimmed)) {
            candidates.push(`${trimmed}.html`);
            candidates.push(`${trimmed}/index.html`);
        }
    }

    for (const rel of candidates) {
        const abs = path.resolve(root, rel);
        if (abs !== root && !abs.startsWith(root + path.sep)) continue;
        try {
            if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
        } catch {
            // ignore
        }
    }
    return null;
}

function sendStaticFile(res, filePath) {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
        'content-type': contentTypeFor(filePath),
        'content-length': body.length,
    });
    res.end(body);
}

const AGENT_BINARIES = {
    cursor: 'agent',
    claude: 'claude',
    agn: 'agn',
    opencode: 'opencode',
};

function defaultIsBinaryOnPath(binary) {
    try {
        realExecFileSync('which', [binary], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function discoverLanIp() {
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
        if (!entries) continue;
        for (const entry of entries) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return null;
}

function ensureWritableOrch(home) {
    const orchDir = path.join(home, '.orch');
    const products = path.join(orchDir, 'products');
    try {
        fs.mkdirSync(products, { recursive: true });
        const probe = path.join(orchDir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
    } catch (err) {
        const wrapped = new Error(`$HOME/.orch is not writable: ${err.message}`);
        wrapped.cause = err;
        throw wrapped;
    }
    return products;
}

function ensureGhAuth({ isBinaryOnPath, execFileSync }) {
    if (!isBinaryOnPath('gh')) {
        throw new Error('gh not found on PATH; install the GitHub CLI to run orch serve');
    }
    try {
        execFileSync('gh', ['auth', 'status'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        const detail = String(err.stderr || err.message || '').trim();
        throw new Error(
            detail
                ? `gh is not authenticated: ${detail}`
                : 'gh is not authenticated; run gh auth login',
        );
    }
}

function ensureAgentOnPath(agent, isBinaryOnPath) {
    const binary = AGENT_BINARIES[agent];
    if (!binary) {
        throw new Error(`Unknown agent backend: ${agent}`);
    }
    if (!isBinaryOnPath(binary)) {
        throw new Error(
            `default agent binary "${binary}" not found on PATH (agent=${agent})`,
        );
    }
}

/**
 * Build the Next.js static export into ui/out when it is missing.
 * Only applies to the package default static dir (not injected staticDir).
 */
function ensureDefaultStaticUi({ execFileSync, log, warn }) {
    if (fs.existsSync(DEFAULT_STATIC_DIR)) return;

    const uiDir = path.join(PACKAGE_ROOT, 'ui');
    const uiPkg = path.join(uiDir, 'package.json');
    if (!fs.existsSync(uiPkg)) {
        warn(
            `orch serve: static UI not found at ${DEFAULT_STATIC_DIR} ` +
            '(build with `cd ui && npm run build`); /api still works',
        );
        return;
    }

    try {
        if (!fs.existsSync(path.join(uiDir, 'node_modules'))) {
            log('orch serve: installing UI dependencies…');
            execFileSync('npm', ['install'], {
                cwd: uiDir,
                encoding: 'utf8',
                stdio: 'inherit',
            });
        }
        log('orch serve: building static UI…');
        execFileSync('npm', ['run', 'build'], {
            cwd: uiDir,
            encoding: 'utf8',
            stdio: 'inherit',
        });
    } catch (err) {
        warn(
            `orch serve: UI build failed (${err.message}); ` +
            `build with \`cd ui && npm run build\`; /api still works`,
        );
        return;
    }

    if (!fs.existsSync(DEFAULT_STATIC_DIR)) {
        warn(
            `orch serve: static UI not found at ${DEFAULT_STATIC_DIR} after build; /api still works`,
        );
    }
}

function listProductDirs(productsDir) {
    if (!fs.existsSync(productsDir)) return [];
    return fs.readdirSync(productsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => readProduct(productsDir, e.name))
        .map((e) => ({ slug: e.name, cwd: path.join(productsDir, e.name) }));
}

/** Parse `git status --porcelain` lines into `{ path, status }`. */
function parsePorcelainLine(line) {
    const raw = String(line ?? '').trimEnd();
    if (!raw || raw.length < 3) return null;
    // Rename/copy: "R  old -> new" / "C  old -> new" (score digits optional in XY).
    const rename = raw.match(/^(.{2}) (.+) -> (.+)$/);
    if (rename) {
        const status = rename[1].trim() || rename[1];
        const filePath = rename[3].trim().replace(/^"(.*)"$/, '$1');
        if (!filePath) return null;
        return { path: filePath, status: status.trim() || status };
    }
    const status = raw.slice(0, 2);
    const filePath = raw.slice(3).trim().replace(/^"(.*)"$/, '$1');
    if (!filePath) return null;
    // Prefer a compact status the UI can badge (e.g. "M", "??", "A").
    const compact = status.trim() || status;
    return { path: filePath, status: compact };
}

/** Parse `git diff --name-status` lines into `{ path, status }`. */
function parseNameStatusLine(line) {
    const raw = String(line ?? '').trimEnd();
    if (!raw) return null;
    const tab = raw.indexOf('\t');
    if (tab === -1) return null;
    const status = raw.slice(0, tab).trim();
    const rest = raw.slice(tab + 1);
    // Renames/copies: status\told\tnew — prefer the new path.
    const parts = rest.split('\t');
    const filePath = (parts[parts.length - 1] || '').trim();
    if (!status || !filePath) return null;
    return { path: filePath, status };
}

/**
 * Read-only file list for a job worktree: current dirty/untracked (porcelain)
 * union files committed since `base` (when present). Never stages.
 */
function listJobFiles(worktree, execFile, { base, branch } = {}) {
    if (!worktree || typeof worktree !== 'string') return [];
    if (!fs.existsSync(worktree)) return [];

    const byPath = new Map();

    const merge = (entries) => {
        for (const entry of entries) {
            if (!entry?.path || !entry?.status) continue;
            const prev = byPath.get(entry.path);
            // Dirty/untracked wins; otherwise fill gaps from committed-since-base.
            if (!prev || entry._dirty) {
                byPath.set(entry.path, entry);
            }
        }
    };

    try {
        const porcelain = execFile(
            'git',
            ['-C', worktree, 'status', '--porcelain'],
            { encoding: 'utf8' },
        );
        merge(
            String(porcelain ?? '')
                .split('\n')
                .map(parsePorcelainLine)
                .filter(Boolean)
                .map((e) => ({ ...e, _dirty: true })),
        );
    } catch {
        // Fall through — may still have committed-since-base.
    }

    const baseRef = typeof base === 'string' && base.trim() ? base.trim() : null;
    if (baseRef) {
        const tip =
            typeof branch === 'string' && branch.trim() ? branch.trim() : 'HEAD';
        // Two-dot range matches fanout `recordChangedFiles`; include base in args
        // so callers/tests can detect the committed-since-base query.
        const range = `${baseRef}..${tip}`;
        try {
            const out = execFile(
                'git',
                ['-C', worktree, 'diff', '--name-status', range],
                { encoding: 'utf8' },
            );
            merge(
                String(out ?? '')
                    .split('\n')
                    .map(parseNameStatusLine)
                    .filter(Boolean)
                    .map((e) => ({ ...e, _dirty: false })),
            );
        } catch {
            // Ignore range failures (missing base, etc.).
        }
    }

    return [...byPath.values()].map(({ path: filePath, status }) => ({
        path: filePath,
        status,
    }));
}

/** Read all product jobs without reconcile (queue must not crash fake/test pids). */
function scanAllJobsRaw(productsDir) {
    const jobs = [];
    for (const { slug: product, cwd } of listProductDirs(productsDir)) {
        const orchDir = path.join(cwd, '.orch');
        if (!fs.existsSync(orchDir)) continue;
        for (const entry of fs.readdirSync(orchDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const job = readJob(cwd, entry.name);
            if (!job) continue;
            jobs.push({ ...job, slug: job.slug ?? entry.name, product: job.product ?? product });
        }
    }
    jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return jobs;
}

/** API listing: reconcile dead pids so operators see crashed runs. */
function scanAllJobs(productsDir) {
    const jobs = [];
    for (const { slug: product, cwd } of listProductDirs(productsDir)) {
        for (const job of listJobs(cwd)) {
            jobs.push({ ...job, product: job.product ?? product });
        }
    }
    jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return jobs;
}

function findJob(productsDir, slug) {
    for (const { slug: product, cwd } of listProductDirs(productsDir)) {
        const job = readJob(cwd, slug);
        if (job) return { job: { ...job, product: job.product ?? product }, cwd, product };
    }
    return null;
}

function findJobBySourceId(productCwd, sourceId) {
    if (!sourceId) return null;
    const orchDir = path.join(path.resolve(productCwd), '.orch');
    if (!fs.existsSync(orchDir)) return null;
    for (const entry of fs.readdirSync(orchDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const job = readJob(productCwd, entry.name);
        if (job?.source?.id === sourceId) return job;
    }
    return null;
}

function countQueued(productsDir) {
    let n = 0;
    for (const job of scanAllJobsRaw(productsDir)) {
        if (job.state === 'queued') n += 1;
    }
    return n;
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req, { maxBytes = MAX_JSON_BYTES } = {}) {
    return new Promise((resolve, reject) => {
        const cl = req.headers['content-length'];
        if (cl != null && Number(cl) > maxBytes) {
            const err = new Error('Payload Too Large');
            err.statusCode = 413;
            reject(err);
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                const err = new Error('Payload Too Large');
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function remoteAddrOf(req) {
    const addr = req.socket?.remoteAddress || '';
    if (addr.startsWith('::ffff:')) return addr.slice(7);
    return addr || 'unknown';
}

/**
 * Start the orch serve HTTP process (jobs queue + products API + static UI).
 *
 * @returns {Promise<{ server, port, host, requestedHost, productsDir, staticDir, close }>}
 */
export async function startServe(options = {}) {
    const homedir = options.homedir ?? os.homedir;
    const home = typeof homedir === 'function' ? homedir() : homedir;
    const requestedHost = options.host ?? '0.0.0.0';
    const listenHost = requestedHost;
    const port = options.port ?? 7333;
    const concurrency = options.concurrency ?? 2;
    const maxQueue = options.maxQueue ?? 64;
    const defaultAgent = options.agent ?? 'cursor';
    const defaultMaxRounds = options.maxRounds ?? 5;
    const base = options.base;
    const githubOwner = options.githubOwner;
    const runDetached = options.runDetached;
    if (typeof runDetached !== 'function') {
        throw new Error('startServe requires options.runDetached');
    }
    const isBinaryOnPath = options.isBinaryOnPath ?? defaultIsBinaryOnPath;
    const execFileSync = options.execFileSync ?? realExecFileSync;
    const execFile = options.execFile
        ?? ((command, args, opts = {}) => execFileSync(command, args, { encoding: 'utf8', ...opts }));
    const log = options.log ?? ((msg) => console.log(msg));
    const warn = options.warn ?? ((msg) => console.warn(msg));
    const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;

    const productsDir = ensureWritableOrch(home);
    ensureGhAuth({ isBinaryOnPath, execFileSync });
    ensureAgentOnPath(defaultAgent, isBinaryOnPath);

    if (!fs.existsSync(staticDir)) {
        const isDefaultStatic =
            path.resolve(staticDir) === path.resolve(DEFAULT_STATIC_DIR);
        if (isDefaultStatic) {
            ensureDefaultStaticUi({ execFileSync, log, warn });
        } else {
            warn(
                `orch serve: static UI not found at ${staticDir} ` +
                '(build with `cd ui && npm run build`); /api still works',
            );
        }
    }

    /** @type {Set<string>} slugs currently inside runDetached */
    const startingSlugs = new Set();
    let tickScheduled = false;
    let closed = false;

    function countActive() {
        const live = new Set();
        for (const job of scanAllJobsRaw(productsDir)) {
            if (!LIVE_STATES.has(job.state)) continue;
            if (isPidAlive(job.pid)) live.add(job.slug);
        }
        for (const slug of startingSlugs) live.add(slug);
        return live.size;
    }

    async function startOne(job) {
        const key = job.slug;
        startingSlugs.add(key);
        try {
            const detachOpts = {
                agent: job.agent,
                maxRounds: job.maxRounds,
                cwd: job.cwd,
                pr: true,
                base: job.base ?? base,
                jobSlug: job.slug,
                exit: () => {},
            };
            if (job.mode === 'seq') detachOpts.seq = true;
            else if (job.mode === 'fan-out') detachOpts.fanOut = true;
            await runDetached(job.task, detachOpts);
        } catch (err) {
            warn(`serve: failed to start job ${job.slug}: ${err.message}`);
        } finally {
            startingSlugs.delete(key);
            scheduleTick();
        }
    }

    function scheduleTick() {
        if (closed || tickScheduled) return;
        tickScheduled = true;
        setImmediate(() => {
            tickScheduled = false;
            void tick();
        });
    }

    async function tick() {
        if (closed) return;
        while (countActive() < concurrency) {
            const queued = scanAllJobsRaw(productsDir)
                .filter((j) => j.state === 'queued')
                .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
            const next = queued.find((j) => !startingSlugs.has(j.slug));
            if (!next) break;
            const product = next.product;
            const cwd = path.join(productsDir, product);
            // startOne claims `startingSlugs` synchronously before its first await.
            void startOne({
                slug: next.slug,
                task: next.task,
                agent: next.agent ?? defaultAgent,
                maxRounds: next.maxRounds ?? defaultMaxRounds,
                cwd,
                base: next.base,
                mode: next.mode,
            });
        }
    }

    // Boot recovery: durable queued jobs are already on disk; just tick.
    // Crashed / terminal jobs are left alone (no auto-retry).
    scheduleTick();

    if (!isLoopbackHost(requestedHost)) {
        warn(
            'orch serve is binding a non-loopback address with no auth — ' +
            'anyone who can reach this port can start jobs and run agents',
        );
    }

    async function handle(req, res) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const { pathname } = url;
        const method = req.method || 'GET';

        try {
            if (method === 'GET' && pathname === '/api/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (method === 'GET' && pathname === '/api/jobs') {
                sendJson(res, 200, { jobs: scanAllJobs(productsDir) });
                return;
            }

            {
                const m = pathname.match(/^\/api\/jobs\/([^/]+)$/);
                if (method === 'GET' && m) {
                    const found = findJob(productsDir, decodeURIComponent(m[1]));
                    if (!found) {
                        sendJson(res, 404, { error: 'job not found' });
                        return;
                    }
                    sendJson(res, 200, { job: found.job });
                    return;
                }
            }

            {
                const m = pathname.match(/^\/api\/jobs\/([^/]+)\/logs$/);
                if (method === 'GET' && m) {
                    const slug = decodeURIComponent(m[1]);
                    const found = findJob(productsDir, slug);
                    if (!found) {
                        sendJson(res, 404, { error: 'job not found' });
                        return;
                    }
                    const { logPath } = jobPaths(found.cwd, slug);
                    const body = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
                    const accept = req.headers.accept || '';
                    if (accept.includes('text/event-stream')) {
                        res.writeHead(200, {
                            'content-type': 'text/event-stream; charset=utf-8',
                            'cache-control': 'no-cache',
                            connection: 'keep-alive',
                        });
                        for (const line of body.split('\n')) {
                            res.write(`data: ${line}\n\n`);
                        }
                        res.end();
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                    res.end(body);
                    return;
                }
            }

            {
                const m = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|stop)$/);
                if (method === 'POST' && m) {
                    const slug = decodeURIComponent(m[1]);
                    const action = m[2];
                    const found = findJob(productsDir, slug);
                    if (!found) {
                        sendJson(res, 404, { error: 'job not found' });
                        return;
                    }
                    if (action === 'pause') {
                        const record = requestPause(found.cwd, slug);
                        sendJson(res, 200, { ok: true, job: record });
                        return;
                    }
                    if (action === 'resume') {
                        const record = requestResume(found.cwd, slug);
                        sendJson(res, 200, { ok: true, job: record });
                        return;
                    }
                    const result = stopJob(found.cwd, slug);
                    sendJson(res, 200, { ok: true, action: result.action, job: result.record });
                    return;
                }
            }

            {
                const m = pathname.match(/^\/api\/products\/([^/]+)\/jobs\/clean$/);
                if (method === 'POST' && m) {
                    const product = decodeURIComponent(m[1]);
                    const productCwd = path.join(productsDir, product);
                    if (!fs.existsSync(productCwd) || !fs.statSync(productCwd).isDirectory()) {
                        sendJson(res, 404, { error: 'product not found' });
                        return;
                    }
                    try {
                        const removed = cleanJobs(productCwd);
                        sendJson(res, 200, { ok: true, removed });
                    } catch (err) {
                        sendJson(res, 409, { error: err.message || String(err) });
                    }
                    return;
                }
            }

            {
                const m = pathname.match(/^\/api\/products\/([^/]+)\/jobs$/);
                if (m && method === 'GET') {
                    const product = decodeURIComponent(m[1]);
                    if (!readProduct(productsDir, product)) {
                        sendJson(res, 404, { error: 'product not found' });
                        return;
                    }
                    const jobs = scanAllJobs(productsDir)
                        .filter((j) => j.product === product);
                    sendJson(res, 200, { jobs });
                    return;
                }
                if (method === 'POST' && m) {
                    const product = decodeURIComponent(m[1]);
                    const productCwd = path.join(productsDir, product);
                    if (!fs.existsSync(productCwd) || !fs.statSync(productCwd).isDirectory()) {
                        sendJson(res, 404, { error: 'product not found' });
                        return;
                    }

                    let raw;
                    try {
                        raw = await readBody(req);
                    } catch (err) {
                        if (err.statusCode === 413) {
                            sendJson(res, 413, { error: 'payload too large' });
                            return;
                        }
                        throw err;
                    }

                    let body;
                    try {
                        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
                    } catch {
                        sendJson(res, 400, { error: 'invalid JSON' });
                        return;
                    }

                    const task = typeof body.task === 'string' ? body.task.trim() : '';
                    const id = typeof body.id === 'string' ? body.id : '';
                    if (!task || !id) {
                        sendJson(res, 400, { error: 'task and id are required' });
                        return;
                    }

                    const hasSeqBool = body.seq === true;
                    const hasFanOutBool = body.fanOut === true;
                    if (hasSeqBool && hasFanOutBool) {
                        sendJson(res, 400, { error: 'seq and fanOut cannot both be set' });
                        return;
                    }

                    let mode;
                    if (Object.prototype.hasOwnProperty.call(body, 'mode') && body.mode != null && body.mode !== '') {
                        if (body.mode !== 'seq' && body.mode !== 'fan-out') {
                            sendJson(res, 400, { error: 'mode must be seq or fan-out' });
                            return;
                        }
                        mode = body.mode;
                    } else if (hasSeqBool) {
                        mode = 'seq';
                    } else if (hasFanOutBool) {
                        mode = 'fan-out';
                    }

                    if (mode === 'seq' && hasFanOutBool) {
                        sendJson(res, 400, { error: 'seq and fanOut cannot both be set' });
                        return;
                    }
                    if (mode === 'fan-out' && hasSeqBool) {
                        sendJson(res, 400, { error: 'seq and fanOut cannot both be set' });
                        return;
                    }

                    const existing = findJobBySourceId(productCwd, id);
                    if (existing) {
                        sendJson(res, 200, { slug: existing.slug, job: existing });
                        return;
                    }

                    if (countQueued(productsDir) >= maxQueue) {
                        sendJson(res, 503, { error: 'queue full' });
                        return;
                    }

                    const agent = body.agent ?? defaultAgent;
                    const maxRounds = body.maxRounds ?? defaultMaxRounds;
                    const source = {
                        kind: 'http',
                        id,
                        remoteAddr: remoteAddrOf(req),
                        receivedAt: new Date().toISOString(),
                    };
                    const allocOpts = {
                        cwd: productCwd,
                        prompt: task,
                        agent,
                        maxRounds,
                        state: 'queued',
                        product,
                        source,
                    };
                    if (mode) allocOpts.mode = mode;
                    const { slug, record } = allocateJob(allocOpts);
                    scheduleTick();
                    sendJson(res, 202, { slug, job: record });
                    return;
                }
            }

            if (method === 'GET' && pathname === '/api/products') {
                sendJson(res, 200, { products: listProducts(productsDir) });
                return;
            }

            if (method === 'POST' && pathname === '/api/products') {
                let raw;
                try {
                    raw = await readBody(req);
                } catch (err) {
                    if (err.statusCode === 413) {
                        sendJson(res, 413, { error: 'payload too large' });
                        return;
                    }
                    throw err;
                }

                let body;
                try {
                    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
                } catch {
                    sendJson(res, 400, { error: 'invalid JSON' });
                    return;
                }

                const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
                const name = typeof body.name === 'string' ? body.name.trim() : '';
                const source = typeof body.source === 'string' ? body.source.trim() : '';
                if (!slug || !isValidProductSlug(slug)) {
                    sendJson(res, 400, { error: 'invalid or missing slug' });
                    return;
                }
                if (!name) {
                    sendJson(res, 400, { error: 'name is required' });
                    return;
                }
                if (source !== 'init' && source !== 'clone') {
                    sendJson(res, 400, { error: 'source must be init or clone' });
                    return;
                }

                try {
                    if (source === 'init') {
                        const product = initProduct({
                            productsDir,
                            slug,
                            name,
                            owner: body.owner,
                            githubOwner,
                            execFile,
                        });
                        sendJson(res, 201, { product });
                        return;
                    }

                    const url = typeof body.url === 'string' ? body.url.trim() : '';
                    if (!url) {
                        sendJson(res, 400, { error: 'url is required for clone' });
                        return;
                    }
                    const product = cloneProduct({
                        productsDir,
                        slug,
                        name,
                        url,
                        execFile,
                    });
                    sendJson(res, 201, { product });
                    return;
                } catch (err) {
                    const status = err.statusCode || 502;
                    sendJson(res, status, { error: err.message || 'product create failed' });
                    return;
                }
            }

            {
                const m = pathname.match(/^\/api\/products\/([^/]+)$/);
                if (m) {
                    const productSlug = decodeURIComponent(m[1]);

                    if (method === 'GET') {
                        const product = readProduct(productsDir, productSlug);
                        if (!product) {
                            sendJson(res, 404, { error: 'product not found' });
                            return;
                        }
                        const jobs = scanAllJobs(productsDir)
                            .filter((j) => j.product === productSlug)
                            .slice(0, 20);
                        sendJson(res, 200, { product, jobs });
                        return;
                    }

                    if (method === 'PATCH') {
                        let raw;
                        try {
                            raw = await readBody(req);
                        } catch (err) {
                            if (err.statusCode === 413) {
                                sendJson(res, 413, { error: 'payload too large' });
                                return;
                            }
                            throw err;
                        }

                        let body;
                        try {
                            body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
                        } catch {
                            sendJson(res, 400, { error: 'invalid JSON' });
                            return;
                        }

                        try {
                            const product = patchProduct({
                                productsDir,
                                slug: productSlug,
                                patch: body,
                                execFile,
                            });
                            sendJson(res, 200, { product });
                            return;
                        } catch (err) {
                            const status = err.statusCode || 500;
                            sendJson(res, status, { error: err.message || 'product patch failed' });
                            return;
                        }
                    }
                }
            }

            {
                const m = pathname.match(/^\/api\/jobs\/([^/]+)\/files$/);
                if (method === 'GET' && m) {
                    const slug = decodeURIComponent(m[1]);
                    const found = findJob(productsDir, slug);
                    if (!found) {
                        sendJson(res, 200, { files: [] });
                        return;
                    }
                    const files = listJobFiles(found.job.worktree, execFile, {
                        base: found.job.base,
                        branch: found.job.branch,
                    });
                    sendJson(res, 200, { files });
                    return;
                }
            }

            if (pathname.startsWith('/api/') || pathname === '/api') {
                sendJson(res, 404, { error: 'not found' });
                return;
            }

            // Next.js static export (ui/out) for non-API routes.
            if (method === 'GET' || method === 'HEAD') {
                const filePath = resolveStaticPath(staticDir, pathname);
                if (filePath) {
                    if (method === 'HEAD') {
                        const st = fs.statSync(filePath);
                        res.writeHead(200, {
                            'content-type': contentTypeFor(filePath),
                            'content-length': st.size,
                        });
                        res.end();
                        return;
                    }
                    sendStaticFile(res, filePath);
                    return;
                }
                // Client-side query routing lives on `/`; missing assets → 404 HTML/JSON-free.
                sendJson(res, 404, { error: 'not found' });
                return;
            }

            sendJson(res, 404, { error: 'not found' });
        } catch (err) {
            warn(`serve: request error: ${err.message}`);
            if (!res.headersSent) {
                sendJson(res, 500, { error: err.message || 'internal error' });
            }
        }
    }

    const server = http.createServer((req, res) => {
        void handle(req, res);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, listenHost, () => resolve());
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    const boundHost = typeof address === 'object' && address ? address.address : listenHost;

    log(`orch serve listening on http://127.0.0.1:${boundPort}/`);
    const lan = discoverLanIp();
    if (lan) {
        log(`orch serve LAN URL: http://${lan}:${boundPort}/`);
    }

    async function close() {
        closed = true;
        startingSlugs.clear();
        await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
        // Intentionally do not signal child pids.
    }

    return {
        server,
        port: boundPort,
        host: boundHost,
        requestedHost,
        productsDir,
        staticDir,
        close,
    };
}
