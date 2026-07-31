import { summaryTrailerInstructions } from './summary-footer.js';

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
                ${summaryTrailerInstructions({ before: 'the answer' })}
            `,
        prompt,
        options: { cwd, readOnly: true },
    };
}
