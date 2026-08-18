import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  resolveAgent,
  writeConfig,
  printConfig,
  globalConfigPath,
  localConfigPath,
} from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('lib/config helpers', () => {
  it('loadConfig returns {} for a missing file', () => {
    const dir = makeTmp('orch-cfg-miss-');
    assert.deepEqual(loadConfig(path.join(dir, 'config')), {});
  });

  it('loadConfig returns {} for {} or omitted agent/notify', () => {
    const dir = makeTmp('orch-cfg-empty-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{}\n');
    assert.deepEqual(loadConfig(p), {});
    fs.writeFileSync(p, '{"other":1}\n');
    assert.deepEqual(loadConfig(p), {});
  });

  it('loadConfig returns a valid agent', () => {
    const dir = makeTmp('orch-cfg-ok-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{"agent":"claude"}\n');
    assert.deepEqual(loadConfig(p), { agent: 'claude' });
    fs.writeFileSync(p, '{"agent":"opencode"}\n');
    assert.deepEqual(loadConfig(p), { agent: 'opencode' });
  });

  it('loadConfig returns notify boolean alone or with agent', () => {
    const dir = makeTmp('orch-cfg-notify-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{"notify":false}\n');
    assert.deepEqual(loadConfig(p), { notify: false });
    fs.writeFileSync(p, '{"agent":"claude","notify":true}\n');
    assert.deepEqual(loadConfig(p), { agent: 'claude', notify: true });
  });

  it('loadConfig throws on invalid (non-boolean) notify', () => {
    const dir = makeTmp('orch-cfg-badnotify-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{"notify":"yes"}\n');
    assert.throws(
      () => loadConfig(p, '.orch/config'),
      /invalid notify in \.orch\/config/,
    );
  });

  it('loadConfig throws on bad JSON', () => {
    const dir = makeTmp('orch-cfg-badjson-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{nope');
    assert.throws(() => loadConfig(p, '.orch/config'), /could not parse \.orch\/config/);
  });

  it('loadConfig throws on invalid agent', () => {
    const dir = makeTmp('orch-cfg-badagent-');
    const p = path.join(dir, 'config');
    fs.writeFileSync(p, '{"agent":"gpt"}\n');
    assert.throws(
      () => loadConfig(p, '~/.orch/config'),
      /invalid agent in ~\/\.orch\/config: "gpt".*opencode/,
    );
  });

  it('writeConfig accepts opencode and rejects unknown agents mentioning opencode', () => {
    const dir = makeTmp('orch-cfg-write-oc-');
    const p = path.join(dir, '.orch', 'config');
    assert.equal(writeConfig(p, { agent: 'opencode' }), p);
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "agent": "opencode"\n}\n');
    assert.throws(
      () => writeConfig(p, { agent: 'gpt' }),
      /invalid agent: "gpt".*opencode/,
    );
  });

  it('writeConfig creates parent dirs and overwrites', () => {
    const dir = makeTmp('orch-cfg-write-');
    const p = path.join(dir, '.orch', 'config');
    assert.equal(writeConfig(p, { agent: 'agn' }), p);
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "agent": "agn"\n}\n');
    writeConfig(p, { agent: 'cursor' });
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "agent": "cursor"\n}\n');
  });

  it('writeConfig merges notify with existing agent (and vice versa)', () => {
    const dir = makeTmp('orch-cfg-merge-');
    const p = path.join(dir, '.orch', 'config');
    writeConfig(p, { agent: 'claude' });
    writeConfig(p, { notify: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'claude',
      notify: false,
    });
    writeConfig(p, { agent: 'agn' });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'agn',
      notify: false,
    });
    writeConfig(p, { notify: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'agn',
      notify: true,
    });
  });

  it('writeConfig rejects non-boolean notify', () => {
    const dir = makeTmp('orch-cfg-write-badnotify-');
    const p = path.join(dir, '.orch', 'config');
    assert.throws(
      () => writeConfig(p, { notify: 'yes' }),
      /invalid notify/,
    );
  });

  it('resolveAgent prefers cli > local > global > cursor', () => {
    const home = makeTmp('orch-cfg-home-');
    const cwd = makeTmp('orch-cfg-cwd-');
    assert.equal(resolveAgent({ cwd, homedir: home }), 'cursor');
    assert.equal(resolveAgent({ cliAgent: 'agn', cwd, homedir: home }), 'agn');

    writeConfig(globalConfigPath({ homedir: home }), { agent: 'claude' });
    assert.equal(resolveAgent({ cwd, homedir: home }), 'claude');

    writeConfig(localConfigPath(cwd), { agent: 'agn' });
    assert.equal(resolveAgent({ cwd, homedir: home }), 'agn');
    assert.equal(resolveAgent({ cliAgent: 'cursor', cwd, homedir: home }), 'cursor');
  });

  it('resolveNotify defaults true; CLI > local > global > true', async () => {
    const { resolveNotify } = await import('../lib/config.js');
    assert.equal(typeof resolveNotify, 'function', 'lib/config.js must export resolveNotify');

    const home = makeTmp('orch-notify-home-');
    const cwd = makeTmp('orch-notify-cwd-');
    assert.equal(resolveNotify({ cwd, homedir: home }), true);
    assert.equal(resolveNotify({ cliNotify: false, cwd, homedir: home }), false);
    assert.equal(resolveNotify({ cliNotify: true, cwd, homedir: home }), true);

    const globalPath = globalConfigPath({ homedir: home });
    const localPath = localConfigPath(cwd);
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(globalPath, '{"notify":true}\n');
    fs.writeFileSync(localPath, '{"notify":false}\n');
    assert.equal(resolveNotify({ cwd, homedir: home }), false);
    assert.equal(resolveNotify({ cliNotify: true, cwd, homedir: home }), true);

    fs.writeFileSync(localPath, '{"notify":true}\n');
    assert.equal(resolveNotify({ cliNotify: false, cwd, homedir: home }), false);

    fs.writeFileSync(localPath, '{"notify":false}\n');
    assert.equal(resolveNotify({ cliNotify: true, cwd, homedir: home }), true);

    fs.rmSync(localPath, { force: true });
    fs.writeFileSync(globalPath, '{"notify":false}\n');
    assert.equal(resolveNotify({ cwd, homedir: home }), false);
  });

  it('printConfig reports default when no files exist', () => {
    const home = makeTmp('orch-cfg-print-home-');
    const cwd = makeTmp('orch-cfg-print-cwd-');
    const lines = [];
    printConfig({ cwd, homedir: home, log: (line) => lines.push(line) });
    assert.equal(lines[0], 'agent=cursor');
    assert.equal(lines[1], 'source=default (builtin)');
    assert.match(lines[2], /^global=unset /);
    assert.match(lines[3], /^local=unset /);
    assert.match(lines.join('\n'), /^notify=true$/m);
    assert.match(lines.join('\n'), /^notifySource=default \(builtin\)$/m);
    assert.match(lines.join('\n'), /^notifyGlobal=unset /m);
    assert.match(lines.join('\n'), /^notifyLocal=unset /m);
  });

  it('printConfig shows local as effective when both are set', () => {
    const home = makeTmp('orch-cfg-both-home-');
    const cwd = makeTmp('orch-cfg-both-cwd-');
    writeConfig(globalConfigPath({ homedir: home }), { agent: 'agn' });
    writeConfig(localConfigPath(cwd), { agent: 'claude' });
    const lines = [];
    printConfig({ cwd, homedir: home, log: (line) => lines.push(line) });
    assert.equal(lines[0], 'agent=claude');
    assert.match(lines[1], /^source=local /);
    assert.match(lines[2], /^global=agn /);
    assert.match(lines[3], /^local=claude /);
  });

  it('printConfig reports effective notify from local over global', () => {
    const home = makeTmp('orch-cfg-notify-print-home-');
    const cwd = makeTmp('orch-cfg-notify-print-cwd-');
    const globalPath = globalConfigPath({ homedir: home });
    const localPath = localConfigPath(cwd);
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(globalPath, '{"notify":true}\n');
    fs.writeFileSync(localPath, '{"notify":false}\n');
    const lines = [];
    printConfig({ cwd, homedir: home, log: (line) => lines.push(line) });
    const out = lines.join('\n');
    assert.match(out, /^notify=false$/m);
    assert.match(out, /^notifySource=local /m);
    assert.match(out, /^notifyGlobal=true /m);
    assert.match(out, /^notifyLocal=false /m);
  });

  it('writeConfig/loadConfig round-trip branchPrefix; omit the key until set', () => {
    const dir = makeTmp('orch-cfg-bp-rt-');
    const p = path.join(dir, '.orch', 'config');

    writeConfig(p, { agent: 'claude' });
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "agent": "claude"\n}\n');
    assert.equal('branchPrefix' in JSON.parse(fs.readFileSync(p, 'utf8')), false);
    assert.deepEqual(loadConfig(p), { agent: 'claude' });

    writeConfig(p, { branchPrefix: 'long_running_session' });
    assert.equal(
      fs.readFileSync(p, 'utf8'),
      '{\n  "agent": "claude",\n  "branchPrefix": "long_running_session"\n}\n',
    );
    assert.deepEqual(loadConfig(p), {
      agent: 'claude',
      branchPrefix: 'long_running_session',
    });

    writeConfig(p, { branchPrefix: 'manoj/sessions' });
    assert.deepEqual(loadConfig(p), {
      agent: 'claude',
      branchPrefix: 'manoj/sessions',
    });

    writeConfig(p, { branchPrefix: 'orch' });
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).branchPrefix, 'orch');
    assert.deepEqual(loadConfig(p), { agent: 'claude', branchPrefix: 'orch' });
    assert.equal(
      fs.readFileSync(p, 'utf8'),
      '{\n  "agent": "claude",\n  "branchPrefix": "orch"\n}\n',
    );

    const onlyPrefix = path.join(dir, 'only', 'config');
    writeConfig(onlyPrefix, { branchPrefix: 'long_running_session' });
    assert.equal(
      fs.readFileSync(onlyPrefix, 'utf8'),
      '{\n  "branchPrefix": "long_running_session"\n}\n',
    );
    assert.deepEqual(loadConfig(onlyPrefix), { branchPrefix: 'long_running_session' });
  });

  it('writeConfig/loadConfig strip one trailing slash on branchPrefix; do not trim', async () => {
    const { resolveBranchPrefix } = await import('../lib/config.js');
    const dir = makeTmp('orch-cfg-bp-slash-');
    const p = path.join(dir, '.orch', 'config');

    writeConfig(p, { branchPrefix: 'foo/' });
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).branchPrefix, 'foo');
    assert.deepEqual(loadConfig(p), { branchPrefix: 'foo' });
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "branchPrefix": "foo"\n}\n');

    fs.writeFileSync(p, '{"branchPrefix":"foo/"}\n');
    assert.deepEqual(loadConfig(p), { branchPrefix: 'foo' });

    const home = makeTmp('orch-cfg-bp-slash-home-');
    const cwd = makeTmp('orch-cfg-bp-slash-cwd-');
    writeConfig(localConfigPath(cwd), { branchPrefix: 'foo' });
    const fromBare = resolveBranchPrefix({ cwd, homedir: home });
    writeConfig(localConfigPath(cwd), { branchPrefix: 'foo/' });
    const fromSlash = resolveBranchPrefix({ cwd, homedir: home });
    assert.equal(fromBare, 'foo');
    assert.equal(fromSlash, 'foo');

    for (const value of [' foo', 'foo ']) {
      assert.throws(
        () => writeConfig(p, { branchPrefix: value }),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );
      fs.writeFileSync(p, `${JSON.stringify({ branchPrefix: value })}\n`);
      assert.throws(
        () => loadConfig(p, '.orch/config'),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix in .orch/config: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );
    }
  });

  it('writeConfig merges branchPrefix with agent/notify without wiping either', () => {
    const dir = makeTmp('orch-cfg-bp-merge-');
    const p = path.join(dir, '.orch', 'config');

    writeConfig(p, { agent: 'claude', notify: false });
    writeConfig(p, { branchPrefix: 'long_running_session' });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'claude',
      notify: false,
      branchPrefix: 'long_running_session',
    });
    assert.equal(
      fs.readFileSync(p, 'utf8'),
      '{\n  "agent": "claude",\n  "notify": false,\n  "branchPrefix": "long_running_session"\n}\n',
    );

    writeConfig(p, { agent: 'agn' });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'agn',
      notify: false,
      branchPrefix: 'long_running_session',
    });

    writeConfig(p, { notify: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'agn',
      notify: true,
      branchPrefix: 'long_running_session',
    });
    assert.equal(
      fs.readFileSync(p, 'utf8'),
      '{\n  "agent": "agn",\n  "notify": true,\n  "branchPrefix": "long_running_session"\n}\n',
    );
  });

  it('writeConfig copies existing on-disk branchPrefix through on agent/notify-only writes', () => {
    const dir = makeTmp('orch-cfg-bp-copy-');
    const p = path.join(dir, '.orch', 'config');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{\n  "branchPrefix": "foo/"\n}\n');
    writeConfig(p, { agent: 'claude' });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {
      agent: 'claude',
      branchPrefix: 'foo/',
    });
  });

  it('loadConfig and writeConfig reject empty, whitespace, and non-string branchPrefix', () => {
    const dir = makeTmp('orch-cfg-bp-bad-');
    const p = path.join(dir, '.orch', 'config');
    const invalid = ['', '   ', 1, true, null, [], {}];

    for (const value of invalid) {
      assert.throws(
        () => writeConfig(p, { branchPrefix: value }),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );

      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${JSON.stringify({ branchPrefix: value })}\n`);
      assert.throws(
        () => loadConfig(p, '.orch/config'),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix in .orch/config: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );
      assert.throws(
        () => loadConfig(p, '~/.orch/config'),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix in ~/.orch/config: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );
    }
  });

  it('loadConfig and writeConfig reject unsafe git branchPrefix names', () => {
    const dir = makeTmp('orch-cfg-bp-unsafe-');
    const p = path.join(dir, '.orch', 'config');
    const unsafe = [
      'has space',
      '..',
      'a//b',
      'foo//',
      '/foo',
      '.foo',
      'foo.',
      'foo/.bar',
      'foo@{bar',
      'foo\\bar',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a\x01b',
      'a\x7fb',
    ];

    for (const value of unsafe) {
      assert.throws(
        () => writeConfig(p, { branchPrefix: value }),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );

      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${JSON.stringify({ branchPrefix: value })}\n`);
      assert.throws(
        () => loadConfig(p, '.orch/config'),
        (err) => {
          assert.equal(
            err.message,
            `invalid branchPrefix in .orch/config: ${JSON.stringify(value)} (expected a git-safe namespace)`,
          );
          return true;
        },
      );
    }
  });

  it('resolveBranchPrefix prefers local > global > orch and never persists a default', async () => {
    const { resolveBranchPrefix } = await import('../lib/config.js');
    assert.equal(typeof resolveBranchPrefix, 'function', 'lib/config.js must export resolveBranchPrefix');

    const home = makeTmp('orch-bp-home-');
    const cwd = makeTmp('orch-bp-cwd-');
    const globalPath = globalConfigPath({ homedir: home });
    const localPath = localConfigPath(cwd);

    assert.equal(resolveBranchPrefix({ cwd, homedir: home }), 'orch');
    assert.equal(fs.existsSync(localPath), false);
    assert.equal(fs.existsSync(globalPath), false);

    writeConfig(localPath, { agent: 'claude' });
    writeConfig(globalPath, { notify: true });
    assert.equal(resolveBranchPrefix({ cwd, homedir: home }), 'orch');
    assert.equal('branchPrefix' in JSON.parse(fs.readFileSync(localPath, 'utf8')), false);
    assert.equal('branchPrefix' in JSON.parse(fs.readFileSync(globalPath, 'utf8')), false);

    writeConfig(globalPath, { branchPrefix: 'from_global' });
    assert.equal(resolveBranchPrefix({ cwd, homedir: home }), 'from_global');

    writeConfig(localPath, { branchPrefix: 'from_local' });
    assert.equal(resolveBranchPrefix({ cwd, homedir: home }), 'from_local');
  });

  it('resolveBranchPrefix throws on invalid prefix or bad JSON like invalid agent', async () => {
    const { resolveBranchPrefix } = await import('../lib/config.js');
    const home = makeTmp('orch-bp-bad-home-');
    const cwd = makeTmp('orch-bp-bad-cwd-');
    const globalPath = globalConfigPath({ homedir: home });
    const localPath = localConfigPath(cwd);
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    fs.writeFileSync(localPath, '{"branchPrefix":""}\n');
    assert.throws(
      () => resolveBranchPrefix({ cwd, homedir: home }),
      (err) => {
        assert.equal(
          err.message,
          'invalid branchPrefix in .orch/config: "" (expected a git-safe namespace)',
        );
        return true;
      },
    );

    fs.rmSync(localPath, { force: true });
    fs.writeFileSync(globalPath, '{"branchPrefix":"bad name"}\n');
    assert.throws(
      () => resolveBranchPrefix({ cwd, homedir: home }),
      (err) => {
        assert.equal(
          err.message,
          'invalid branchPrefix in ~/.orch/config: "bad name" (expected a git-safe namespace)',
        );
        return true;
      },
    );

    writeConfig(localPath, { branchPrefix: 'ok' });
    fs.writeFileSync(globalPath, '{broken');
    assert.throws(
      () => resolveBranchPrefix({ cwd, homedir: home }),
      /could not parse ~\/\.orch\/config/,
    );

    fs.writeFileSync(localPath, '{nope');
    assert.throws(
      () => resolveBranchPrefix({ cwd, homedir: home }),
      /could not parse \.orch\/config/,
    );

    writeConfig(localPath, { branchPrefix: 'ok' });
    fs.writeFileSync(globalPath, '{"branchPrefix":""}\n');
    assert.throws(
      () => resolveBranchPrefix({ cwd, homedir: home }),
      (err) => {
        assert.equal(
          err.message,
          'invalid branchPrefix in ~/.orch/config: "" (expected a git-safe namespace)',
        );
        return true;
      },
    );
  });
});

