import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askAgentArgs } from '../agents/ask.js';
import { triageAgentArgs } from '../agents/triage.js';
import { quickFixAgentArgs } from '../agents/quick-fix.js';
import { researchAgentArgs } from '../agents/research.js';
import { plannerAgentArgs } from '../agents/planner.js';
import { testWriterAgentArgs } from '../agents/test-writer.js';
import { testCriticAgentArgs } from '../agents/test-critic.js';
import { codeWriterAgentArgs } from '../agents/code-writer.js';
import { testRunnerAgentArgs } from '../agents/test-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** Shape every factory must return for `new AgentClass(name, instructions, prompt, options)`. */
function assertAgentArgsShape(args, { expectName = true } = {}) {
  assert.equal(typeof args, 'object');
  assert.notEqual(args, null);
  assert.equal(typeof args.instructions, 'string');
  assert.ok(args.instructions.length > 0);
  assert.equal(typeof args.prompt, 'string');
  assert.equal(typeof args.options, 'object');
  assert.notEqual(args.options, null);
  assert.equal(typeof args.options.cwd, 'string');
  if (expectName) {
    assert.equal(typeof args.name, 'string');
    assert.ok(args.name.length > 0);
  } else {
    assert.equal(args.name, undefined);
  }
}

describe('package.json files includes agents/', () => {
  it('lists agents/** alongside main.js and lib/**', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(Array.isArray(pkg.files));
    assert.ok(
      pkg.files.some((entry) => entry === 'agents/**' || entry === 'agents' || entry.startsWith('agents/')),
      `expected package.json "files" to include agents; got ${JSON.stringify(pkg.files)}`,
    );
  });
});

describe('agents/ barrel (optional)', () => {
  it('re-exports all nine factories when agents/index.js exists', async () => {
    const indexPath = path.join(repoRoot, 'agents', 'index.js');
    if (!fs.existsSync(indexPath)) {
      return;
    }
    const barrel = await import('../agents/index.js');
    for (const name of [
      'askAgentArgs',
      'triageAgentArgs',
      'quickFixAgentArgs',
      'researchAgentArgs',
      'plannerAgentArgs',
      'testWriterAgentArgs',
      'testCriticAgentArgs',
      'codeWriterAgentArgs',
      'testRunnerAgentArgs',
    ]) {
      assert.equal(typeof barrel[name], 'function', `agents/index.js should export ${name}`);
    }
  });
});

