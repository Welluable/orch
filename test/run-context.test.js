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

  it('reuses an externally chosen slug, skipping generation/collision-retry entirely', () => {
    const tmpCwd = makeTmpCwd();
    const spySlug = () => {
      throw new Error('generateSlug must not be called when an explicit slug is given');
    };

    const ctx = createRunContext({ cwd: tmpCwd, slug: 'swift-lagoon-49ea', generateSlug: spySlug });

    assert.equal(ctx.slug, 'swift-lagoon-49ea');
    assert.equal(ctx.artifactDir, path.join(tmpCwd, '.orch', 'swift-lagoon-49ea'));
    assert.equal(ctx.researchPath, path.join(ctx.artifactDir, 'research.md'));
    assert.equal(ctx.taskPath, path.join(ctx.artifactDir, 'task.md'));
    assert.equal(ctx.statusPath, path.join(ctx.artifactDir, 'status.md'));
  });

  it('does not throw when reopening a slug directory eagerly pre-created by the detach parent', () => {
    const tmpCwd = makeTmpCwd();
    // Mirrors the eager `mkdirSync` the detach parent performs before the
    // child re-invokes the CLI with ORCH_JOB_SLUG=<this slug>.
    fs.mkdirSync(path.join(tmpCwd, '.orch', 'reused-slug-0000'), { recursive: true });

    const ctx = createRunContext({ cwd: tmpCwd, slug: 'reused-slug-0000' });

    assert.equal(ctx.slug, 'reused-slug-0000');
    assert.ok(fs.statSync(ctx.artifactDir).isDirectory());
  });

  it('still creates the directory when given a slug that does not exist yet (no eager pre-creation)', () => {
    const tmpCwd = makeTmpCwd();

    const ctx = createRunContext({ cwd: tmpCwd, slug: 'fresh-slug-0000' });

    assert.ok(fs.existsSync(ctx.artifactDir));
    assert.ok(fs.statSync(ctx.artifactDir).isDirectory());
  });

  it('returns the identical shape whether or not a slug was supplied', () => {
    const tmpCwd = makeTmpCwd();

    const generated = createRunContext({ cwd: tmpCwd });
    const reused = createRunContext({ cwd: tmpCwd, slug: 'explicit-slug-0000' });

    assert.deepEqual(Object.keys(generated).sort(), Object.keys(reused).sort());
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