describe('orch config CLI', () => {
  let home;
  let cwd;

  afterEach(() => {
    // best-effort; tmp dirs are under os.tmpdir
  });

  function freshEnv() {
    home = makeTmp('orch-cli-home-');
    cwd = makeTmp('orch-cli-cwd-');
    return { ...process.env, HOME: home };
  }

  it('orch config with no files prints cursor / default / unset', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^agent=cursor$/m);
    assert.match(stdout, /^source=default \(builtin\)$/m);
    assert.match(stdout, /^global=unset /m);
    assert.match(stdout, /^local=unset /m);
  });

  it('orch config --agent claude writes ~/.orch/config (not cwd)', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config', '--agent', 'claude'], { cwd, env });
    assert.equal(code, 0, stderr);
    const globalPath = path.join(home, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.match(stdout, /"agent": "claude"/);
    assert.equal(fs.readFileSync(globalPath, 'utf8'), '{\n  "agent": "claude"\n}\n');
    assert.equal(fs.existsSync(path.join(cwd, '.orch', 'config')), false);

    const printed = await runCli(['config'], { cwd, env });
    assert.equal(printed.code, 0);
    assert.match(printed.stdout, /^agent=claude$/m);
    assert.match(printed.stdout, /^source=global /m);
  });

  it('orch config --agent agn --local writes <cwd>/.orch/config', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['config', '--agent', 'agn', '--local'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    const localPath = path.join(cwd, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.match(stdout, /"agent": "agn"/);
    assert.equal(fs.readFileSync(localPath, 'utf8'), '{\n  "agent": "agn"\n}\n');
    // Wrote under cwd, not under HOME
    assert.equal(fs.existsSync(path.join(home, '.orch', 'config')), false);
  });

  it('orch config --agent cursor --global overwrites global without --force', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'claude'], { cwd, env });
    const { code, stdout, stderr } = await runCli(
      ['config', '--agent', 'cursor', '--global'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /"agent": "cursor"/);
    assert.equal(
      fs.readFileSync(path.join(home, '.orch', 'config'), 'utf8'),
      '{\n  "agent": "cursor"\n}\n',
    );
  });

  it('local + global → effective local; print shows both; source=local', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'agn'], { cwd, env });
    await runCli(['config', '--agent', 'claude', '--local'], { cwd, env });
    const { code, stdout } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0);
    assert.match(stdout, /^agent=claude$/m);
    assert.match(stdout, /^source=local /m);
    assert.match(stdout, /^global=agn /m);
    assert.match(stdout, /^local=claude /m);
  });

  it('global only → effective global; source=global', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'claude'], { cwd, env });
    const { code, stdout } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0);
    assert.match(stdout, /^agent=claude$/m);
    assert.match(stdout, /^source=global /m);
  });

  it('dry-run without --agent uses effective config agent', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'agn', '--local'], { cwd, env });
    const { stdout } = await runCli(['noop', '--dry-run'], { cwd, env });
    assert.match(stdout, /agent:\s+agn/);
  });

  it('config + --agent cursor → dry-run uses cursor', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'agn', '--local'], { cwd, env });
    const { stdout } = await runCli(['noop', '--dry-run', '--agent', 'cursor'], { cwd, env });
    assert.match(stdout, /agent:\s+cursor/);
  });

  it('invalid agent in local config → exit 1 mentioning the path', async () => {
    const env = freshEnv();
    fs.mkdirSync(path.join(cwd, '.orch'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.orch', 'config'), '{"agent":"gpt"}\n');
    const { code, stderr } = await runCli(['noop', '--dry-run'], { cwd, env });
    assert.equal(code, 1);
    assert.match(stderr, /invalid agent in \.orch\/config: "gpt"/);
  });

  it('bad JSON in global config → exit 1 mentioning the path', async () => {
    const env = freshEnv();
    fs.mkdirSync(path.join(home, '.orch'), { recursive: true });
    fs.writeFileSync(path.join(home, '.orch', 'config'), '{broken');
    const { code, stderr } = await runCli(['config'], { cwd, env });
    assert.equal(code, 1);
    assert.match(stderr, /could not parse ~\/\.orch\/config/);
  });

  it('--global --local → exit 1', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(
      ['config', '--agent', 'claude', '--global', '--local'],
      { cwd, env },
    );
    assert.equal(code, 1);
    assert.match(stderr, /mutually exclusive/);
  });

  it('--local without --agent/--notify/--no-notify → exit 1', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(['config', '--local'], { cwd, env });
    assert.equal(code, 1);
    assert.match(stderr, /--global\/--local require/);
    assert.match(stderr, /--branch-prefix/);
  });

  it('--agent foo is still rejected by Commander', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(['config', '--agent', 'foo'], { cwd, env });
    assert.notEqual(code, 0);
    assert.match(stderr, /cursor/);
    assert.match(stderr, /claude/);
    assert.match(stderr, /agn/);
    assert.match(stderr, /opencode/);
  });

  it('orch config is a subcommand (not a task prompt)', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^agent=/m);
    assert.doesNotMatch(stderr, /task cannot be empty/i);
  });

  it('help lists the config subcommand', async () => {
    const { code, stdout } = await runCli(['--help'], { cwd: makeTmp('orch-help-'), env: freshEnv() });
    assert.equal(code, 0);
    assert.match(stdout, /config/);
  });

  it('orch config prints effective notify=true by default', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^notify=true$/m);
    assert.match(stdout, /^notifySource=default \(builtin\)$/m);
    assert.match(stdout, /^notifyGlobal=unset /m);
    assert.match(stdout, /^notifyLocal=unset /m);
  });

  it('orch config --no-notify --local writes notify:false without wiping agent', async () => {
    const env = freshEnv();
    await runCli(['config', '--agent', 'claude', '--local'], { cwd, env });
    const { code, stdout, stderr } = await runCli(
      ['config', '--no-notify', '--local'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    const localPath = path.join(cwd, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.deepEqual(JSON.parse(fs.readFileSync(localPath, 'utf8')), {
      agent: 'claude',
      notify: false,
    });

    const printed = await runCli(['config'], { cwd, env });
    assert.equal(printed.code, 0);
    assert.match(printed.stdout, /^notify=false$/m);
    assert.match(printed.stdout, /^notifySource=local /m);
  });

  it('orch config --notify writes global notify:true by default', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config', '--notify'], { cwd, env });
    assert.equal(code, 0, stderr);
    const globalPath = path.join(home, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.equal(JSON.parse(fs.readFileSync(globalPath, 'utf8')).notify, true);
    assert.equal(fs.existsSync(path.join(cwd, '.orch', 'config')), false);
  });

  it('orch config --agent claude --notify merges both keys', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(
      ['config', '--agent', 'claude', '--notify'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(home, '.orch', 'config'), 'utf8')),
      { agent: 'claude', notify: true },
    );
  });

  it('--notify and --no-notify together → exit 1', async () => {
    const env = freshEnv();
    const { code, stderr } = await runCli(
      ['config', '--notify', '--no-notify'],
      { cwd, env },
    );
    assert.equal(code, 1);
    assert.match(stderr, /mutually exclusive|notify/i);
  });

  it('invalid notify in local config → exit 1 mentioning the path', async () => {
    const env = freshEnv();
    fs.mkdirSync(path.join(cwd, '.orch'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.orch', 'config'), '{"notify":"yes"}\n');
    const { code, stderr } = await runCli(['noop', '--dry-run'], { cwd, env });
    assert.equal(code, 1);
    assert.match(stderr, /invalid notify in \.orch\/config/);
  });

  it('help lists --notify / --no-notify', async () => {
    const { code, stdout } = await runCli(['--help'], { cwd: makeTmp('orch-help-notify-'), env: freshEnv() });
    assert.equal(code, 0);
    assert.match(stdout, /--notify/);
    assert.match(stdout, /--no-notify/);
  });

  it('help lists --branch-prefix', async () => {
    const { code, stdout } = await runCli(
      ['config', '--help'],
      { cwd: makeTmp('orch-help-bp-'), env: freshEnv() },
    );
    assert.equal(code, 0);
    assert.match(stdout, /--branch-prefix/);
  });

  it('orch config --branch-prefix long_running_session writes ~/.orch/config (not cwd)', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['config', '--branch-prefix', 'long_running_session'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    const globalPath = path.join(home, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.match(stdout, /"branchPrefix"/);
    assert.equal(
      JSON.parse(fs.readFileSync(globalPath, 'utf8')).branchPrefix,
      'long_running_session',
    );
    assert.equal(fs.existsSync(path.join(cwd, '.orch', 'config')), false);

    const printed = await runCli(['config'], { cwd, env });
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /^branchPrefix=long_running_session$/m);
    assert.match(printed.stdout, /^branchPrefixSource=global /m);
    assert.match(printed.stdout, /^branchPrefixGlobal=long_running_session /m);
    assert.match(printed.stdout, /^branchPrefixLocal=unset /m);
  });

  it('orch config --branch-prefix long_running_session --local writes <cwd>/.orch/config', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['config', '--branch-prefix', 'long_running_session', '--local'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    const localPath = path.join(cwd, '.orch', 'config');
    assert.match(stdout, /^wrote /m);
    assert.match(stdout, /"branchPrefix"/);
    assert.equal(
      JSON.parse(fs.readFileSync(localPath, 'utf8')).branchPrefix,
      'long_running_session',
    );
    assert.equal(fs.existsSync(path.join(home, '.orch', 'config')), false);
  });

  it('orch config --branch-prefix orch stores the string orch (source is not builtin)', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(
      ['config', '--branch-prefix', 'orch'],
      { cwd, env },
    );
    assert.equal(code, 0, stderr);
    const globalPath = path.join(home, '.orch', 'config');
    assert.equal(JSON.parse(fs.readFileSync(globalPath, 'utf8')).branchPrefix, 'orch');
    assert.match(stdout, /"branchPrefix": "orch"/);

    const printed = await runCli(['config'], { cwd, env });
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /^branchPrefix=orch$/m);
    assert.match(printed.stdout, /^branchPrefixSource=global /m);
    assert.doesNotMatch(printed.stdout, /^branchPrefixSource=default \(builtin\)$/m);

    const localWrite = await runCli(
      ['config', '--branch-prefix', 'orch', '--local'],
      { cwd, env },
    );
    assert.equal(localWrite.code, 0, localWrite.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, '.orch', 'config'), 'utf8')).branchPrefix,
      'orch',
    );

    const localPrinted = await runCli(['config'], { cwd, env });
    assert.equal(localPrinted.code, 0, localPrinted.stderr);
    assert.match(localPrinted.stdout, /^branchPrefix=orch$/m);
    assert.match(localPrinted.stdout, /^branchPrefixSource=local /m);
    assert.doesNotMatch(localPrinted.stdout, /^branchPrefixSource=default \(builtin\)$/m);
  });

  it('orch config prints builtin branchPrefix after notify when nothing is set', async () => {
    const env = freshEnv();
    const { code, stdout, stderr } = await runCli(['config'], { cwd, env });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^branchPrefix=orch$/m);
    assert.match(stdout, /^branchPrefixSource=default \(builtin\)$/m);
    assert.match(stdout, /^branchPrefixGlobal=unset /m);
    assert.match(stdout, /^branchPrefixLocal=unset /m);

    const notifyLocal = stdout.match(/^notifyLocal=.*$/m);
    const branchPrefix = stdout.match(/^branchPrefix=.*$/m);
    assert.ok(notifyLocal, 'expected notifyLocal= line');
    assert.ok(branchPrefix, 'expected branchPrefix= line');
    assert.ok(
      stdout.indexOf(notifyLocal[0]) < stdout.indexOf(branchPrefix[0]),
      'branchPrefix quartet must follow notify lines',
    );
  });
});
