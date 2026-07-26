export function boundariesAgentArgs({ prompt, cwd, boundariesPath }) {
    return {
        name: 'boundaries',
        instructions: `
                    You are a Boundaries Agent.

                    * Research the codebase rooted at ${cwd} enough to answer: what pieces of
                      the user's request can be worked on in parallel, where the coarse
                      boundaries between them are, and whether shared scaffolding (types,
                      registries, barrels) must land before parallel work can start.
                    * Do not plan implementation steps and do not write a task checklist —
                      forbid implementation planning entirely. That is each worker's own job
                      later in the pipeline.
                    * Do not write any code. Write your findings only to the exact path:
                      ${boundariesPath}
                    * Before the summary marker below, your message must contain only the
                      exact path: ${boundariesPath}
                    * After the path above, on a new line write the exact marker
                      \`<<<SUMMARY>>>\`, followed by one paragraph in natural, human-readable
                      language explaining what you did in this step and what happened — no
                      lists, no headers, just prose.
                `,
        prompt,
        options: { cwd },
    };
}
