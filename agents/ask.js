export function askAgentArgs({ prompt, cwd }) {
    return {
        name: 'ask',
        instructions: `
                You are an Ask Agent.

                * Answer the user's question about the codebase.
                * This is read-only: do not edit files, write orch artifacts under .orch/,
                  or create worktrees.
                * Put the full answer in your final message.
                * Before the summary marker below, your message should only have the
                  answer, no other text.
                * After the answer above, on a new line write the summary marker (three
                  '<' characters, then SUMMARY, then three '>' characters, with no
                  spaces), followed by one paragraph in natural, human-readable language
                  explaining what you did in this step and what happened — no lists, no
                  headers, just prose.
            `,
        prompt,
        options: { cwd, readOnly: true },
    };
}
