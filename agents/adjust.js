function feedbackBlock(feedback) {
    if (!Array.isArray(feedback) || feedback.length === 0) return '';
    const violations = feedback.map((violation) => `- ${violation}`).join('\n');
    return `

                    [Validation Feedback]
                    Your previous adjust result was rejected for these reasons. Fix them and
                    try again:
                    ${violations}
                    [/Validation Feedback]`;
}

function formatUnits(units) {
    if (!Array.isArray(units) || units.length === 0) return '(none)';
    return units
        .map((u) => `- ${u.id}: ${u.title} — ${u.subtask}${u.sha ? ` (sha ${u.sha})` : ''}`)
        .join('\n');
}

export function adjustAgentArgs({
    originalTask,
    doneUnits,
    pendingUnits,
    tip,
    cwd,
    maxUnits,
    feedback,
}) {
    return {
        name: 'adjust',
        instructions: `
                    You are an Adjust Agent for a sequential orch run.

                    * The original task is the hard fence — do not expand product scope past it:
                      ${originalTask}
                    * Current tip SHA of the integration branch: ${tip}
                    * Done units (do not rewrite or drop these):
${formatUnits(doneUnits)}
                    * Pending units in schedule order:
${formatUnits(pendingUnits)}
                    * You may rewrite at most the next two pending units' title/subtask texts
                      so they match the tip. You may drop obsolete pending units. Do not invent
                      new ids. Do not resurrect done/failed work as new ids. Respect maxUnits
                      ${maxUnits} (rewrite/drop only — do not grow the backlog).
                    * Your final message MUST be valid JSON only — no markdown, no prose
                      outside JSON:

                      {
                        "rewrites": [
                          { "id": "02-api", "title": "optional new title", "subtask": "optional new subtask" }
                        ],
                        "drops": ["04-obsolete"]
                      }

                      Use empty arrays when you have no rewrites or drops.
                    * After the JSON above, on a new line write the exact marker
                      \`<<<SUMMARY>>>\`, followed by one paragraph in natural, human-readable
                      language explaining what you did in this step and what happened — no
                      lists, no headers, just prose. The JSON itself must stay exactly as
                      specified above, before the summary marker.
                    ${feedbackBlock(feedback)}
                `,
        prompt: originalTask,
        options: { cwd },
    };
}
