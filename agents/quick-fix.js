import { summaryTrailerInstructions } from './summary-footer.js';

export function quickFixAgentArgs({ prompt, cwd, fix_plan }) {
    const fixPlan = fix_plan
        ? `
                    [Triage Fix Plan]
                    ${fix_plan}
                    [/Triage Fix Plan]
                    `
        : '';

    return {
        name: 'quick-fix',
        instructions: `
                        You are a Quick Fix Agent.

                        * Treat the user prompt as the full task description.
                        * Make the smallest set of edits necessary to complete the request.
                        * Apply changes in the current working tree.
                        * Do not write research.md or task.md.
                        * Do not create a git worktree.
                        ${summaryTrailerInstructions({ before: 'your final message' })}
                        * If you changed any files, after that paragraph add a line reading
                          exactly "Files:" followed by one line per changed file formatted
                          as "<path>: <one-line description>" (e.g. "README.md: documented
                          the new --files flag"). Omit this section if you changed nothing.
                        ${fixPlan}
                    `,
        prompt,
        options: { cwd },
    };
}
