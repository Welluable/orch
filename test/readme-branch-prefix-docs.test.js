import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Unit 06-docs: README Config/Artifacts + `--help` branch-prefix copy.
 *
 * Docs-only — does **not** retest `orch config --help` listing `--branch-prefix`
 * (that lives in test/config.test.js) and does not retest createWorktree /
 * resolveBranchPrefix / merge wiring (04/05).
 *
 * Formula: branch names are `<prefix>/<slug>` (default prefix `orch`).
 * Job dirs stay `.orch/<slug>/`; worktree path stays
 * `<parent-of-repo>/<repo-name>-<slug>`. Concrete default-prefix samples
 * (`orch/verbose-flag-x7q2`, `orch/wise-pine-e904`) stay literal.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const mainPath = path.join(root, 'main.js');

const SPEC_PREFIX_EXAMPLES = [
  'orch config --branch-prefix long_running_session',
  'orch config --branch-prefix long_running_session --local',
  'orch config --branch-prefix orch',
];

function readme() {
  assert.ok(fs.existsSync(readmePath), 'expected README.md at repo root');
  return fs.readFileSync(readmePath, 'utf8');
}

function mainJs() {
  assert.ok(fs.existsSync(mainPath), 'expected main.js at repo root');
  return fs.readFileSync(mainPath, 'utf8');
}

/** Slice from `## heading` through the next `## ` (or EOF). */
function section(md, heading) {
  return sliceAtHeading(md, heading, '##');
}

/** Slice from `### heading` through the next `##`/`###` (or EOF). */
function subsection(md, heading) {
  return sliceAtHeading(md, heading, '###');
}

