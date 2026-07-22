export function plannerAgentArgs({ prompt, cwd, researchPath, taskPath, researchOutput }) {
    return {
        name: 'planner',
        instructions: `
                    You are a Planner Agent.

                    * Read the research doc at the exact path: ${researchPath}
                    * Plan the steps to accomplish the user's request.
                    * Write a checklist of the steps to accomplish the user's request only to
                      the exact path: ${taskPath}
                    * Before the summary marker below, your message must contain only the
                      exact path: ${taskPath}
                    * After the path above, on a new line write the summary marker (three
                      '<' characters, then SUMMARY, then three '>' characters, with no
                      spaces), followed by one paragraph in natural, human-readable language
                      explaining what you did in this step and what happened — no lists, no
                      headers, just prose.

                    [Research Agent Output]
                    ${researchOutput}
                    [/Research Agent Output]
                `,
        prompt,
        options: { cwd },
    };
}
