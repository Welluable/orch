import fs from 'node:fs';
import path from 'node:path';
import { generateSlug as defaultGenerateSlug } from './slug.js';

/**
 * Creates `<cwd>/.orch/<slug>/` for a new run and returns absolute paths to
 * its artifacts. Retries with a fresh slug a bounded number of times if the
 * generated directory already exists; throws once attempts are exhausted
 * rather than reusing or repairing an existing directory.
 */
export function createRunContext({ cwd, generateSlug = defaultGenerateSlug, maxAttempts = 5 } = {}) {
    const absCwd = path.resolve(cwd);
    const orchDir = path.join(absCwd, '.orch');

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const slug = generateSlug();
        const artifactDir = path.join(orchDir, slug);

        if (fs.existsSync(artifactDir)) continue;

        fs.mkdirSync(artifactDir, { recursive: true });

        return {
            slug,
            artifactDir,
            researchPath: path.join(artifactDir, 'research.md'),
            taskPath: path.join(artifactDir, 'task.md'),
            statusPath: path.join(artifactDir, 'status.md'),
        };
    }

    throw new Error(`createRunContext: exhausted ${maxAttempts} attempts to allocate a unique run directory under ${orchDir}`);
}
