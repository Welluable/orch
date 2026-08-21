import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `orch skill` — install the packaged Agent Skill into coding-agent dirs.
 *
 * lib/skill.js must export `installSkill({ homedir, cwd, local })` which
 * copies `skills/orch/SKILL.md` (resolved from `import.meta.url` at call
 * time, not module load) into the canonical pair and returns the written
 * absolute paths.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const mainPath = path.join(repoRoot, 'main.js');
const skillLibPath = path.join(repoRoot, 'lib', 'skill.js');
const packagedSkillPath = path.join(repoRoot, 'skills', 'orch', 'SKILL.md');

const NATIVE_SKILL_RELS = [
  path.join('.cursor', 'skills', 'orch', 'SKILL.md'),
  path.join('.cursor', 'skills-cursor', 'orch', 'SKILL.md'),
  path.join('.config', 'opencode', 'skills', 'orch', 'SKILL.md'),
  path.join('.codex', 'skills', 'orch', 'SKILL.md'),
  path.join('.opencode', 'skills', 'orch', 'SKILL.md'),
];

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd, env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out: orch ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function wrotePaths(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  for (const line of lines) {
    assert.match(line, /^wrote /, `stdout lines must be \`wrote <path>\`; got ${JSON.stringify(line)}`);
  }
  return lines.map((line) => line.slice('wrote '.length));
}

function globalDests(home) {
  return [
    path.join(home, '.agents', 'skills', 'orch', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'orch', 'SKILL.md'),
  ];
}

function localDests(cwd) {
  return [
    path.join(cwd, '.agents', 'skills', 'orch', 'SKILL.md'),
    path.join(cwd, '.claude', 'skills', 'orch', 'SKILL.md'),
  ];
}

function assertCanonicalPair(dests, sourceText) {
  assert.equal(dests.length, 2, `expected two wrote paths; got ${JSON.stringify(dests)}`);
  for (const dest of dests) {
    assert.ok(path.isAbsolute(dest), `wrote path must be absolute: ${dest}`);
    assert.ok(fs.existsSync(dest), `expected written file ${dest}`);
    const text = fs.readFileSync(dest, 'utf8');
    assert.equal(text, sourceText, `dest ${dest} must be a byte-for-byte copy of the packaged SKILL.md`);
    assert.match(text, /^---\n[\s\S]*?\nname:\s*orch\b/m);
    assert.match(text, /ORCH_JOB_SLUG/);
    assert.match(text, /ORCH_SEQ_DEPTH/);
    assert.match(text, /ORCH_FANOUT_DEPTH/);
  }
}

function assertNoNativeDirs(root) {
  for (const rel of NATIVE_SKILL_RELS) {
    assert.equal(
      fs.existsSync(path.join(root, rel)),
      false,
      `must not write native extra skill path ${rel} under ${root}`,
    );
  }
}

function assertNoOrchDir(...roots) {
  for (const root of roots) {
    assert.equal(fs.existsSync(path.join(root, '.orch')), false, `must not allocate .orch/ under ${root}`);
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter delimited by ---');
  return { yaml: match[1], body: match[2] };
}

async function loadInstallSkill() {
  assert.ok(fs.existsSync(skillLibPath), 'expected lib/skill.js');
  const mod = await import(pathToFileURL(skillLibPath).href);
  assert.equal(typeof mod.installSkill, 'function', 'lib/skill.js must export installSkill');
  return mod.installSkill;
}

describe('package.json files includes skills/', () => {
  it('lists skills/** alongside main.js, lib/**, and agents/**', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.files));
    assert.ok(
      pkg.files.some((entry) => entry === 'skills/**' || entry === 'skills' || String(entry).startsWith('skills/')),
      `expected package.json "files" to include skills; got ${JSON.stringify(pkg.files)}`,
    );
  });
});

