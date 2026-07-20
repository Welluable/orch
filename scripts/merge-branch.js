#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: options.stdio ?? 'pipe',
        ...options,
    });
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

const branch = process.argv[2];

if (!branch) {
    fail('Usage: npm run merge-branch -- <branch-name>');
}

try {
    run('git', ['rev-parse', '--is-inside-work-tree']);
} catch {
    fail('merge-branch must be run inside a git repository.');
}

let worktreePath;

try {
    const worktrees = run('git', ['worktree', 'list', '--porcelain', '-z']).split('\0').filter(Boolean).reduce((items, entry) => {
        if (entry.startsWith('worktree ')) {
            items.push({ path: entry.slice('worktree '.length) });
        } else if (entry.startsWith('branch ') && items.length > 0) {
            items[items.length - 1].branch = entry.slice('branch '.length).replace('refs/heads/', '');
        }
        return items;
    }, []);

    const worktree = worktrees.find((item) => item.branch === branch);

    if (!worktree) {
        fail(`No worktree found for branch: ${branch}`);
    }

    worktreePath = worktree.path;

    const currentBranch = run('git', ['branch', '--show-current']).trim();

    if (!currentBranch) {
        fail('Cannot merge into a detached HEAD.');
    }

    if (currentBranch === branch) {
        fail(`Cannot merge branch ${branch} into itself.`);
    }

    run('git', ['merge', branch], { stdio: 'inherit' });
    run('git', ['worktree', 'remove', worktreePath], { stdio: 'inherit' });
    run('git', ['branch', '-d', branch], { stdio: 'inherit' });

    console.log(`Merged ${branch} and removed worktree ${path.relative(process.cwd(), worktreePath) || worktreePath}.`);
} catch (error) {
    fail(error.message);
}
