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

function researchBlock({ researchPath, researchOutput }) {
    const parts = [];
    if (researchPath) {
        parts.push(`Research file (read it): ${researchPath}`);
    }
    if (typeof researchOutput === 'string' && researchOutput.trim()) {
        parts.push(`[Research Output]\n${researchOutput.trim()}\n[/Research Output]`);
    }
    if (parts.length === 0) return '';
    return `

                    ${parts.join('\n\n')}`;
}

function planModeInstructions({ maxUnits, feedback, researchPath, researchOutput }) {
    return `
                    You are a Seq-Decomposer Agent (plan mode for --decompose).

                    * Read the research output below (and/or the research file path) and the
                      original task, then split the work into an ordered backlog of finishable
                      units. Order is the schedule — a flat list only, not a parallel
                      dependency graph.
                    * At most ${maxUnits} units — that is a hard ceiling, not a target.
                    * At least 1 unit. Never answer with an empty list.
                    * If no useful split exists, return exactly one unit whose subtask covers
                      the full task. Never decline; there is no decomposable:false path in
                      plan mode.
                    * Each unit object must contain only id, title, and subtask. Use a
                      slug-safe id (lowercase alphanumeric segments joined by hyphens).
                    * Prefer omitting "decomposable", or set it true; validators ignore a
                      false path for this mode.
                    * Your final message MUST be valid JSON only — no markdown, no prose
                      outside JSON:

                      {
                        "why": "short reason",
                        "units": [
                          {
                            "id": "01-types",
                            "title": "short title",
                            "subtask": "what this unit implements"
                          }
                        ]
                      }

                    * Before the summary marker below, the JSON itself must stay exactly as
                      specified above.
                    ${summaryTrailerInstructions({ before: 'the JSON verdict only' })}
                    ${researchBlock({ researchPath, researchOutput })}
                    ${feedbackBlock(feedback)}
                `;
}

function defaultModeInstructions({ maxUnits, feedback }) {
    return `
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
                    * Before the summary marker below, the JSON itself must stay exactly as
                      specified above.
                    ${summaryTrailerInstructions({ before: 'the JSON verdict only' })}
                    ${feedbackBlock(feedback)}
                `;
}

/**
 * Seq-decomposer agent args. Pass `mode: 'plan'` (or use `decomposeAgentArgs`)
 * for `--decompose`: never decline, always emit ≥1 and ≤maxUnits units,
 * grounded on research.
 */
export function seqDecomposerAgentArgs({
    prompt,
    cwd,
    maxUnits,
    feedback,
    mode,
    researchPath,
    researchOutput,
} = {}) {
    const plan = mode === 'plan';
    return {
        name: 'seq-decomposer',
        instructions: plan
            ? planModeInstructions({ maxUnits, feedback, researchPath, researchOutput })
            : defaultModeInstructions({ maxUnits, feedback }),
        prompt,
        options: { cwd },
    };
}

/** Thin wrapper: plan-mode seq-decomposer for `--decompose`. */
export function decomposeAgentArgs(opts = {}) {
    return seqDecomposerAgentArgs({ ...opts, mode: 'plan' });
}