function sliceAtHeading(md, heading, marker) {
  const startRe = new RegExp(`^${marker} ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const start = md.search(startRe);
  assert.ok(start >= 0, `expected ${marker} ${heading} in README`);
  const rest = md.slice(start);
  // Skip the heading line so `### Foo` is not mistaken for a following `## `
  // (slice(1) would turn `###` into `##` and cut the section to a single `#`).
  const firstNl = rest.indexOf('\n');
  const afterHeading = firstNl === -1 ? '' : rest.slice(firstNl + 1);
  const nextH2 = afterHeading.search(/^## /m);
  const nextH3 = marker === '###' ? afterHeading.search(/^### /m) : -1;
  const relatives = [nextH3, nextH2].filter((n) => n >= 0);
  if (relatives.length === 0) return rest;
  return rest.slice(0, firstNl + 1 + Math.min(...relatives));
}

function configBlock(md) {
  const cli = section(md, 'CLI Reference');
  // Stop at Skill: (new) or Job-control so a Skill block is not swallowed into Config.
  const match = cli.match(/^Config:\s*\n([\s\S]*?)(?=^(?:Skill:|Job-control))/m);
  assert.ok(match, 'expected Config: block before Skill: or Job-control in CLI Reference');
  return match[1];
}

function skillBlock(md) {
  const cli = section(md, 'CLI Reference');
  const match = cli.match(/^Skill:\s*\n([\s\S]*?)(?=^Job-control)/m);
  assert.ok(match, 'expected Skill: block after Config: and before Job-control in CLI Reference');
  return match[1];
}

function cliExamplesBash(md) {
  const cli = section(md, 'CLI Reference');
  const examples = cli.match(/Examples:\s*\n+```bash\n([\s\S]*?)```/);
  assert.ok(examples, 'CLI Reference must keep a fenced bash Examples block');
  return examples[1];
}

function addHelpTextBlock(src) {
  const match = src.match(/\.addHelpText\(\s*'after',\s*`([\s\S]*?)`\s*\)/);
  assert.ok(match, 'expected program.addHelpText after-examples block in main.js');
  return match[1];
}

function prOptionHelp(src) {
  const match = src.match(/\.option\(\s*'--pr',\s*'([^']*)'\s*\)/);
  assert.ok(match, 'expected .option(--pr, …) help string in main.js');
  return match[1];
}

/** `orch/<slug>` that is not the job-dir form `.orch/<slug>`. */
function leftoverBranchFormula(text) {
  return [...text.matchAll(/(?<!\.)orch\/<slug>/g)].map((m) => m[0]);
}

/** `orch/<parent-slug>` that is not the job-dir form `.orch/<parent-slug>`. */
function leftoverParentFormula(text) {
  return [...text.matchAll(/(?<!\.)orch\/<parent-slug>/g)].map((m) => m.index);
}

describe('06-docs README Config / Artifacts branch-prefix copy', () => {
  it('Config print line names branchPrefix; --branch-prefix bullets follow notify', () => {
    const cfg = configBlock(readme());

    assert.match(
      cfg,
      /orch config`?\s*—\s*prints the effective[\s\S]{0,160}branchPrefix/i,
      'orch config print line must name branchPrefix alongside agent/notify',
    );
    assert.match(cfg, /agent/i);
    assert.match(cfg, /notify/i);

    const notifyAt = cfg.search(/orch config --notify/);
    const prefixAt = cfg.search(/orch config --branch-prefix|--branch-prefix/);
    assert.ok(notifyAt >= 0, 'Config must keep the notify bullet');
    assert.ok(prefixAt >= 0, 'Config must document --branch-prefix after notify');
    assert.ok(
      prefixAt > notifyAt,
      '--branch-prefix bullets must come after the notify bullet',
    );

    const prefixDocs = cfg.slice(prefixAt);
    assert.match(
      prefixDocs,
      /--branch-prefix[\s\S]{0,400}~\/\.orch\/config/,
      'pin global must name ~/.orch/config',
    );
    assert.match(
      prefixDocs,
      /--branch-prefix[\s\S]{0,400}--local/,
      'must document pinning with --local',
    );
    assert.match(
      prefixDocs,
      /--branch-prefix orch/,
      'must document restoring the builtin with --branch-prefix orch',
    );
    assert.match(
      prefixDocs,
      /keys merge|without wiping|must not wipe/i,
      'keys must merge on write (must not wipe agent/notify)',
    );
    assert.match(
      prefixDocs,
      /agent/,
      'merge blurb must mention agent',
    );
    assert.match(
      prefixDocs,
      /notify/,
      'merge blurb must mention notify',
    );
  });

  it('named formula sites use <prefix>/<slug> (default prefix orch), not hardcoded orch/<slug>', () => {
    const md = readme();
    const why = section(md, 'Why orch?');
    const how = section(md, 'How it works');
    const artifacts = subsection(md, 'Artifacts and worktrees');
    const architecture = section(md, 'Architecture');
    const modes = section(md, 'Execution modes');
    const cli = section(md, 'CLI Reference');
    const seq = section(md, 'Sequential multi-unit (`--seq`)');
    const decompose = section(md, 'Decompose (`--decompose`)');
    const structure = section(md, 'Project structure');

    assert.match(
      why,
      /Isolated implementation[\s\S]{0,200}`<prefix>\/<slug>`/,
      'Why orch Isolated implementation must say worktree on a <prefix>/<slug> branch',
    );
    assert.match(
      how,
      /Worktree[\s\S]{0,200}`<prefix>\/<slug>`/,
      'Phases Worktree must name an <prefix>/<slug> branch',
    );
    assert.match(
      how,
      /Publish[\s\S]{0,200}`<prefix>\/<slug>`/,
      'Phases Publish must push <prefix>/<slug>',
    );

    assert.match(
      artifacts,
      /<prefix>\/<slug>\s+# branch/,
      'Artifacts branch line must be <prefix>/<slug> # branch',
    );
    assert.match(
      artifacts,
      /\.orch\/<slug>\//,
      'Artifacts must keep the .orch/<slug>/ job dir',
    );
    assert.match(
      artifacts,
      /<parent-of-repo>\/<repo-name>-<slug>/,
      'Artifacts must keep the sibling worktree path',
    );

    assert.match(
      architecture,
      /<prefix>\/<slug> branch/,
      'Architecture diagram must label the <prefix>/<slug> branch',
    );
    assert.doesNotMatch(
      architecture,
      /orch\/<slug> branch/,
      'Architecture diagram must not hardcode orch/<slug> branch',
    );

    assert.match(
      modes,
      /`--pr`[\s\S]{0,200}`<prefix>\/<slug>`/,
      'Execution modes --pr row must push <prefix>/<slug>',
    );
    assert.match(
      modes,
      /push\s+`<prefix>\/<slug>` to `origin`/,
      'Pull requests must push <prefix>/<slug> to origin',
    );
    assert.match(
      modes,
      /\.orch\/<slug>\/pr\.md/,
      'Pull requests must keep .orch/<slug>/pr.md',
    );

    assert.match(
      cli,
      /`--pr`[\s\S]{0,120}push `<prefix>\/<slug>`/,
      'CLI --pr bullet must push <prefix>/<slug>',
    );
    assert.match(
      cli,
      /`--seq`[\s\S]{0,160}merges each into `<prefix>\/<slug>`/,
      'CLI --seq bullet must merge each into <prefix>/<slug>',
    );

    assert.match(
      seq,
      /merging each into `<prefix>\/<slug>`/,
      'Seq intro must merge each into <prefix>/<slug>',
    );
    assert.match(
      seq,
      /merge into\s+`<prefix>\/<parent-slug>`/,
      'Seq schedule must merge into <prefix>/<parent-slug>',
    );
    assert.match(
      seq,
      /stays on `<prefix>\/<parent-slug>`/,
      'Seq deliverable must stay on <prefix>/<parent-slug>',
    );

    assert.match(
      decompose,
      /coordinator worktree\/`<prefix>\/<slug>` branch/,
      'Decompose must name the coordinator worktree/<prefix>/<slug> branch',
    );

    assert.match(
      structure,
      /<prefix>\/<slug>\s+# branch/,
      'Project structure branch line must be <prefix>/<slug> # branch',
    );
    assert.match(
      structure,
      /\.orch\/<slug>\//,
      'Project structure must keep .orch/<slug>/',
    );
    assert.match(
      structure,
      /<parent-of-repo>\/<repo-name>-<slug>/,
      'Project structure must keep the sibling worktree path',
    );

    assert.match(
      md,
      /default prefix `?orch`?|prefix defaults to `?orch`?|default(?:s)?(?: prefix)?(?: is| to)? `?orch`?/i,
      'docs must say the default prefix is orch',
    );
  });

  it('leftover orch/<slug> is only the .orch/<slug> job-dir form', () => {
    const leftovers = leftoverBranchFormula(readme());
    assert.deepEqual(
      leftovers,
      [],
      'README formula sites must use <prefix>/<slug>; leftover orch/<slug> is only valid as .orch/<slug>/',
    );
  });

  it('leftover orch/<parent-slug> is only the fan-out Integration sample', () => {
    const md = readme();
    const fanout = section(md, 'Fan-out');
    assert.match(
      fanout,
      /committing to `orch\/<parent-slug>`/,
      'Fan-out Integration formula line is out of scope and must stay orch/<parent-slug>',
    );

    const seq = section(md, 'Sequential multi-unit (`--seq`)');
    assert.equal(
      leftoverParentFormula(seq).length,
      0,
      'Seq merge/deliverable must not still say orch/<parent-slug>',
    );

    const indexes = leftoverParentFormula(md);
    assert.equal(
      indexes.length,
      1,
      'only Fan-out Integration should keep a non-job-dir orch/<parent-slug>',
    );
  });

  it('keeps default-prefix samples, job-dir copy, and --ask --from (not --ask --continue)', () => {
    const md = readme();

    assert.match(md, /commit: a1b2c3d on orch\/verbose-flag-x7q2/);
    assert.match(md, /merged into orch\/wise-pine-e904/);
    assert.match(md, /wrote: \.orch\/wise-pine-e904\/seq\.json/);
    assert.match(md, /orch --seq --from wise-pine-e904/);
    assert.match(md, /commit: e5f6071 on orch\/wise-pine-e904/);
    assert.match(md, /git merge orch\/wise-pine-e904/);

    assert.match(md, /allocates `\.orch\/<slug>\/`/);
    assert.match(md, /`--ask --from <slug>`/);
    assert.match(md, /\.orch\/<slug>\/ask\.json/);
    assert.match(md, /\.orch\/<parent-slug>\//);
    assert.doesNotMatch(
      md,
      /--ask\s+--continue\b|--ask-continue\b/,
      'must not invent --ask --continue',
    );
  });

  it('Examples bash block adds the three spec --branch-prefix commands after config --agent', () => {
    const bash = cliExamplesBash(readme());

    assert.match(bash, /^orch config$/m);
    assert.match(bash, /^orch config --agent claude$/m);
    assert.match(bash, /^orch config --agent agn --local$/m);
    assert.match(bash, /^orch config --agent opencode$/m);

    const agentOpencode = bash.indexOf('orch config --agent opencode');
    assert.ok(agentOpencode >= 0);
    const afterAgent = bash.slice(agentOpencode);

    let cursor = 0;
    for (const cmd of SPEC_PREFIX_EXAMPLES) {
      const at = afterAgent.indexOf(cmd, cursor);
      assert.ok(at >= 0, `Examples must include \`${cmd}\` after the --agent config lines`);
      cursor = at + cmd.length;
    }
  });
});

describe('06-docs README Skill command + Quick Start', () => {
  it('CLI Reference has a Skill: block after Config: and before Job-control', () => {
    const md = readme();
    const cli = section(md, 'CLI Reference');
    const configAt = cli.search(/^Config:\s*$/m);
    const skillAt = cli.search(/^Skill:\s*$/m);
    const jobsAt = cli.search(/^Job-control /m);
    assert.ok(configAt >= 0, 'CLI Reference must keep a Config: heading');
    assert.ok(skillAt >= 0, 'CLI Reference must have a Skill: heading after Config:');
    assert.ok(jobsAt >= 0, 'CLI Reference must keep Job-control after Skill:');
    assert.ok(configAt < skillAt, 'Skill: must follow Config:');
    assert.ok(skillAt < jobsAt, 'Skill: must precede Job-control');

    const cfg = configBlock(md);
    assert.doesNotMatch(cfg, /^Skill:/m);
    assert.doesNotMatch(cfg, /orch skill\b/, 'Config: must not swallow Skill bullets');

    const skill = skillBlock(md);
    assert.match(skill, /orch skill\b/);
    assert.match(skill, /--global/);
    assert.match(skill, /--local/);
    assert.match(skill, /~\/\.agents\/skills\/orch/);
    assert.match(skill, /~\/\.claude\/skills\/orch/);
    assert.match(skill, /\.agents\/skills\/orch/);
    assert.match(skill, /\.claude\/skills\/orch/);
  });

  it('Examples bash block adds orch skill and orch skill --local after config lines', () => {
    const bash = cliExamplesBash(readme());
    assert.match(bash, /^orch skill$/m);
    assert.match(bash, /^orch skill --local$/m);

    const lastPrefix = bash.indexOf('orch config --branch-prefix orch');
    const skillAt = bash.search(/^orch skill$/m);
    const skillLocalAt = bash.search(/^orch skill --local$/m);
    assert.ok(lastPrefix >= 0);
    assert.ok(skillAt > lastPrefix, 'orch skill must follow the config examples');
    assert.ok(skillLocalAt > skillAt, 'orch skill --local must follow bare orch skill');
  });

  it('Quick Start points at orch skill right after npm install -g', () => {
    const qs = section(readme(), 'Quick Start');
    const installAt = qs.indexOf('npm install -g @welluable/orch');
    assert.ok(installAt >= 0, 'Quick Start must keep npm install -g @welluable/orch');
    const afterInstall = qs.slice(installAt);
    const nextFence = afterInstall.indexOf('```', afterInstall.indexOf('\n'));
    const afterFence = nextFence >= 0 ? afterInstall.slice(nextFence) : afterInstall;
    const firstTask = afterFence.search(/orch "/);
    const window = firstTask >= 0 ? afterFence.slice(0, firstTask) : afterFence;
    assert.match(
      window,
      /orch skill\b/,
      'Quick Start must mention orch skill in a sentence after npm install -g and before the first orch "<task>" example',
    );
  });
});

describe('06-docs main.js --pr help and addHelpText config examples', () => {
  it('--pr option help uses <prefix>/<slug>, not orch/<slug>', () => {
    const src = mainJs();
    const help = prOptionHelp(src);
    assert.match(
      help,
      /push <prefix>\/<slug>/,
      '--pr help must push <prefix>/<slug>',
    );
    assert.doesNotMatch(
      help,
      /push orch\/<slug>/,
      '--pr help must not hardcode orch/<slug>',
    );
    assert.equal(
      leftoverBranchFormula(src).length,
      0,
      'main.js must not keep a leftover orch/<slug> (the --pr help string was the remaining one)',
    );
  });

  it('addHelpText config examples include the three spec --branch-prefix commands after --agent', () => {
    const block = addHelpTextBlock(mainJs());

    assert.match(block, /\$ orch config\s+# print effective agent/);
    assert.match(block, /\$ orch config --agent claude/);
    assert.match(block, /\$ orch config --agent agn --local/);
    assert.match(block, /\$ orch config --agent opencode/);

    const afterAgent = block.slice(block.indexOf('$ orch config --agent opencode'));
    let cursor = 0;
    for (const cmd of SPEC_PREFIX_EXAMPLES) {
      const at = afterAgent.indexOf(cmd, cursor);
      assert.ok(
        at >= 0,
        `addHelpText Examples must include \`${cmd}\` after the --agent config lines`,
      );
      cursor = at + cmd.length;
    }

    const headlessAt = afterAgent.search(/Headless runs:/);
    const firstPrefix = afterAgent.indexOf(SPEC_PREFIX_EXAMPLES[0]);
    assert.ok(headlessAt < 0 || firstPrefix < headlessAt,
      '--branch-prefix examples must sit with the other orch config lines, before Headless runs');
  });

  it('addHelpText includes orch skill / orch skill --local with the config examples', () => {
    const block = addHelpTextBlock(mainJs());
    assert.match(block, /\$ orch skill\b/);
    assert.match(block, /\$ orch skill --local\b/);

    const lastConfig = block.indexOf('$ orch config --branch-prefix orch');
    const skillAt = block.search(/\$ orch skill\b/);
    const skillLocalAt = block.indexOf('$ orch skill --local');
    const headlessAt = block.search(/Headless runs:/);
    assert.ok(lastConfig >= 0, 'expected the builtin-prefix config example as an anchor');
    assert.ok(skillAt >= 0, 'expected `$ orch skill` in addHelpText');
    assert.ok(
      skillAt > lastConfig,
      'orch skill examples must follow the orch config examples',
    );
    assert.ok(
      skillLocalAt > skillAt,
      '`$ orch skill --local` must follow bare `$ orch skill`',
    );
    assert.ok(
      headlessAt < 0 || skillLocalAt < headlessAt,
      'orch skill examples must sit with config examples, before Headless runs',
    );
  });

  it('leaves config .description and --branch-prefix option wiring alone', () => {
    const src = mainJs();
    assert.match(
      src,
      /\.command\('config'\)\s*\n\s*\.description\('Print or set default agent \/ notify/,
      'config .description must stay agent / notify (do not retitle it for this unit)',
    );
    assert.match(
      src,
      /\.option\('--branch-prefix <ns>', 'Set the default git branch prefix'\)/,
      'config --branch-prefix option wiring from 02 must stay',
    );
  });
});
