import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJob, readJob, jobPaths } from '../lib/jobs.js';
import {
  validateResume,
  reopenForResume,
  runRecover,
} from '../lib/resume.js';
import { formatStatus, runResumePipeline } from '../main.js';
import { writeConfig, localConfigPath } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, '..', 'main.js');

function makeTmpCwd(prefix = 'orch-resume-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pinLocalBranchPrefix(cwd, prefix = 'long_running_session') {
  writeConfig(localConfigPath(cwd), { branchPrefix: prefix });
  return prefix;
}

function runCli(args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function baseRecord(overrides = {}) {
  const slug = overrides.slug ?? 'fuzzy-forest-56d5';
  const now = overrides.startedAt ?? new Date().toISOString();
  return {
    slug,
    task: 'setup playwright and shadcn/ui',
    agent: 'claude',
    maxRounds: 5,
    cwd: '/tmp/wherever',
    pauseRequested: false,
    branch: null,
    worktree: null,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    logPath: `/tmp/wherever/.orch/${slug}/orch.log`,
    pid: process.pid,
    state: 'running',
    phase: null,
    stage: null,
    round: null,
    parent: null,
    role: null,
    workerId: null,
    ...overrides,
  };
}

function seedStoppedJob(cwd, overrides = {}) {
  const slug = overrides.slug ?? 'fuzzy-forest-56d5';
  const worktreeSpecified = Object.prototype.hasOwnProperty.call(overrides, 'worktree');
  const worktreePath = worktreeSpecified
    ? overrides.worktree
    : path.join(path.dirname(cwd), `${path.basename(cwd)}-${slug}`);
  if (!worktreeSpecified && worktreePath) {
    fs.mkdirSync(worktreePath, { recursive: true });
  }
  const finishedAt = new Date().toISOString();
  const record = baseRecord({
    slug,
    state: 'stopped',
    phase: 'test-loop',
    stage: 'test-writer',
    round: 1,
    finishedAt,
    exitCode: 130,
    branch: `orch/${slug}`,
    worktree: worktreePath,
    lastOutcome: {
      state: 'stopped',
      phase: 'test-loop',
      stage: 'test-writer',
      round: 1,
      exitCode: 130,
      finishedAt,
      task: 'setup playwright and shadcn/ui',
      summary: '',
      error: `see .orch/${slug}/failure.log`,
    },
    ...overrides,
  });
  writeJob(cwd, slug, record);

  const dir = jobPaths(cwd, slug).dir;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'research.md'))) {
    fs.writeFileSync(path.join(dir, 'research.md'), '# Research\n\ndone\n');
  }
  if (!fs.existsSync(path.join(dir, 'task.md'))) {
    fs.writeFileSync(path.join(dir, 'task.md'), '# Task\n\n- [ ] do it\n');
  }
  if (!fs.existsSync(path.join(dir, 'status.md'))) {
    fs.writeFileSync(path.join(dir, 'status.md'), `# Status\n\n- Slug: \`${slug}\`\n`);
  }
  if (!fs.existsSync(path.join(dir, 'failure.log'))) {
    fs.writeFileSync(
      path.join(dir, 'failure.log'),
      `=== orch failure ===\nslug:       ${slug}\nstate:      stopped\nerror:      SIGINT\n\n=== stage verbose (test-writer) ===\ninterrupted\n`,
    );
  }
  return { slug, worktreePath, record };
}

const SUMMARY_DELIM = '<<<SUMMARY>>>';
function withSummary(content, summary) {
  return `${content}\n\n${SUMMARY_DELIM}\n${summary}`;
}

function agentRole(name) {
  return String(name).replace(/\s+\d+\/\d+$/, '');
}

function createMockAgentClass(behaviors) {
  const instances = [];
  const queues = {};
  class MockAgent {
    constructor(name, instructions, prompt, options) {
      this.name = name;
      this.instructions = instructions;
      this.prompt = prompt;
      this.options = options;
      instances.push(this);
    }
    async run() {
      const role = agentRole(this.name);
      const behavior = behaviors[role];
      if (typeof behavior === 'function') return behavior(this);
      if (Array.isArray(behavior)) {
        queues[role] = queues[role] ?? 0;
        const attempt = behavior[Math.min(queues[role], behavior.length - 1)];
        queues[role] += 1;
        return typeof attempt === 'function' ? attempt(this) : attempt;
      }
      if (!behavior) {
        throw new Error(`MockAgent: no scripted behavior for role "${role}"`);
      }
      return behavior;
    }
  }
  MockAgent.instances = instances;
  return MockAgent;
}

