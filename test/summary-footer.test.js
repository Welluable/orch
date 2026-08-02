import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { askAgentArgs } from '../agents/ask.js';
import { triageAgentArgs } from '../agents/triage.js';
import { quickFixAgentArgs } from '../agents/quick-fix.js';
import { researchAgentArgs } from '../agents/research.js';
import { plannerAgentArgs } from '../agents/planner.js';
import { testWriterAgentArgs } from '../agents/test-writer.js';
import { testCriticAgentArgs } from '../agents/test-critic.js';
import { codeWriterAgentArgs } from '../agents/code-writer.js';
import { testRunnerAgentArgs } from '../agents/test-runner.js';
import { boundariesAgentArgs } from '../agents/boundaries.js';
import { decomposerAgentArgs } from '../agents/decomposer.js';
import { integratorAgentArgs } from '../agents/integrator.js';
import { adjustAgentArgs } from '../agents/adjust.js';
import { seqDecomposerAgentArgs } from '../agents/seq-decomposer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const footerPath = path.join(__dirname, '..', 'agents', 'summary-footer.js');

async function loadFooter() {
  assert.ok(fs.existsSync(footerPath), `expected ${footerPath} to exist`);
  return import(pathToFileURL(footerPath).href);
}

describe('summaryTrailerInstructions', () => {
  it('exports a helper with literal <<<SUMMARY>>>, MUST/required framing, and a shape example', async () => {
    const { summaryTrailerInstructions } = await loadFooter();
    assert.equal(typeof summaryTrailerInstructions, 'function');

    const text = summaryTrailerInstructions({ before: 'required stage output' });
    assert.match(text, /<<<SUMMARY>>>/);
    assert.match(text, /\bMUST\b|\brequired\b|\binvalid\b/i);
    assert.match(text, /required stage output/);
    assert.match(text, /One short paragraph of what you did and what happened/);
    assert.match(text, /no lists/i);
    assert.match(text, /code fence/i);
    // Must not spell the marker as “three '<' characters…”
    assert.doesNotMatch(text, /three\s+'<'\s+characters/i);
    assert.doesNotMatch(text, /three\s+['"]?<['"]?\s+characters/i);
  });

  it('interpolates the before clause into the shape example', async () => {
    const { summaryTrailerInstructions } = await loadFooter();
    const text = summaryTrailerInstructions({ before: 'the JSON verdict only' });
    assert.match(text, /the JSON verdict only/);
    assert.match(text, /<<<SUMMARY>>>/);
  });
});

describe('stage agents adopt the shared summary footer', () => {
  const cwd = '/tmp/repo';

  const cases = [
    ['ask', () => askAgentArgs({ prompt: 'q', cwd })],
    ['triage', () => triageAgentArgs({ prompt: 'q', cwd })],
    ['quick-fix', () => quickFixAgentArgs({ prompt: 'q', cwd })],
    [
      'research',
      () => researchAgentArgs({ prompt: 'q', cwd, researchPath: `${cwd}/research.md` }),
    ],
    [
      'planner',
      () =>
        plannerAgentArgs({
          prompt: 'q',
          cwd,
          researchPath: `${cwd}/research.md`,
          taskPath: `${cwd}/task.md`,
          researchOutput: 'findings',
        }),
    ],
    [
      'test-writer',
      () =>
        testWriterAgentArgs({
          prompt: 'q',
          cwd,
          worktreePath: cwd,
          branch: 'orch/x',
          researchPath: `${cwd}/research.md`,
          taskPath: `${cwd}/task.md`,
          statusPath: `${cwd}/status.md`,
        }),
    ],
    [
      'test-critic',
      () =>
        testCriticAgentArgs({
          prompt: 'q',
          cwd,
          worktreePath: cwd,
          branch: 'orch/x',
          researchPath: `${cwd}/research.md`,
          taskPath: `${cwd}/task.md`,
          statusPath: `${cwd}/status.md`,
          testWriterOutput: 'tests',
        }),
    ],
    [
      'code-writer',
      () =>
        codeWriterAgentArgs({
          prompt: 'q',
          cwd,
          worktreePath: cwd,
          branch: 'orch/x',
          researchPath: `${cwd}/research.md`,
          taskPath: `${cwd}/task.md`,
          statusPath: `${cwd}/status.md`,
          round: 1,
          acceptedVerification: 'npm test',
        }),
    ],
    [
      'test-runner',
      () =>
        testRunnerAgentArgs({
          prompt: 'q',
          cwd,
          worktreePath: cwd,
          branch: 'orch/x',
          researchPath: `${cwd}/research.md`,
          statusPath: `${cwd}/status.md`,
          codeWriterOutput: 'done',
        }),
    ],
    [
      'boundaries',
      () =>
        boundariesAgentArgs({
          prompt: 'q',
          cwd,
          boundariesPath: `${cwd}/boundaries.md`,
        }),
    ],
    [
      'decomposer',
      () =>
        decomposerAgentArgs({
          prompt: 'q',
          cwd,
          boundariesOutput: 'bounds',
          maxWorkers: 4,
        }),
    ],
    [
      'integrator',
      () =>
        integratorAgentArgs({
          prompt: 'q',
          cwd,
          conflictedFiles: ['a.js'],
          mergeOutput: 'CONFLICT',
          involvedWorkers: [{ subtask: 's', area: 'a' }],
        }),
    ],
    [
      'adjust',
      () =>
        adjustAgentArgs({
          originalTask: 'task',
          doneUnits: [],
          pendingUnits: [{ id: '01', title: 't', subtask: 's' }],
          tip: 'abc',
          cwd,
          maxUnits: 6,
        }),
    ],
    [
      'seq-decomposer',
      () => seqDecomposerAgentArgs({ prompt: 'q', cwd, maxUnits: 6 }),
    ],
  ];

  for (const [role, build] of cases) {
    it(`${role} instructions include the literal <<<SUMMARY>>> marker via the shared footer`, () => {
      const { instructions } = build();
      assert.match(instructions, /<<<SUMMARY>>>/);
      assert.match(instructions, /\bMUST\b|\brequired\b|\binvalid\b/i);
      assert.match(instructions, /One short paragraph of what you did and what happened|one short paragraph/i);
      assert.doesNotMatch(instructions, /three\s+'<'\s+characters/i);
    });
  }
});
