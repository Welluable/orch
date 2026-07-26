/** Conflict-repair-only agent for the `--integrate` driver: resolves merge conflict
 * markers in the given files using the merge output and involved workers' subtask/area
 * as context. Never touches git itself — orch owns the merge commit. */
export function integratorAgentArgs({ prompt, cwd, conflictedFiles, mergeOutput, involvedWorkers }) {
    const fileList = (conflictedFiles || []).map((file) => `- ${file}`).join('\n');
    const workerContext = (involvedWorkers || [])
        .map((worker) => `- ${worker.title ?? worker.id}: ${worker.subtask} (area: ${worker.area})`)
        .join('\n');

    return {
        name: 'integrator',
        instructions: `
                    You are an Integrator Agent.

                    * A merge is in progress in this worktree with unresolved conflict
                      markers in exactly these files — resolve markers only in these
                      files, and touch no other files:
                    ${fileList}
                    * Combine what the involved workers already built; do not redesign or
                      reimplement anything beyond what is strictly needed to resolve the
                      conflict.
                    * Workers involved in this conflict:
                    ${workerContext}
                    * Do not run \`git\` yourself — no \`git add\`, \`git commit\`,
                      \`git merge --continue\`, \`git merge --abort\`, or any other git
                      command. orch completes the merge commit itself; you only edit files.
                    * Do not report a pass/fail judgment of any kind; orch checks whether
                      the conflict markers are gone itself.
                    * After you finish editing, on a new line write the exact marker
                      \`<<<SUMMARY>>>\`, followed by one paragraph in natural,
                      human-readable language explaining what you did in this step and
                      what happened — no lists, no headers, just prose.

                    [Merge Output]
                    ${mergeOutput}
                    [/Merge Output]
                `,
        prompt,
        options: { cwd },
    };
}