const PASS_CRITIC = {
  ok: true,
  result: withSummary(JSON.stringify({ passed: true, summary: 'tests adequate' }), 'critic ok'),
};
const PASS_RUNNER = {
  ok: true,
  result: withSummary(JSON.stringify({ passed: true, summary: 'suite green' }), 'runner ok'),
};

function resumePassBehaviors(overrides = {}) {
  return {
    'test-writer': { ok: true, result: withSummary('tests written', 'wrote tests') },
    'test-critic': PASS_CRITIC,
    'code-writer': { ok: true, result: withSummary('code written', 'wrote code') },
    'test-runner': PASS_RUNNER,
    research: { ok: true, result: withSummary('research', 'researched') },
    planner: { ok: true, result: withSummary('plan', 'planned') },
    ...overrides,
  };
}

describe('validateResume — eligibility gate', () => {
  it('throws unknown run for missing slug', () => {
    const cwd = makeTmpCwd();
    assert.throws(() => validateResume(cwd, 'nobody-here-0000'), /^unknown run nobody-here-0000$/);
  });

  it('rejects --ask and --quick', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd);
    assert.throws(() => validateResume(cwd, slug, { ask: true }), /--ask/);
    assert.throws(() => validateResume(cwd, slug, { quick: true }), /--quick/);
  });

  it('paused → unpause mode', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, {
      state: 'paused',
      pauseRequested: true,
      finishedAt: null,
      exitCode: null,
      lastOutcome: null,
    });
    const result = validateResume(cwd, slug);
    assert.equal(result.mode, 'unpause');
  });

  it('running → noop mode', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, {
      state: 'running',
      finishedAt: null,
      exitCode: null,
      lastOutcome: null,
    });
    const result = validateResume(cwd, slug);
    assert.equal(result.mode, 'noop');
  });

  it('done → refuse with continue hint', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, { state: 'done', exitCode: 0 });
    assert.throws(
      () => validateResume(cwd, slug),
      /nothing to resume[\s\S]*orch continue/,
    );
  });

  for (const state of ['failed', 'stopped', 'crashed']) {
    it(`${state} with worktree → failure mode`, () => {
      const cwd = makeTmpCwd();
      const { slug } = seedStoppedJob(cwd, { state });
      const result = validateResume(cwd, slug);
      assert.equal(result.mode, 'failure');
      assert.equal(result.record.slug, slug);
    });
  }

  it('refuses missing worktree', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, { worktree: null, branch: null });
    assert.throws(() => validateResume(cwd, slug), /no worktree/);
  });

  it('refuses coordinator terminal resume', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, { role: 'coordinator' });
    assert.throws(() => validateResume(cwd, slug), /cannot resume coordinator/);
  });

  it('refuses integration terminal resume', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, { role: 'integration', parent: 'parent-slug-0000' });
    assert.throws(() => validateResume(cwd, slug), /orch --integrate parent-slug-0000/);
  });

  it('allows worker terminal failure', () => {
    const cwd = makeTmpCwd();
    const { slug } = seedStoppedJob(cwd, {
      role: 'worker',
      parent: 'parent-slug-0000',
      workerId: '01-unit',
    });
    const result = validateResume(cwd, slug);
    assert.equal(result.mode, 'failure');
  });
});

describe('reopenForResume', () => {
  it('restores phase/stage/round from prior (not research reset) and appends resumes[]', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedStoppedJob(cwd);
    const prior = record.lastOutcome;
    const updated = reopenForResume(cwd, slug, {
      pid: 99999,
      prior,
      agent: 'claude',
      maxRounds: 5,
    });
    assert.equal(updated.state, 'running');
    assert.equal(updated.phase, 'test-loop');
    assert.equal(updated.stage, 'test-writer');
    assert.equal(updated.round, 1);
    assert.equal(updated.finishedAt, null);
    assert.equal(updated.exitCode, null);
    assert.equal(updated.lastOutcome, null);
    assert.equal(updated.pauseRequested, false);
    assert.equal(updated.resumeCount, 1);
    assert.equal(updated.resumes.length, 1);
    assert.equal(updated.resumes[0].prior.stage, 'test-writer');
    assert.equal(updated.pid, 99999);
    // Same slug — no new directory.
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.orch')).filter((n) => !n.startsWith('.')), [slug]);
  });
});

describe('runRecover', () => {
  it('writes recover.md and returns one-liner mentioning failure.log when present', () => {
    const cwd = makeTmpCwd();
    const { slug, worktreePath, record } = seedStoppedJob(cwd);
    const recovered = runRecover(cwd, slug, {
      prior: record.lastOutcome,
      worktreePath,
    });
    assert.match(recovered.oneLiner, /stopped at test-writer/);
    assert.ok(fs.existsSync(recovered.recoverPath));
    const body = fs.readFileSync(recovered.recoverPath, 'utf8');
    assert.match(body, /failure\.log/);
    assert.match(body, /task\.md: present/);
    assert.match(recovered.brief, /\[Recover brief\]/);
  });
});