describe('skills/orch/SKILL.md', () => {
  it('ships static frontmatter + a body that teaches agents to shell out to orch', () => {
    assert.ok(fs.existsSync(packagedSkillPath), 'expected packaged skills/orch/SKILL.md');
    const text = fs.readFileSync(packagedSkillPath, 'utf8');
    const { yaml, body } = parseFrontmatter(text);

    assert.match(yaml, /^name:\s*orch\s*$/m);
    assert.match(yaml, /^description:\s*\S/m);
    assert.doesNotMatch(
      text,
      /disable-model-invocation/,
      'omit disable-model-invocation so hosts may auto-invoke',
    );

    const description = yaml.match(/^description:\s*(?:>-\s*)?([\s\S]*?)(?=^[a-zA-Z][-a-zA-Z0-9]*:|\s*$)/m);
    assert.ok(description, 'frontmatter must include a description (what + when, third person)');
    assert.match(description[1], /orch/i);
    assert.doesNotMatch(
      description[1],
      /\bI\b|\byou should\b|\bI'll\b/i,
      'description must be third person (what the skill does / when to use it)',
    );

    assert.match(body, /PATH/);
    assert.match(body, /npm install -g @welluable\/orch/);
    assert.match(body, /\.orch\/<slug>\//);
    assert.match(body, /wait/i);
    assert.match(body, /in-session|in session/i);

    assert.match(body, /orch "<task>"|orch '<task>'/);
    assert.match(body, /--ask/);
    assert.match(body, /--ask --from <slug>/);
    assert.match(body, /--quick/);
    assert.match(body, /--pr/);
    assert.match(body, /\bgh\b/);
    assert.match(body, /--detach/);
    assert.match(body, /list/);
    assert.match(body, /status/);
    assert.match(body, /logs/);
    assert.match(body, /pause/);
    assert.match(body, /resume/);
    assert.match(body, /stop/);
    assert.match(body, /--seq/);
    assert.match(body, /--decompose/);
    assert.match(body, /--fan-out/);
    assert.match(body, /mutually exclusive/i);

    assert.match(body, /ORCH_JOB_SLUG/);
    assert.match(body, /ORCH_SEQ_DEPTH/);
    assert.match(body, /ORCH_FANOUT_DEPTH/);
    assert.match(body, /never|do not|don't/i);
  });
});

describe('lib/skill.js', () => {
  it('importing the module does not read or require skills/', async () => {
    assert.ok(fs.existsSync(skillLibPath), 'expected lib/skill.js');
    const pkg = makeTmp('orch-skill-noload-');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.copyFileSync(skillLibPath, path.join(pkg, 'lib', 'skill.js'));
    const href = `${pathToFileURL(path.join(pkg, 'lib', 'skill.js')).href}?noload=${Date.now()}`;
    const mod = await import(href);
    assert.equal(typeof mod.installSkill, 'function');
    assert.equal(fs.existsSync(path.join(pkg, 'skills')), false);
  });

  it('installSkill copies the packaged file into both global dests and returns those paths', async () => {
    const installSkill = await loadInstallSkill();
    const home = makeTmp('orch-skill-lib-home-');
    const cwd = makeTmp('orch-skill-lib-cwd-');
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');

    const written = installSkill({ homedir: home, cwd, local: false });
    assert.ok(Array.isArray(written), 'installSkill must return the written paths');
    assert.deepEqual([...written].sort(), globalDests(home).sort());
    assertCanonicalPair(written, sourceText);
    for (const dest of localDests(cwd)) {
      assert.equal(fs.existsSync(dest), false, `global install must not write ${dest}`);
    }
    assertNoNativeDirs(home);
    assertNoNativeDirs(cwd);
    assertNoOrchDir(home, cwd);
  });

  it('installSkill({ local: true }) writes both project dests and leaves HOME untouched', async () => {
    const installSkill = await loadInstallSkill();
    const home = makeTmp('orch-skill-lib-local-home-');
    const cwd = makeTmp('orch-skill-lib-local-cwd-');
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');

    const written = installSkill({ homedir: home, cwd, local: true });
    assert.deepEqual([...written].sort(), localDests(cwd).sort());
    assertCanonicalPair(written, sourceText);
    for (const dest of globalDests(home)) {
      assert.equal(fs.existsSync(dest), false, `local install must not write ${dest}`);
    }
    assertNoOrchDir(home, cwd);
  });

  it('overwrites an existing dest without --force', async () => {
    const installSkill = await loadInstallSkill();
    const home = makeTmp('orch-skill-lib-ow-home-');
    const cwd = makeTmp('orch-skill-lib-ow-cwd-');
    const first = installSkill({ homedir: home, cwd, local: false });
    for (const dest of first) {
      fs.writeFileSync(dest, 'stale skill body\n');
    }
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');
    const second = installSkill({ homedir: home, cwd, local: false });
    assertCanonicalPair(second, sourceText);
  });

  it('resolves SKILL.md from the package next to lib/, not cwd', async () => {
    assert.ok(fs.existsSync(skillLibPath), 'expected lib/skill.js');
    const pkg = makeTmp('orch-skill-pkg-');
    const cwd = makeTmp('orch-skill-pkg-cwd-');
    const home = makeTmp('orch-skill-pkg-home-');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'skills', 'orch'), { recursive: true });
    fs.copyFileSync(skillLibPath, path.join(pkg, 'lib', 'skill.js'));
    const marker = 'UNIQUE_SKILL_MARKER_FOR_ISOLATION_TEST\n';
    fs.writeFileSync(path.join(pkg, 'skills', 'orch', 'SKILL.md'), `---\nname: orch\n---\n${marker}`);
    fs.mkdirSync(path.join(cwd, 'skills', 'orch'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'skills', 'orch', 'SKILL.md'), 'DECOY FROM CWD\n');

    const { installSkill } = await import(
      `${pathToFileURL(path.join(pkg, 'lib', 'skill.js')).href}?iso=${Date.now()}`
    );
    installSkill({ homedir: home, cwd, local: false });
    const dest = fs.readFileSync(path.join(home, '.agents', 'skills', 'orch', 'SKILL.md'), 'utf8');
    assert.match(dest, /UNIQUE_SKILL_MARKER_FOR_ISOLATION_TEST/);
    assert.doesNotMatch(dest, /DECOY FROM CWD/);
  });

  it('throws when the packaged SKILL.md is missing', async () => {
    assert.ok(fs.existsSync(skillLibPath), 'expected lib/skill.js');
    const pkg = makeTmp('orch-skill-miss-');
    const home = makeTmp('orch-skill-miss-home-');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.copyFileSync(skillLibPath, path.join(pkg, 'lib', 'skill.js'));
    const { installSkill } = await import(
      `${pathToFileURL(path.join(pkg, 'lib', 'skill.js')).href}?miss=${Date.now()}`
    );
    assert.throws(
      () => installSkill({ homedir: home, cwd: pkg, local: false }),
      /skill|SKILL\.md|not found|ENOENT|missing/i,
    );
  });
});