describe('askAgentArgs', () => {
  it('returns ask args with readOnly: true and no interpolations', () => {
    const prompt = 'what does Agent.run do?';
    const cwd = '/tmp/invocation';
    const args = askAgentArgs({ prompt, cwd });

    assertAgentArgsShape(args);
    assert.equal(args.name, 'ask');
    assert.equal(args.prompt, prompt);
    assert.equal(args.options.cwd, cwd);
    assert.equal(args.options.readOnly, true);
    assert.match(args.instructions, /Ask Agent/);
    assert.match(args.instructions, /answer/i);
    assert.match(args.instructions, /do not edit|not edit|no edits|read-?only/i);
    assert.match(args.instructions, /orch|\.orch/i);
    assert.match(args.instructions, /worktree/i);
    assert.doesNotMatch(args.instructions, /\$\{/);
    assert.doesNotMatch(args.instructions, /<taskname>/);
  });
});

describe('triageAgentArgs', () => {
  it('returns triage args with JSON-verdict instructions and cwd only', () => {
    const prompt = 'fix the typo';
    const cwd = '/tmp/invocation';
    const args = triageAgentArgs({ prompt, cwd });

    assertAgentArgsShape(args);
    assert.equal(args.name, 'triage');
    assert.equal(args.prompt, prompt);
    assert.deepEqual(args.options, { cwd });
    assert.match(args.instructions, /Triage Agent/);
    assert.match(args.instructions, /"simple"/);
    assert.match(args.instructions, /fix_plan/);
    assert.match(args.instructions, /valid JSON/i);
    assert.equal(args.options.readOnly, undefined);
  });
});

describe('quickFixAgentArgs', () => {
  it('omits [Triage Fix Plan] when fix_plan is absent', () => {
    const args = quickFixAgentArgs({
      prompt: 'fix typo',
      cwd: '/tmp/cwd',
    });

    assertAgentArgsShape(args);
    assert.equal(args.name, 'quick-fix');
    assert.equal(args.options.cwd, '/tmp/cwd');
    assert.match(args.instructions, /Quick Fix Agent/);
    assert.match(args.instructions, /Do not write research\.md or task\.md/);
    assert.match(args.instructions, /Do not create a git worktree/);
    assert.doesNotMatch(args.instructions, /\[Triage Fix Plan\]/);
  });

  it('injects [Triage Fix Plan] … [/Triage Fix Plan] when fix_plan is set', () => {
    const plan = '- edit README typo\n- save';
    const args = quickFixAgentArgs({
      prompt: 'fix typo',
      cwd: '/tmp/cwd',
      fix_plan: plan,
    });

    assert.match(args.instructions, /\[Triage Fix Plan\]/);
    assert.match(args.instructions, /\[\/Triage Fix Plan\]/);
    assert.ok(args.instructions.includes(plan));
  });
});

describe('researchAgentArgs', () => {
  it('interpolates invocationCwd and absolute researchPath; no <taskname>', () => {
    const researchPath = '/tmp/orch/.orch/slug/research.md';
    const cwd = '/tmp/repo';
    const args = researchAgentArgs({
      prompt: 'add feature',
      cwd,
      researchPath,
    });

    assertAgentArgsShape(args);
    assert.equal(args.name, 'research');
    assert.equal(args.options.cwd, cwd);
    assert.match(args.instructions, /Research Agent/);
    assert.ok(args.instructions.includes(cwd));
    assert.ok(args.instructions.includes(researchPath));
    assert.doesNotMatch(args.instructions, /<taskname>/);
  });
});

describe('plannerAgentArgs', () => {
  it('interpolates paths and wraps prior output in [Research Agent Output]', () => {
    const researchPath = '/tmp/orch/.orch/slug/research.md';
    const taskPath = '/tmp/orch/.orch/slug/task.md';
    const researchOutput = 'found three call sites';
    const args = plannerAgentArgs({
      prompt: 'add feature',
      cwd: '/tmp/repo',
      researchPath,
      taskPath,
      researchOutput,
    });

    assertAgentArgsShape(args);
    assert.equal(args.name, 'planner');
    assert.ok(args.instructions.includes(researchPath));
    assert.ok(args.instructions.includes(taskPath));
    assert.match(args.instructions, /\[Research Agent Output\]/);
    assert.match(args.instructions, /\[\/Research Agent Output\]/);
    assert.ok(args.instructions.includes(researchOutput));
    assert.doesNotMatch(args.instructions, /<taskname>/);
  });
});

describe('testWriterAgentArgs', () => {
  const base = {
    prompt: 'extract agents',
    cwd: '/tmp/wt',
    worktreePath: '/tmp/wt',
    branch: 'orch/slug',
    taskPath: '/tmp/.orch/slug/task.md',
    statusPath: '/tmp/.orch/slug/status.md',
  };

  it('returns args without name (caller supplies roundLabel) and worktree cwd', () => {
    const args = testWriterAgentArgs(base);

    assertAgentArgsShape(args, { expectName: false });
    assert.equal(args.options.cwd, base.cwd);
    assert.ok(args.instructions.includes(base.worktreePath));
    assert.ok(args.instructions.includes(base.branch));
    assert.ok(args.instructions.includes(base.taskPath));
    assert.ok(args.instructions.includes(base.statusPath));
    assert.match(args.instructions, /Test Writer Agent/);
    assert.match(args.instructions, /Do not implement the feature\/fix itself/);
    assert.doesNotMatch(args.instructions, /\[Test Critic Feedback\]/);
  });

  it('injects [Test Critic Feedback] on later rounds when criticFeedback is set', () => {
    const feedback = 'missing coverage for ask readOnly';
    const args = testWriterAgentArgs({ ...base, criticFeedback: feedback });

    assert.match(args.instructions, /\[Test Critic Feedback\]/);
    assert.match(args.instructions, /\[\/Test Critic Feedback\]/);
    assert.ok(args.instructions.includes(feedback));
  });
});

describe('testCriticAgentArgs', () => {
  it('injects [Test Writer Output] and JSON verdict instructions; no name', () => {
    const ctx = {
      prompt: 'extract agents',
      cwd: '/tmp/wt',
      worktreePath: '/tmp/wt',
      branch: 'orch/slug',
      taskPath: '/tmp/.orch/slug/task.md',
      statusPath: '/tmp/.orch/slug/status.md',
      testWriterOutput: 'wrote test/agents.test.js; run npm test',
    };
    const args = testCriticAgentArgs(ctx);

    assertAgentArgsShape(args, { expectName: false });
    assert.equal(args.options.cwd, ctx.cwd);
    assert.ok(args.instructions.includes(ctx.worktreePath));
    assert.ok(args.instructions.includes(ctx.branch));
    assert.ok(args.instructions.includes(ctx.taskPath));
    assert.ok(args.instructions.includes(ctx.statusPath));
    assert.match(args.instructions, /Test Critic Agent/);
    assert.match(args.instructions, /\[Test Writer Output\]/);
    assert.match(args.instructions, /\[\/Test Writer Output\]/);
    assert.ok(args.instructions.includes(ctx.testWriterOutput));
    assert.match(args.instructions, /"passed"/);
    assert.match(args.instructions, /Do not edit production code or rewrite tests/i);
  });
});

describe('codeWriterAgentArgs', () => {
  const base = {
    prompt: 'extract agents',
    cwd: '/tmp/wt',
    worktreePath: '/tmp/wt',
    branch: 'orch/slug',
    taskPath: '/tmp/.orch/slug/task.md',
    statusPath: '/tmp/.orch/slug/status.md',
  };

  it('round 1 injects [Accepted Verification] and omits [Test Runner Feedback]', () => {
    const accepted = 'tests adequate\nwrote test/agents.test.js';
    const args = codeWriterAgentArgs({
      ...base,
      round: 1,
      acceptedVerification: accepted,
    });

    assertAgentArgsShape(args, { expectName: false });
    assert.equal(args.options.cwd, base.cwd);
    assert.ok(args.instructions.includes(base.worktreePath));
    assert.ok(args.instructions.includes(base.branch));
    assert.ok(args.instructions.includes(base.taskPath));
    assert.ok(args.instructions.includes(base.statusPath));
    assert.match(args.instructions, /Code Writer Agent/);
    assert.match(args.instructions, /\[Accepted Verification\]/);
    assert.match(args.instructions, /\[\/Accepted Verification\]/);
    assert.ok(args.instructions.includes(accepted));
    assert.doesNotMatch(args.instructions, /\[Test Runner Feedback\]/);
    assert.doesNotMatch(args.instructions, /finish regardless of failure/i);
  });

  it('later rounds inject [Test Runner Feedback] instead of [Accepted Verification]', () => {
    const feedback = 'parseVerdict missing|tests failed';
    const args = codeWriterAgentArgs({
      ...base,
      round: 2,
      runnerFeedback: feedback,
    });

    assert.ok(args.instructions.includes(base.worktreePath));
    assert.ok(args.instructions.includes(base.branch));
    assert.ok(args.instructions.includes(base.taskPath));
    assert.ok(args.instructions.includes(base.statusPath));
    assert.match(args.instructions, /\[Test Runner Feedback\]/);
    assert.match(args.instructions, /\[\/Test Runner Feedback\]/);
    assert.ok(args.instructions.includes(feedback));
    assert.doesNotMatch(args.instructions, /\[Accepted Verification\]/);
  });
});

describe('testRunnerAgentArgs', () => {
  it('injects [Code Writer Output] and JSON verdict instructions; no name', () => {
    const ctx = {
      prompt: 'extract agents',
      cwd: '/tmp/wt',
      worktreePath: '/tmp/wt',
      branch: 'orch/slug',
      statusPath: '/tmp/.orch/slug/status.md',
      codeWriterOutput: 'moved factories under agents/',
    };
    const args = testRunnerAgentArgs(ctx);

    assertAgentArgsShape(args, { expectName: false });
    assert.equal(args.options.cwd, ctx.cwd);
    assert.ok(args.instructions.includes(ctx.worktreePath));
    assert.ok(args.instructions.includes(ctx.branch));
    assert.ok(args.instructions.includes(ctx.statusPath));
    assert.match(args.instructions, /Test Runner Agent/);
    assert.match(args.instructions, /\[Code Writer Output\]/);
    assert.match(args.instructions, /\[\/Code Writer Output\]/);
    assert.ok(args.instructions.includes(ctx.codeWriterOutput));
    assert.match(args.instructions, /"passed"/);
    assert.match(args.instructions, /Do not edit production code or tests/i);
  });
});

describe('agents/ layout constraints', () => {
  it('does not place Agent subclasses or lib/agent*.js under agents/', () => {
    const agentsDir = path.join(repoRoot, 'agents');
    assert.ok(fs.existsSync(agentsDir), 'expected top-level agents/ directory');
    const entries = fs.readdirSync(agentsDir);
    assert.ok(!entries.includes('agent.js'));
    assert.ok(!entries.some((e) => e.startsWith('agent-')));
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(agentsDir, entry), 'utf8');
      assert.doesNotMatch(src, /extends\s+Agent\b/);
      assert.doesNotMatch(src, /class\s+\w*Agent\b/);
    }
  });

  it('exposes the nine role factory modules at repo root agents/', () => {
    for (const file of [
      'ask.js',
      'triage.js',
      'quick-fix.js',
      'research.js',
      'planner.js',
      'test-writer.js',
      'test-critic.js',
      'code-writer.js',
      'test-runner.js',
    ]) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, 'agents', file)),
        `missing agents/${file}`,
      );
    }
  });
});