describe('formatStatus — next hints', () => {
  it('terminal failure → next: orch resume', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedStoppedJob(cwd);
    const out = formatStatus(cwd, record);
    assert.match(out, new RegExp(`next:\\s+orch resume ${slug}`));
  });

  for (const state of ['failed', 'stopped', 'crashed']) {
    it(`terminal failure (${state}) → next hint still leads with "orch resume <slug>" but also mentions "orch continue <slug>" as the exhausted-loop-recovery alternative (issue #11)`, () => {
      const cwd = makeTmpCwd();
      const { slug, record } = seedStoppedJob(cwd, { state });
      const out = formatStatus(cwd, record);
      assert.match(out, new RegExp(`next:\\s+orch resume ${slug}`));
      assert.match(out, new RegExp(`orch continue ${slug}`));
    });
  }

  it('done → next: orch continue', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedStoppedJob(cwd, { state: 'done', exitCode: 0 });
    const out = formatStatus(cwd, record);
    assert.match(out, new RegExp(`next:\\s+orch continue ${slug}`));
  });

  it('paused → next: orch resume', () => {
    const cwd = makeTmpCwd();
    const { slug, record } = seedStoppedJob(cwd, {
      state: 'paused',
      pauseRequested: true,
      finishedAt: null,
      exitCode: null,
      lastOutcome: null,
    });
    const out = formatStatus(cwd, record);
    assert.match(out, new RegExp(`next:\\s+orch resume ${slug}`));
  });
});

describe('runResumePipeline — reentry without research', () => {
  it('test-loop cursor: recover brief injected; research/planner not invoked; starts test-writer', async () => {
    const cwd = makeTmpCwd();
    const { slug, worktreePath, record } = seedStoppedJob(cwd);
    const names = [];
    const MockAgentClass = createMockAgentClass(resumePassBehaviors({
      'test-writer': (agent) => {
        names.push(agentRole(agent.name));
        assert.match(agent.prompt, /Recover brief|Orientation/);
        return { ok: true, result: withSummary('tests written', 'wrote tests') };
      },
      'test-critic': (agent) => {
        names.push(agentRole(agent.name));
        return PASS_CRITIC;
      },
      'code-writer': (agent) => {
        names.push(agentRole(agent.name));
        return { ok: true, result: withSummary('code written', 'wrote code') };
      },
      'test-runner': (agent) => {
        names.push(agentRole(agent.name));
        return PASS_RUNNER;
      },
      research: () => {
        names.push('research');
        return { ok: true, result: withSummary('research', 'researched') };
      },
      planner: () => {
        names.push('planner');
        return { ok: true, result: withSummary('plan', 'planned') };
      },
    }));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runResumePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        jobSlug: slug,
        worktreePath,
        branch: `orch/${slug}`,
        priorOutcome: record.lastOutcome,
        recoverBrief: '[Recover brief]\n- Orientation: stopped at test-writer round 1\n[/Recover brief]',
        prompt: record.task,
        commitWorktree: async () => ({ committed: false, branch: `orch/${slug}`, sha: null }),
        collectWorktreeChanges: async () => [],
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(!names.includes('research'), `research should be skipped; got ${names.join(',')}`);
    assert.ok(!names.includes('planner'), `planner should be skipped; got ${names.join(',')}`);
    assert.equal(names[0], 'test-writer');
    assert.ok(names.includes('test-critic'));
    assert.ok(names.includes('code-writer'));
    assert.equal(readJob(cwd, slug).state, 'done');
  });

  it('code-loop / test-runner round 2: skips test-loop; starts at code loop round 2', async () => {
    const cwd = makeTmpCwd();
    const finishedAt = new Date().toISOString();
    const { slug, worktreePath } = seedStoppedJob(cwd, {
      state: 'failed',
      phase: 'code-loop',
      stage: 'test-runner',
      round: 2,
      exitCode: 1,
      lastOutcome: {
        state: 'failed',
        phase: 'code-loop',
        stage: 'test-runner',
        round: 2,
        exitCode: 1,
        finishedAt,
        task: 'setup playwright and shadcn/ui',
        summary: '',
        error: 'see .orch/fuzzy-forest-56d5/failure.log',
      },
    });

    const names = [];
    const rounds = [];
    const MockAgentClass = createMockAgentClass(resumePassBehaviors({
      'test-runner': (agent) => {
        names.push(agentRole(agent.name));
        rounds.push(String(agent.name));
        return PASS_RUNNER;
      },
      'code-writer': (agent) => {
        names.push(agentRole(agent.name));
        return { ok: true, result: withSummary('code', 'wrote') };
      },
      'test-writer': () => {
        names.push('test-writer');
        return { ok: true, result: withSummary('tests', 'wrote') };
      },
      research: () => {
        names.push('research');
        return { ok: true, result: withSummary('r', 'r') };
      },
    }));

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runResumePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        jobSlug: slug,
        worktreePath,
        branch: `orch/${slug}`,
        priorOutcome: readJob(cwd, slug).lastOutcome,
        recoverBrief: '[Recover brief]\n[/Recover brief]',
        prompt: 'setup playwright and shadcn/ui',
        commitWorktree: async () => ({ committed: false, branch: `orch/${slug}`, sha: null }),
        collectWorktreeChanges: async () => [],
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.ok(!names.includes('test-writer'));
    assert.ok(!names.includes('research'));
    assert.equal(names[0], 'test-runner');
    assert.match(rounds[0], /2\/5/);
  });
});

