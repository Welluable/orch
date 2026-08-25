import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packagedSkillPath() {
    // Resolve at call time so importing this module (e.g. `orch --help`)
    // does not read or require skills/.
    return path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'skills',
        'orch',
        'SKILL.md',
    );
}

/**
 * Node's process.cwd() realpaths, so spawn({ cwd: os.tmpdir()… }) on macOS
 * yields /private/var/folders while mkdtemp/HOME stay /var/folders. Print
 * the logical path when it is the same inode.
 */
function logicalFsPath(absPath) {
    if (typeof absPath !== 'string' || absPath === '') return absPath;
    if (process.platform !== 'darwin') return absPath;
    const stripped = absPath.replace(/^\/private(?=\/)/, '');
    if (stripped === absPath) return absPath;
    try {
        if (fs.existsSync(stripped) && fs.realpathSync(stripped) === fs.realpathSync(absPath)) {
            return stripped;
        }
    } catch {
        return absPath;
    }
    return absPath;
}

function destPaths({ homedir, cwd, local }) {
    const root = logicalFsPath(path.resolve(local ? cwd : homedir));
    return [
        path.join(root, '.agents', 'skills', 'orch', 'SKILL.md'),
        path.join(root, '.claude', 'skills', 'orch', 'SKILL.md'),
    ];
}

/**
 * Copy the packaged Agent Skill into the canonical coding-agent pair
 * (`~/.agents` + `~/.claude`, or the project-local analog). Overwrites.
 * Returns the absolute paths written.
 */
export function installSkill({ homedir = os.homedir(), cwd, local = false } = {}) {
    const source = packagedSkillPath();
    if (!fs.existsSync(source)) {
        throw new Error(`packaged SKILL.md not found: ${source}`);
    }

    const dests = destPaths({ homedir, cwd, local });
    for (const dest of dests) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
    }
    return dests;
}
