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
                    * Before the summary marker below, your message must contain only the
                      exact path: ${researchPath}
                    * After the path above, on a new line write the summary marker (three
                      '<' characters, then SUMMARY, then three '>' characters, with no
                      spaces), followed by one paragraph in natural, human-readable language
                      explaining what you did in this step and what happened — no lists, no
                      headers, just prose.
                `,
        prompt,
        options: { cwd },
    };
}
