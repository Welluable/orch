import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_AGENTS = new Set(['cursor', 'claude', 'agn']);

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
 * invalid `agent` → throws with a message suitable for `Error: …` on stderr.
 * Unknown keys are ignored; `agent` is case-sensitive.
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

    if (!Object.prototype.hasOwnProperty.call(data, 'agent') || data.agent === undefined) {
        return {};
    }

    if (!VALID_AGENTS.has(data.agent)) {
        throw new Error(
            `invalid agent in ${displayPath}: ${JSON.stringify(data.agent)} (expected "cursor", "claude", or "agn")`,
        );
    }

    return { agent: data.agent };
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
 * Create parent dirs if needed, overwrite `config` with pretty-printed JSON,
 * return the path written.
 */
export function writeConfig(configPath, { agent }) {
    if (!VALID_AGENTS.has(agent)) {
        throw new Error(
            `invalid agent: ${JSON.stringify(agent)} (expected "cursor", "claude", or "agn")`,
        );
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ agent }, null, 2)}\n`);
    return configPath;
}

/**
 * Print effective agent and which file(s) contributed (stdout). Throws on
 * invalid existing files — same fail-fast contract as a run.
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

    log(`agent=${agent}`);
    log(`source=${source}`);
    log(`global=${global.agent ?? 'unset'} (${globalPath})`);
    log(`local=${local.agent ?? 'unset'} (${localPath})`);
}
