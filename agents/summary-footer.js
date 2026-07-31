/**
 * Shared `<<<SUMMARY>>>` trailer instructions for every stage agent.
 * @param {{ before?: string }} [opts]
 */
export function summaryTrailerInstructions({ before = 'required stage output' } = {}) {
    return `
* Your final message MUST end with a summary trailer. After ${before}, on its
  own line write exactly this marker (copy it verbatim — do not put it inside
  a code fence):

  \`<<<SUMMARY>>>\`

* On the next line, write one paragraph in natural, human-readable language
  explaining what you did in this step and what happened — no lists, no headers.
* Shape:

  <${before}>
  <<<SUMMARY>>>
  One short paragraph of what you did and what happened.

* Omitting the marker makes the reply invalid for this pipeline.
`;
}
