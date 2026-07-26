import { generateSlug as generateSlugDefault } from './slug.js';
import { createRunContext as createRunContextDefault } from './run-context.js';
import { writeJob as writeJobDefault, jobPaths } from './jobs.js';

/**
 * Shared job-allocation helper: generates a slug, creates the run directory,
 * and writes the initial `run.json`. Used by both `runDetached` (which starts
 * a job `"starting"` with no pid yet, since a separate child process still
 * has to start) and the Commander action's non-detached branch (which starts
 * a job `"running"` with `process.pid`, since there is no separate child to
 * wait on).
 */
export function allocateJob({
    cwd,
    prompt,
    agent,
    maxRounds = null,
    state = 'starting',
    pid = null,
    generateSlug = generateSlugDefault,
    createRunContext = createRunContextDefault,
    writeJob = writeJobDefault,
}) {
    const slug = generateSlug();
    const runContext = createRunContext({ cwd, slug });
    const record = {
        slug,
        task: prompt,
        agent,
        maxRounds,
        cwd,
        pauseRequested: false,
        branch: null,
        worktree: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        logPath: jobPaths(cwd, slug).logPath,
        pid,
        state,
        phase: null,
        stage: null,
        round: null,
    };
    writeJob(cwd, slug, record);
    return { slug, runContext, record };
}
