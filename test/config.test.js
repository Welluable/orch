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
});
