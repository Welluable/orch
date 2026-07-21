import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRunContext } from '../lib/run-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-run-context-'));
}

describe('createRunContext', () => {
  it('creates <cwd>/.orch/<slug>/ and returns absolute paths rooted under cwd', () => {
    const tmpCwd = makeTmpCwd();

    const ctx = createRunContext({ cwd: tmpCwd });

    assert.match(ctx.slug, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    assert.equal(ctx.artifactDir, path.join(tmpCwd, '.orch', ctx.slug));
    assert.equal(ctx.researchPath, path.join(ctx.artifactDir, 'research.md'));
    assert.equal(ctx.taskPath, path.join(ctx.artifactDir, 'task.md'));
    assert.equal(ctx.statusPath, path.join(ctx.artifactDir, 'status.md'));

    for (const p of [ctx.artifactDir, ctx.researchPath, ctx.taskPath, ctx.statusPath]) {
      assert.ok(path.isAbsolute(p), `${p} should be absolute`);
      assert.ok(p.startsWith(tmpCwd), `${p} should be rooted under the supplied cwd`);
    }

    assert.ok(fs.statSync(ctx.artifactDir).isDirectory());
  });

  it('does not place any artifact path under the orch package/install directory', () => {
    const tmpCwd = makeTmpCwd();

    const ctx = createRunContext({ cwd: tmpCwd });

    for (const p of [ctx.artifactDir, ctx.researchPath, ctx.taskPath, ctx.statusPath]) {
      assert.ok(!p.startsWith(repoRoot), `${p} must not point inside the orch install directory`);
    }
  });

  it('resolves a non-normalized cwd to an absolute, normalized path', () => {
    const tmpCwd = makeTmpCwd();
    const messyCwd = path.join(tmpCwd, 'nested', '..');

    const ctx = createRunContext({ cwd: messyCwd });

    assert.ok(!ctx.artifactDir.includes('..'));
    assert.equal(ctx.artifactDir, path.join(tmpCwd, '.orch', ctx.slug));
  });

  it('retries with a new slug when the generated slug directory already exists', () => {
    const tmpCwd = makeTmpCwd();
    fs.mkdirSync(path.join(tmpCwd, '.orch', 'stub-stub-0000'), { recursive: true });

    const queue = ['stub-stub-0000', 'stub-stub-1111'];
    let calls = 0;
    const stubGenerateSlug = () => queue[calls++];

    const ctx = createRunContext({ cwd: tmpCwd, generateSlug: stubGenerateSlug });

    assert.equal(calls, 2);
    assert.equal(ctx.slug, 'stub-stub-1111');
    assert.equal(ctx.artifactDir, path.join(tmpCwd, '.orch', 'stub-stub-1111'));
  });

  it('throws rather than reusing an existing slug directory once retries are exhausted', () => {
    const tmpCwd = makeTmpCwd();
    fs.mkdirSync(path.join(tmpCwd, '.orch', 'stub-stub-0000'), { recursive: true });

    let calls = 0;
    const stubGenerateSlug = () => {
      calls += 1;
      return 'stub-stub-0000';
    };

    assert.throws(() => createRunContext({ cwd: tmpCwd, generateSlug: stubGenerateSlug, maxAttempts: 3 }));
    assert.equal(calls, 3);
    // The colliding directory must be left untouched, not reused or repaired.
    assert.ok(fs.existsSync(path.join(tmpCwd, '.orch', 'stub-stub-0000')));
  });

  it('does not create .orch merely by being imported', async () => {
    const tmpCwd = makeTmpCwd();
    const runContextPath = path.join(repoRoot, 'lib', 'run-context.js').replace(/\\/g, '/');

    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['-e', `import(${JSON.stringify(`file://${runContextPath}`)}).then(() => process.exit(0));`],
        { cwd: tmpCwd, env: process.env },
      );
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exited ${code}`))));
    });

    assert.equal(fs.existsSync(path.join(tmpCwd, '.orch')), false);
  });
});
