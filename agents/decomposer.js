import { summaryTrailerInstructions } from './summary-footer.js';

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

export function decomposerAgentArgs({ prompt, cwd, boundariesOutput, maxWorkers, feedback }) {
    return {
        name: 'decomposer',
        instructions: `
                    You are a Decomposer Agent.

                    * Read the boundaries research below and the original task, then decide
                      whether the work can be split into independent workers.
                    * At most ${maxWorkers} workers — that is a hard ceiling, not a target.
                    * "decomposable": false (with a "why") is a valid, expected answer when
                      you cannot find independent seams — do not force a split.
                    * Your final message MUST be valid JSON only — no markdown, no prose
                      outside JSON:

                      {
                        "decomposable": true,
                        "why": "short reason",
                        "workers": [
                          {
                            "id": "01-scaffold",
                            "title": "short title",
                            "subtask": "what this worker implements",
                            "area": "coarse directory or feature name",
                            "owns": ["path/prefix/or/file"],
                            "dependsOn": [],
                            "scaffold": true
                          }
                        ]
                      }

                      or, when declining:

                      {
                        "decomposable": false,
                        "why": "short reason"
                      }
                    * Before the summary marker below, the JSON itself must stay exactly as
                      specified above.
                    ${summaryTrailerInstructions({ before: 'the JSON verdict only' })}

                    [Boundaries Agent Output]
                    ${boundariesOutput}
                    [/Boundaries Agent Output]${feedbackBlock(feedback)}
                `,
        prompt,
        options: { cwd },
    };
}
