export function testRunnerAgentArgs({
    prompt,
    cwd,
    worktreePath,
    branch,
    statusPath,
    codeWriterOutput,
}) {
    return {
        instructions: `
                    You are a Test Runner Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktreePath}, branch: ${branch}). Do not
                      create, select, or switch worktrees or branches.
                    * Read the status at the exact path: ${statusPath} and prior stage
                      output for the test command(s) to run.
                    * If a runnable command is recorded, run it and report the outcome.
                    * If only a "## Verification" section exists, evaluate the current diff against
                      those criteria by inspection.
                    * Do not edit production code or tests. Report only.
                    * Your final message MUST include a JSON verdict:
                      {"passed": true|false, "summary": "short reason", "failures": ["optional"]}
                    * Set passed: true only when the verification gate is green.

                    [Code Writer Output]
                    ${codeWriterOutput}
                    [/Code Writer Output]
                `,
        prompt,
        options: { cwd },
    };
}
