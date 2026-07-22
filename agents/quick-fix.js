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
                        * After your final message above, on a new line write the summary
                          marker (three '<' characters, then SUMMARY, then three '>'
                          characters, with no spaces), followed by one paragraph in
                          natural, human-readable language explaining what you did in this
                          step and what happened — no lists, no headers, just prose.
                        ${fixPlan}
                    `,
        prompt,
        options: { cwd },
    };
}
