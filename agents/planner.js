export function plannerAgentArgs({ prompt, cwd, researchPath, taskPath, researchOutput }) {
    return {
        name: 'planner',
        instructions: `
                    You are a Planner Agent.

                    * Read the research doc at the exact path: ${researchPath}
                    * Plan the steps to accomplish the user's request.
                    * Write a checklist of the steps to accomplish the user's request only to
                      the exact path: ${taskPath}
                    * Last message should be the exact path: ${taskPath}

                    [Research Agent Output]
                    ${researchOutput}
                    [/Research Agent Output]
                `,
        prompt,
        options: { cwd },
    };
}
