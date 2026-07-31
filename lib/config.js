import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_AGENTS = new Set(['cursor', 'claude', 'agn', 'opencode']);

/** Absolute path to the global orch config file. */
export function globalConfigPath({ homedir = os.homedir() } = {}) {
    return path.join(homedir, '.orch', 'config');
}

/** Absolute path to the project-local orch config file under `cwd`. */
export function localConfigPath(cwd) {
    return path.join(cwd, '.orch', 'config');
}

/**
 * Read a config file. Missing file → `{}`. Bad JSON, unreadable file, or
 * invalid `agent` / `notify` → throws with a message suitable for `Error: …`
 * on stderr. Unknown keys are ignored; `agent` is case-sensitive.
 */
export function loadConfig(configPath, displayPath = configPath) {
    if (!fs.existsSync(configPath)) return {};

    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
        throw new Error(`could not parse ${displayPath}: ${err.message}`);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        throw new Error(`could not parse ${displayPath}: ${err.message}`);
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`could not parse ${displayPath}: expected a JSON object`);
    }

    const out = {};

    if (Object.prototype.hasOwnProperty.call(data, 'agent') && data.agent !== undefined) {
        if (!VALID_AGENTS.has(data.agent)) {
            throw new Error(
                `invalid agent in ${displayPath}: ${JSON.stringify(data.agent)} (expected "cursor", "claude", "agn", or "opencode")`,
            );
        }
        out.agent = data.agent;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'notify') && data.notify !== undefined) {
        if (typeof data.notify !== 'boolean') {
            throw new Error(
                `invalid notify in ${displayPath}: ${JSON.stringify(data.notify)} (expected true or false)`,
            );
        }
        out.notify = data.notify;
    }

    return out;
}

/**
 * Effective agent for a run: `--agent` > local > global > `cursor`.
 * Reads local then global when `cliAgent` is omitted; throws on bad files.
 */
export function resolveAgent({ cliAgent, cwd, homedir = os.homedir() } = {}) {
    if (cliAgent) return cliAgent;

    const local = loadConfig(localConfigPath(cwd), '.orch/config');
    if (local.agent) return local.agent;

    const global = loadConfig(globalConfigPath({ homedir }), '~/.orch/config');
    if (global.agent) return global.agent;

    return 'cursor';
}

/**
 * Effective notify for a run: CLI > local > global > `true`.
 * `cliNotify` is `true` | `false` | `undefined` (flag omitted).
 */
export function resolveNotify({ cliNotify, cwd, homedir = os.homedir() } = {}) {
    if (cliNotify === true || cliNotify === false) return cliNotify;

    const local = loadConfig(localConfigPath(cwd), '.orch/config');
    if (typeof local.notify === 'boolean') return local.notify;

    const global = loadConfig(globalConfigPath({ homedir }), '~/.orch/config');
    if (typeof global.notify === 'boolean') return global.notify;

    return true;
}

/**
 * Create parent dirs if needed, merge `agent` / `notify` into the existing
 * config object (preserve the other key), overwrite with pretty-printed JSON,
 * return the path written.
 */
export function writeConfig(configPath, { agent, notify } = {}) {
    if (agent !== undefined && !VALID_AGENTS.has(agent)) {
        throw new Error(
            `invalid agent: ${JSON.stringify(agent)} (expected "cursor", "claude", "agn", or "opencode")`,
        );
    }
    if (notify !== undefined && typeof notify !== 'boolean') {
        throw new Error(
            `invalid notify: ${JSON.stringify(notify)} (expected true or false)`,
        );
    }

    let existing = {};
    if (fs.existsSync(configPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                existing = raw;
            }
        } catch {
            // Corrupt file: start fresh; caller already validated inputs.
            existing = {};
        }
    }

    const next = { ...existing };
    if (agent !== undefined) next.agent = agent;
    if (notify !== undefined) next.notify = notify;

    // Persist only known keys (drop unknown junk from a prior merge? Spec says
    // unknown keys are ignored on load but does not require stripping on write.
    // Keep agent/notify; preserve other keys already present.)
    const out = {};
    if (next.agent !== undefined) out.agent = next.agent;
    if (next.notify !== undefined) out.notify = next.notify;
    for (const [k, v] of Object.entries(next)) {
        if (k === 'agent' || k === 'notify') continue;
        out[k] = v;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(out, null, 2)}\n`);
    return configPath;
}

/**
 * Print effective agent/notify and which file(s) contributed (stdout). Throws
 * on invalid existing files — same fail-fast contract as a run.
 */
export function printConfig({
    cwd,
    homedir = os.homedir(),
    log = console.log,
} = {}) {
    const localPath = localConfigPath(cwd);
    const globalPath = globalConfigPath({ homedir });
    const local = loadConfig(localPath, '.orch/config');
    const global = loadConfig(globalPath, '~/.orch/config');

    let agent = 'cursor';
    let source = 'default (builtin)';
    if (local.agent) {
        agent = local.agent;
        source = `local (${localPath})`;
    } else if (global.agent) {
        agent = global.agent;
        source = `global (${globalPath})`;
    }

    let notify = true;
    let notifySource = 'default (builtin)';
    if (typeof local.notify === 'boolean') {
        notify = local.notify;
        notifySource = `local (${localPath})`;
    } else if (typeof global.notify === 'boolean') {
        notify = global.notify;
        notifySource = `global (${globalPath})`;
    }

    log(`agent=${agent}`);
    log(`source=${source}`);
    log(`global=${global.agent ?? 'unset'} (${globalPath})`);
    log(`local=${local.agent ?? 'unset'} (${localPath})`);
    log(`notify=${notify}`);
    log(`notifySource=${notifySource}`);
    log(`notifyGlobal=${typeof global.notify === 'boolean' ? global.notify : 'unset'} (${globalPath})`);
    log(`notifyLocal=${typeof local.notify === 'boolean' ? local.notify : 'unset'} (${localPath})`);
}