describe('main.js factory wiring (extract complete)', () => {
  const ROLE_INSTRUCTION_MARKERS = [
    'You are an Ask Agent',
    'You are a Triage Agent',
    'You are a Quick Fix Agent',
    'You are a Research Agent',
    'You are a Planner Agent',
    'You are a Test Writer Agent',
    'You are a Test Critic Agent',
    'You are a Code Writer Agent',
    'You are a Test Runner Agent',
  ];

  const FACTORY_IMPORTS = [
    ['askAgentArgs', 'ask.js'],
    ['triageAgentArgs', 'triage.js'],
    ['quickFixAgentArgs', 'quick-fix.js'],
    ['researchAgentArgs', 'research.js'],
    ['plannerAgentArgs', 'planner.js'],
    ['testWriterAgentArgs', 'test-writer.js'],
    ['testCriticAgentArgs', 'test-critic.js'],
    ['codeWriterAgentArgs', 'code-writer.js'],
    ['testRunnerAgentArgs', 'test-runner.js'],
  ];

  it('imports agents/* factories and drops inlined role instruction blocks', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');

    for (const [exportName, file] of FACTORY_IMPORTS) {
      assert.match(
        src,
        new RegExp(
          `import\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*['"]\\.\\/agents\\/${file.replace('.', '\\.')}['"]`,
        ),
        `main.js must import { ${exportName} } from './agents/${file}'`,
      );
      assert.match(
        src,
        new RegExp(`\\b${exportName}\\s*\\(`),
        `main.js must call ${exportName}(...)`,
      );
    }

    for (const marker of ROLE_INSTRUCTION_MARKERS) {
      assert.doesNotMatch(
        src,
        new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `main.js must not keep inlined instructions containing "${marker}"`,
      );
    }
  });

  it('keeps roundLabel(...) at call sites for implementer agent names', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
    assert.match(src, /function\s+roundLabel\s*\(/);
    for (const role of ['test-writer', 'test-critic', 'code-writer', 'test-runner']) {
      assert.match(
        src,
        new RegExp(`roundLabel\\(\\s*['"]${role}['"]`),
        `main.js must pass roundLabel('${role}', ...) at the AgentClass call site`,
      );
    }
  });
});
