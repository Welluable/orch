import fs from 'node:fs';
import path from 'node:path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';

const PRODUCT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LEN = 64;

function defaultExecFile(command, args, options = {}) {
    return nodeExecFileSync(command, args, { encoding: 'utf8', ...options });
}

function runGit(execFile, args, options = {}) {
    try {
        return execFile('git', args, options);
    } catch (err) {
        const detail = err.stderr || err.message;
        throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
}

function runGh(execFile, args, options = {}) {
    try {
        return execFile('gh', args, options);
    } catch (err) {
        const detail = err.stderr || err.message;
        throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
    }
}

export function isValidProductSlug(slug) {
    return typeof slug === 'string'
        && slug.length > 0
        && slug.length <= MAX_SLUG_LEN
        && PRODUCT_SLUG_RE.test(slug);
}

export function productDir(productsDir, slug) {
    return path.join(productsDir, slug);
}

export function productJsonPath(productsDir, slug) {
    return path.join(productDir(productsDir, slug), 'product.json');
}

export function readProduct(productsDir, slug) {
    const file = productJsonPath(productsDir, slug);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

export function writeProduct(productsDir, slug, record) {
    const dir = productDir(productsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(productJsonPath(productsDir, slug), `${JSON.stringify(record, null, 2)}\n`);
    return record;
}

export function listProducts(productsDir) {
    if (!fs.existsSync(productsDir)) return [];
    const products = [];
    for (const entry of fs.readdirSync(productsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const record = readProduct(productsDir, entry.name);
        if (record) products.push(record);
    }
    products.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
    return products;
}

export function productExists(productsDir, slug) {
    const dir = productDir(productsDir, slug);
    return fs.existsSync(dir);
}

function rmProductDirBestEffort(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }
}

export function githubHttpsUrl(owner, slug) {
    return `https://github.com/${owner}/${slug}.git`;
}

export function githubSshUrl(owner, slug) {
    return `git@github.com:${owner}/${slug}.git`;
}

/**
 * Parse owner / repo / provider from a git remote URL when possible.
 */
export function parseRemoteUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return { url: raw, provider: null, owner: null };

    let owner = null;
    let repo = null;
    let provider = null;

    const https = raw.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (https) {
        provider = /github/i.test(https[1]) ? 'github' : https[1];
        owner = https[2];
        repo = https[3];
    } else {
        const ssh = raw.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
        if (ssh) {
            provider = /github/i.test(ssh[1]) ? 'github' : ssh[1];
            owner = ssh[2];
            repo = ssh[3];
        }
    }

    return {
        url: raw,
        provider,
        owner,
        ...(repo ? { repo } : {}),
    };
}

export function resolveGithubOwner({ owner, githubOwner, execFile = defaultExecFile }) {
    const fromRequest = typeof owner === 'string' ? owner.trim() : '';
    if (fromRequest) return fromRequest;
    const fromServe = typeof githubOwner === 'string' ? githubOwner.trim() : '';
    if (fromServe) return fromServe;
    const login = String(runGh(execFile, ['api', 'user', '--jq', '.login'])).trim();
    if (!login) throw new Error('gh api user --jq .login failed: empty login');
    return login;
}

/**
 * Blank product: local git + private GitHub repo under resolved owner.
 */
export function initProduct({
    productsDir,
    slug,
    name,
    owner,
    githubOwner,
    execFile = defaultExecFile,
}) {
    const dir = productDir(productsDir, slug);
    if (productExists(productsDir, slug)) {
        const err = new Error(`product already exists: ${slug}`);
        err.statusCode = 409;
        throw err;
    }

    fs.mkdirSync(dir, { recursive: true });
    try {
        runGit(execFile, ['-C', dir, 'init', '-b', 'main']);
        runGit(execFile, ['-C', dir, 'commit', '--allow-empty', '-m', 'Initial commit']);

        const resolvedOwner = resolveGithubOwner({ owner, githubOwner, execFile });
        runGh(execFile, ['repo', 'create', `${resolvedOwner}/${slug}`, '--private']);

        const remoteUrl = githubSshUrl(resolvedOwner, slug);
        runGit(execFile, ['-C', dir, 'remote', 'add', 'origin', remoteUrl]);
        runGit(execFile, ['-C', dir, 'push', '-u', 'origin', 'main']);

        const record = {
            slug,
            name,
            createdAt: new Date().toISOString(),
            source: 'init',
            remote: {
                url: remoteUrl,
                provider: 'github',
                owner: resolvedOwner,
                visibility: 'private',
            },
        };
        writeProduct(productsDir, slug, record);
        return record;
    } catch (err) {
        rmProductDirBestEffort(dir);
        if (err.statusCode) throw err;
        const wrapped = new Error(err.message || 'product init failed');
        wrapped.statusCode = 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

function hasHeadCommit(execFile, dir) {
    try {
        runGit(execFile, ['-C', dir, 'rev-parse', '--verify', 'HEAD']);
        return true;
    } catch {
        return false;
    }
}

/**
 * Empty remote after clone: normalize onto main with upstream, matching init end-state.
 */
function healEmptyClone(execFile, dir) {
    try {
        runGit(execFile, ['-C', dir, 'checkout', '-B', 'main']);
    } catch {
        runGit(execFile, ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    if (!hasHeadCommit(execFile, dir)) {
        runGit(execFile, ['-C', dir, 'commit', '--allow-empty', '-m', 'Initial commit']);
    }
    runGit(execFile, ['-C', dir, 'push', '-u', 'origin', 'main']);
    runGit(execFile, ['-C', dir, 'remote', 'set-head', 'origin', 'main']);
}

/**
 * Clone an existing git URL into products/<slug>/.
 */
export function cloneProduct({
    productsDir,
    slug,
    name,
    url,
    execFile = defaultExecFile,
}) {
    const dir = productDir(productsDir, slug);
    if (productExists(productsDir, slug)) {
        const err = new Error(`product already exists: ${slug}`);
        err.statusCode = 409;
        throw err;
    }

    try {
        runGit(execFile, ['clone', url, dir]);
        if (!hasHeadCommit(execFile, dir)) {
            healEmptyClone(execFile, dir);
        } else {
            try {
                runGit(execFile, ['-C', dir, 'remote', 'set-head', 'origin', '--auto']);
            } catch {
                // optional: non-empty clones still succeed without origin/HEAD
            }
        }
        const parsed = parseRemoteUrl(url);
        const record = {
            slug,
            name,
            createdAt: new Date().toISOString(),
            source: 'clone',
            remote: {
                url: parsed.url || url,
                provider: parsed.provider ?? 'github',
                owner: parsed.owner,
                visibility: 'private',
            },
        };
        writeProduct(productsDir, slug, record);
        return record;
    } catch (err) {
        rmProductDirBestEffort(dir);
        if (err.statusCode) throw err;
        const wrapped = new Error(err.message || 'product clone failed');
        wrapped.statusCode = 502;
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * Merge PATCH fields into product.json; sync origin URL when remote.url changes.
 */
export function patchProduct({
    productsDir,
    slug,
    patch,
    execFile = defaultExecFile,
}) {
    const existing = readProduct(productsDir, slug);
    if (!existing) {
        const err = new Error('product not found');
        err.statusCode = 404;
        throw err;
    }

    const next = { ...existing };

    if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) {
            const err = new Error('name must be a non-empty string');
            err.statusCode = 400;
            throw err;
        }
        next.name = patch.name.trim();
    }

    if (patch.remote !== undefined) {
        if (patch.remote == null || typeof patch.remote !== 'object' || Array.isArray(patch.remote)) {
            const err = new Error('remote must be an object');
            err.statusCode = 400;
            throw err;
        }
        next.remote = { ...(existing.remote || {}), ...patch.remote };
        const newUrl = typeof patch.remote.url === 'string' ? patch.remote.url.trim() : '';
        const prevUrl = existing.remote?.url;
        if (newUrl && newUrl !== prevUrl) {
            next.remote.url = newUrl;
            const parsed = parseRemoteUrl(newUrl);
            if (parsed.owner && next.remote.owner == null) next.remote.owner = parsed.owner;
            if (parsed.provider && next.remote.provider == null) next.remote.provider = parsed.provider;
            const dir = productDir(productsDir, slug);
            if (fs.existsSync(path.join(dir, '.git'))) {
                runGit(execFile, ['-C', dir, 'remote', 'set-url', 'origin', newUrl]);
            }
        }
    }

    if (patch.defaults !== undefined) {
        if (patch.defaults == null || typeof patch.defaults !== 'object' || Array.isArray(patch.defaults)) {
            const err = new Error('defaults must be an object');
            err.statusCode = 400;
            throw err;
        }
        next.defaults = { ...(existing.defaults || {}), ...patch.defaults };
    }

    writeProduct(productsDir, slug, next);
    return next;
}
