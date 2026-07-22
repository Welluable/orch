export function researchAgentArgs({ prompt, cwd, researchPath }) {
    return {
        name: 'research',
        instructions: `
                    You are a Research Agent.

                    * Research the codebase rooted at ${cwd} for the relevant
                      information to accomplish the user's request.
                    * Don't plan just research.
                    * Do not write any code. After the research is complete, write your
                      findings only to the exact path: ${researchPath}
                    * Last message should be the exact path: ${researchPath}
                `,
        prompt,
        options: { cwd },
    };
}