describe('orch skill CLI', () => {
  let home;
  let cwd;

  function freshEnv() {
    home = makeTmp('orch-skill-cli-home-');
    cwd = makeTmp('orch-skill-cli-cwd-');
    return {
      ...process.env,
      HOME: home,
      PATH: '/nonexistent-empty-path-for-tests',
    };
  }

  it('orch skill is a subcommand (not a task prompt)', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['skill'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /task cannot be empty/i);
    assert.doesNotMatch(stderr, /missing required argument/i);
    assert.match(stdout, /^wrote /m);
  });

  it('help lists the skill subcommand', async () => {
    const { code, stdout } = await runCli(['--help'], {
      cwd: makeTmp('orch-skill-help-'),
      env: freshEnv(),
    });
    assert.equal(code, 0);
    assert.match(stdout, /^\s+skill\b/m);
  });

  it('orch skill --help describes install and lists --global / --local', async () => {
    const { code, stdout, stderr } = await runCli(['skill', '--help'], {
      cwd: makeTmp('orch-skill-cmd-help-'),
      env: freshEnv(),
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /install/i);
    assert.match(stdout, /--global/);
    assert.match(stdout, /--local/);
  });

  it('default writes both global dests under isolated HOME', async () => {
    const env = freshEnv();
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');
    const { code, stdout, stderr } = await runCli(['skill'], { cwd, env });
    assert.equal(code, 0, stderr);
    const dests = wrotePaths(stdout);
    assert.deepEqual([...dests].sort(), globalDests(home).sort());
    assertCanonicalPair(dests, sourceText);
    for (const dest of localDests(cwd)) {
      assert.equal(fs.existsSync(dest), false);
    }
    assertNoNativeDirs(home);
    assertNoNativeDirs(cwd);
    assertNoOrchDir(home, cwd);
  });

  it('orch skill --global is the same as the default', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['skill', '--global'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.deepEqual([...wrotePaths(stdout)].sort(), globalDests(home).sort());
  });

  it('orch skill --local writes both project dests', async () => {
    const env = freshEnv();
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');
    const { code, stdout, stderr } = await runCli(['skill', '--local'], { cwd, env });
    assert.equal(code, 0, stderr);
    const dests = wrotePaths(stdout);
    assert.deepEqual([...dests].sort(), localDests(cwd).sort());
    assertCanonicalPair(dests, sourceText);
    for (const dest of globalDests(home)) {
      assert.equal(fs.existsSync(dest), false);
    }
    assertNoOrchDir(home, cwd);
  });

  it('--global --local exits 1 and writes nothing', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['skill', '--global', '--local'],
      { cwd, env },
    );
    assert.equal(code, 1);
    assert.match(stderr, /Error: /);
    assert.match(stderr, /mutually exclusive/);
    assert.equal(stdout, '');
    for (const dest of [...globalDests(home), ...localDests(cwd)]) {
      assert.equal(fs.existsSync(dest), false);
    }
    assertNoOrchDir(home, cwd);
  });

  it('overwrites an existing SKILL.md without --force', async () => {
    const env = freshEnv();
    const sourceText = fs.readFileSync(packagedSkillPath, 'utf8');
    const first = await runCli(['skill'], { cwd, env });
    assert.equal(first.code, 0, first.stderr);
    for (const dest of wrotePaths(first.stdout)) {
      fs.writeFileSync(dest, 'stale\n');
    }
    const second = await runCli(['skill'], { cwd, env });
    assert.equal(second.code, 0, second.stderr);
    assertCanonicalPair(wrotePaths(second.stdout), sourceText);
  });

  it('ignores parent --agent when choosing destinations', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['skill', '--agent', 'claude'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    assert.deepEqual([...wrotePaths(stdout)].sort(), globalDests(home).sort());
    assert.equal(fs.existsSync(path.join(home, '.cursor', 'skills', 'orch', 'SKILL.md')), false);
  });

  it('does not create .orch/ in cwd or HOME', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(['skill'], { cwd, env });
    assert.equal(code, 0, stderr);
    assertNoOrchDir(home, cwd);
  });

  it('--help does not read skills/ or write dests', async () => {
    const env = freshEnv();
    const help = await runCli(['--help'], { cwd, env });
    assert.equal(help.code, 0);
    const skillHelp = await runCli(['skill', '--help'], { cwd, env });
    assert.equal(skillHelp.code, 0, skillHelp.stderr);
    for (const dest of [...globalDests(home), ...localDests(cwd)]) {
      assert.equal(fs.existsSync(dest), false);
    }
    assertNoOrchDir(home, cwd);
  });

  it('main.js registers command(skill) and imports lib/skill.js', () => {
    const src = fs.readFileSync(mainPath, 'utf8');
    assert.match(src, /\.command\('skill'\)/);
    assert.match(src, /from ['"]\.\/lib\/skill\.js['"]/);
  });
});
