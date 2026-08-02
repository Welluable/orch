import { summaryTrailerInstructions } from './summary-footer.js';
import { researchConsumerHardRule, shrinkResearchOutput } from './research-reuse.js';

export function plannerAgentArgs({ prompt, cwd, researchPath, taskPath, researchOutput }) {
    const excerpt = shrinkResearchOutput(researchOutput, { researchPath });
    const researchBlock = excerpt
        ? `
                    [Research Agent Output]
                    ${excerpt}
                    [/Research Agent Output]
                `
        : '';

    return {
        name: 'planner',
        instructions: `
                    You are a Planner Agent.

                    * ${researchConsumerHardRule(researchPath)}
                    * Read the research doc at the exact path: ${researchPath}
                    * Plan the steps to accomplish the user's request.
                    * Write a checklist of the steps to accomplish the user's request only to
                      the exact path: ${taskPath}
                    * task.md is the plan/checklist only — cite paths from research when
                      useful, but do not dump a second full research document into it.
                    * Before the summary marker below, your message must contain only the
                      exact path: ${taskPath}
                    ${summaryTrailerInstructions({ before: `the exact path: ${taskPath}` })}
                    ${researchBlock}
                `,
        prompt,
        options: { cwd },
    };
}
