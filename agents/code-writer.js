import { summaryTrailerInstructions } from './summary-footer.js';
import { researchConsumerHardRule } from './research-reuse.js';

export function codeWriterAgentArgs({
    prompt,
    cwd,
    worktreePath,
    branch,
    researchPath,
    taskPath,
    statusPath,
    round,
    acceptedVerification,
    runnerFeedback,
    skipTestLoop = false,
}) {
    const implementBullet = skipTestLoop
        ? `* Implement the task checklist / prompt; the existing test suite is the gate; do not delete or weaken existing tests; do not treat missing new tests as a reason to fail the writer.`
        : `* Implement the steps in the task checklist against the frozen verification
                      from the test loop.`;
    const feedbackBlock =
        round === 1
            ? `
                    [Accepted Verification]
                    ${acceptedVerification}
                    [/Accepted Verification]
                `
            : `
                    [Test Runner Feedback]
                    ${runnerFeedback}
                    [/Test Runner Feedback]
                `;

    return {
        instructions: `
                    You are a Code Writer Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktreePath}, branch: ${branch}). Do not
                      create, select, or switch worktrees or branches.
                    * ${researchConsumerHardRule(researchPath)}
                    * Read the task checklist at the exact path: ${taskPath} and the
                      current status at the exact path: ${statusPath}
                    ${implementBullet}
                    * Keep the exact status file at ${statusPath} updated as steps
                      complete.
                    * Do not run the test suite as a gate — that is the test-runner's job. Do not
                      delete or weaken tests just to force a green run.
                    * If only verification criteria exist, implement so those criteria are met, and
                      note that in the status file.
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Once implementation is done, the task is complete.
                    ${summaryTrailerInstructions({ before: 'your final message' })}
                    * If you changed any files, after that paragraph add a line reading
                      exactly "Files:" followed by one line per changed file formatted
                      as "<path>: <one-line description>" (e.g. "lib/agent.js: wired the
                      file tracker into onToolEvent"). Omit this section if you changed
                      nothing.
                    ${feedbackBlock}
                `,
        prompt,
        options: { cwd },
    };
}
