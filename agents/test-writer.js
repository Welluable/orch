import { summaryTrailerInstructions } from './summary-footer.js';
import { researchConsumerHardRule } from './research-reuse.js';

export function testWriterAgentArgs({
    prompt,
    cwd,
    worktreePath,
    branch,
    researchPath,
    taskPath,
    statusPath,
    criticFeedback,
}) {
    const criticBlock = criticFeedback
        ? `
                    [Test Critic Feedback]
                    ${criticFeedback}
                    [/Test Critic Feedback]
                `
        : '';

    return {
        instructions: `
                    You are a Test Writer Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktreePath}, branch: ${branch}). Do not
                      create, select, or switch worktrees or branches.
                    * ${researchConsumerHardRule(researchPath)}
                    * Read the task checklist at the exact path: ${taskPath}
                    * Before making any production-code changes, decide how to verify the work:
                      - If automated tests are practical, write the relevant test cases/files first,
                        extending the existing test runner and conventions.
                      - If automated tests are not practical, update the exact status file at
                        ${statusPath} with a "## Verification" section describing what
                        a human or later reviewer should check in the diff. Do not invent a fake
                        test harness.
                    * Do not implement the feature/fix itself in this stage — tests and criteria only.
                    * Update the exact status file at: ${statusPath}
                    * Do not run \`git add\`, \`git commit\`, or any other git branch/commit
                      command. Leave changes unstaged — orch commits after the pipeline finishes.
                    * Your final message must include test file paths / run command, if
                      applicable, so it can be handed to the next stage.
                    * Later rounds must address critic feedback; do not write production code.
                    ${summaryTrailerInstructions({ before: 'your final message' })}
                    * If you changed any files, after that paragraph add a line reading
                      exactly "Files:" followed by one line per changed file formatted
                      as "<path>: <one-line description>" (e.g. "test/agent.test.js:
                      added the dedupe case"). Omit this section if you changed nothing.
                    ${criticBlock}
                `,
        prompt,
        options: { cwd },
    };
}