describe('runResumePipeline — worktree ensure-when-missing', () => {
  it('createWorktree receives the pinned local branchPrefix when the recorded worktree is missing', async () => {
    const cwd = makeTmpCwd();
    const prefix = pinLocalBranchPrefix(cwd);
    const { slug } = seedStoppedJob(cwd, {
      worktree: null,
      branch: null,
      phase: 'worktree',
      stage: 'worktree',
      round: null,
    });
    const createWorktreeMock = mock.fn(() => ({
      worktreePath: path.join(cwd, `wt-${slug}`),
      branch: `orch/${slug}`,
    }));
    const MockAgentClass = createMockAgentClass(resumePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runResumePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        jobSlug: slug,
        jobCwd: cwd,
        priorOutcome: readJob(cwd, slug).lastOutcome,
        recoverBrief: '[Recover brief]\n[/Recover brief]',
        prompt: 'setup playwright and shadcn/ui',
        createWorktree: createWorktreeMock,
        commitWorktree: async () => ({ committed: false, branch: `orch/${slug}`, sha: null }),
        collectWorktreeChanges: async () => [],
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(createWorktreeMock.mock.calls.length, 1);
    assert.equal(createWorktreeMock.mock.calls[0].arguments[0].cwd, cwd);
    assert.equal(createWorktreeMock.mock.calls[0].arguments[0].slug, slug);
    assert.equal(createWorktreeMock.mock.calls[0].arguments[0].branchPrefix, prefix);
  });

  it('reuses run.json.branch when the worktree exists and does not call createWorktree', async () => {
    const cwd = makeTmpCwd();
    pinLocalBranchPrefix(cwd);
    const { slug, worktreePath, record } = seedStoppedJob(cwd);
    const priorBranch = record.branch;
    const createWorktreeMock = mock.fn(() => {
      throw new Error('createWorktree must not run on resume reuse');
    });
    const MockAgentClass = createMockAgentClass(resumePassBehaviors());

    const logSpy = mock.method(console, 'log', () => {});
    try {
      await runResumePipeline({
        agent: 'claude',
        AgentClass: MockAgentClass,
        cwd,
        slug,
        jobSlug: slug,
        jobCwd: cwd,
        worktreePath,
        branch: priorBranch,
        priorOutcome: record.lastOutcome,
        recoverBrief: '[Recover brief]\n[/Recover brief]',
        prompt: record.task,
        createWorktree: createWorktreeMock,
        commitWorktree: async () => ({ committed: false, branch: priorBranch, sha: null }),
        collectWorktreeChanges: async () => [],
      });
    } finally {
      logSpy.mock.restore();
    }

    assert.equal(createWorktreeMock.mock.calls.length, 0);
    assert.equal(readJob(cwd, slug).branch, priorBranch);
  });
});

describe('orch resume CLI', () => {
  it('continue on stopped is accepted (issue #11: no longer refused with a resume-only hint)', async () => {
    const cwd = makeTmpCwd();
    const { slug, record: before } = seedStoppedJob(cwd);
    const { code, stderr } = await runCli(['continue', slug, 'same task again', '--dry-run', '--agent', 'claude'], { cwd });
    assert.equal(code, 0, stderr);
    assert.deepEqual(readJob(cwd, slug), before);
  });

  it('resume --dry-run on stopped exits 0 without reopen', async () => {
    const cwd = makeTmpCwd();
    const { slug, record: before } = seedStoppedJob(cwd);
    const { code, stdout } = await runCli(['resume', slug, '--dry-run', '--agent', 'claude'], { cwd });
    assert.equal(code, 0);
    assert.match(stdout, /dry-run: resume/);
    assert.deepEqual(readJob(cwd, slug), before);
  });
});
