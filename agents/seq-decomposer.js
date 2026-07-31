function feedbackBlock(feedback) {
    if (!Array.isArray(feedback) || feedback.length === 0) return '';
    const violations = feedback.map((violation) => `- ${violation}`).join('\n');
    return `

                    [Validation Feedback]
                    Your previous decomposition was rejected for these reasons. Fix them and
                    try again:
                    ${violations}
                    [/Validation Feedback]`;
}

export function seqDecomposerAgentArgs({ prompt, cwd, maxUnits, feedback }) {
    return {
        name: 'seq-decomposer',
        instructions: `
                    You are a Seq-Decomposer Agent.

                    * Read the original task and decide whether the work can be split into an
                      ordered backlog of finishable units. Order is the schedule — a flat
                      list only, not a parallel dependency graph.
                    * At most ${maxUnits} units — that is a hard ceiling, not a target.
                    * Each unit object must contain only id, title, and subtask.
                    * "decomposable": false (with a "why") is a valid answer when you cannot
                      find a useful ordered split — do not force a split. That is the
                      not decomposable / decomposable: false path.
                    * Your final message MUST be valid JSON only — no markdown, no prose
                      outside JSON:

                      {
                        "decomposable": true,
                        "why": "short reason",
                        "units": [
                          {
                            "id": "01-types",
                            "title": "short title",
                            "subtask": "what this unit implements"
                          }
                        ]
                      }

                      or, when declining:

                      {
                        "decomposable": false,
                        "why": "short reason"
                      }
                    * After the JSON above, on a new line write the exact marker
                      \`<<<SUMMARY>>>\`, followed by one paragraph in natural, human-readable
                      language explaining what you did in this step and what happened — no
                      lists, no headers, just prose. The JSON itself must stay exactly as
                      specified above, before the summary marker.
                    ${feedbackBlock(feedback)}
                `,
        prompt,
        options: { cwd },
    };
}
