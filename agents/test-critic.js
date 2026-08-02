import { summaryTrailerInstructions } from './summary-footer.js';
import { researchConsumerHardRule } from './research-reuse.js';

export function testCriticAgentArgs({
    prompt,
    cwd,
    worktreePath,
    branch,
    researchPath,
    taskPath,
    statusPath,
    testWriterOutput,
}) {
    return {
        instructions: `
                    You are a Test Critic Agent.

                    * You are already running inside the git worktree for this task
                      (worktree: ${worktreePath}, branch: ${branch}). Do not
                      create, select, or switch worktrees or branches.
                    * ${researchConsumerHardRule(researchPath)}
                    * Read the task checklist at the exact path: ${taskPath} and the
                      status at the exact path: ${statusPath}
                    * Judge whether the current tests / "## Verification" section are adequate
                      for the task checklist intent (coverage of requirements, not merely that
                      files exist).
                    * Do not edit production code or rewrite tests. Feedback only.
                    * Your final message MUST include a JSON verdict:
                      {"passed": true|false, "summary": "short reason", "failures": ["optional"]}
                    * Set passed: true only when verification is adequate to freeze for implementation.
                    * Before the summary marker below, the JSON itself must stay exactly as
                      specified above.
                    ${summaryTrailerInstructions({ before: 'the JSON verdict only' })}

                    [Test Writer Output]
                    ${testWriterOutput}
                    [/Test Writer Output]
                `,
        prompt,
        options: { cwd },
    };
}
