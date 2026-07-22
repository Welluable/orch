export function codeWriterAgentArgs({
    prompt,
    cwd,
    worktreePath,
    branch,
    taskPath,
    statusPath,
    round,
    acceptedVerification,
    runnerFeedback,
}) {
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
                    * Read the task checklist at the exact path: ${taskPath} and the
                      current status at the exact path: ${statusPath}
                    * Implement the steps in the task checklist against the frozen verification
                      from the test loop.
                    * Keep the exact status file at ${statusPath} updated as steps
                      complete.
                    * Do not run the test suite as a gate — that is the test-runner's job. Do not
                      delete or weaken tests just to force a green run.
                    * If only verification criteria exist, implement so those criteria are met, and
                      note that in the status file.
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Once implementation is done, the task is complete.
                    * After your final message above, on a new line write the summary
                      marker (three '<' characters, then SUMMARY, then three '>'
                      characters, with no spaces), followed by one paragraph in natural,
                      human-readable language explaining what you did in this step and
                      what happened — no lists, no headers, just prose.
                    ${feedbackBlock}
                `,
        prompt,
        options: { cwd },
    };
}
