import { execFileSync } from 'node:child_process';
import { askAgentArgs } from '../agents/ask.js';
import { AgentAgn } from './agent-agn.js';
import { AgentClaude } from './agent-claude.js';
import { AgentCursor } from './agent-cursor.js';
import { AgentOpencode } from './agent-opencode.js';
import {
    buildAskFollowUpPrompt,
    readAskSession,
    recordAskExchange,
} from './ask-session.js';
import { patchJob } from './jobs.js';
import { splitStageSummary } from './stage-summary.js';

const AGENT_BACKENDS = {
    cursor: {
        AgentClass: AgentCursor,
        binary: 'agent',
        missingHint: 'agent not found; install Cursor Agent CLI or use --agent claude',
    },
    claude: {
        AgentClass: AgentClaude,
        binary: 'claude',
        missingHint: 'claude not found; install Claude Code or use --agent cursor',
    },
    agn: {
        AgentClass: AgentAgn,
        binary: 'agn',
        missingHint: 'agn not found; run npm install -g @welluable/agn-cli or use --agent cursor',
    },
    opencode: {
        AgentClass: AgentOpencode,
        binary: 'opencode',
        missingHint:
            'opencode not found; install OpenCode (https://opencode.ai) or use --agent cursor',
    },
};

function defaultIsBinaryOnPath(binary) {
    try {
        execFileSync('which', [binary], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Non-exiting ask runner for serve (and other embedders).
 *
 * Mirrors CLI `runPipeline` ask / `--ask --from` semantics without
 * `process.exit`: loads sessions, folds turns via `buildAskFollowUpPrompt`,
 * runs the read-only ask agent, and calls `recordAskExchange` only on success.
 *
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   jobSlug: string,
 *   agent?: string,
 *   fromSlug?: string | null,
 *   AgentClass?: Function | null,
 *   patchJob?: typeof patchJob,
 *   isBinaryOnPath?: (binary: string) => boolean,
 *   verbose?: boolean,
 * }} opts
 * @returns {Promise<{ answer: string, session: object, slug: string }>}
 */
export async function runAsk(opts = {}) {
    const {
        prompt,
        cwd,
        jobSlug,
        fromSlug = null,
        AgentClass = null,
        patchJob: patchJobFn = patchJob,
        isBinaryOnPath = defaultIsBinaryOnPath,
        verbose = false,
    } = opts;

    if (typeof prompt !== 'string' || !prompt.trim()) {
        throw httpError('prompt is required', 400);
    }
    if (!cwd || !jobSlug) {
        throw httpError('cwd and jobSlug are required', 400);
    }

    let agent = opts.agent ?? 'claude';
    let askPrompt = prompt;

    if (fromSlug) {
        let session;
        try {
            session = readAskSession(cwd, fromSlug);
        } catch (err) {
            throw httpError(
                `could not read ask session for ${fromSlug}: ${err.message}`,
                400,
            );
        }
        if (!session) {
            throw httpError(`no ask session found for ${fromSlug}`, 404);
        }
        // HTTP always passes an explicit agent (body or serve default). Session
        // agent fallback is CLI-only (`cliAgentExplicit === false`).
        askPrompt = buildAskFollowUpPrompt(session.turns ?? [], prompt);
    }

    const backend = AGENT_BACKENDS[agent];
    if (!backend) {
        throw httpError(`Unknown agent backend: ${agent}`, 400);
    }
    const Klass = AgentClass ?? backend.AgentClass;
    if (!AgentClass && !isBinaryOnPath(backend.binary)) {
        throw httpError(backend.missingHint, 502);
    }

    const jobPatch = (fields) => {
        try {
            return patchJobFn(cwd, jobSlug, fields);
        } catch {
            return null;
        }
    };

    jobPatch({ phase: 'ask', state: 'running' });

    const ask = askAgentArgs({ prompt: askPrompt, cwd });
    const askAgent = new Klass(ask.name, ask.instructions, ask.prompt, ask.options);

    try {
        const askResult = await askAgent.run({ verbose });
        if (!askResult.ok) {
            jobPatch({
                state: 'failed',
                exitCode: 1,
                finishedAt: new Date().toISOString(),
            });
            throw httpError('ask agent failed', 502);
        }
        const { content } = splitStageSummary(askResult.result);
        const session = recordAskExchange(cwd, jobSlug, {
            prompt,
            answer: content,
            agent,
        });
        jobPatch({
            state: 'done',
            exitCode: 0,
            finishedAt: new Date().toISOString(),
        });
        return { answer: content, session, slug: jobSlug };
    } catch (err) {
        if (err.statusCode) throw err;
        jobPatch({
            state: 'failed',
            exitCode: 1,
            finishedAt: new Date().toISOString(),
        });
        throw httpError(err.message || 'ask agent failed', 502);
    }
}
