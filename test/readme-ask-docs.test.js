import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Unit 06-tests-docs: README contract for ask continue + product Ask chat.
 *
 * Docs-only — does **not** retest CLI `--ask --from` behavior, serve ask API
 * semantics, or UI multiturn (those live in test/main.test.js,
 * test/headless.test.js, test/ask-session.test.js, test/serve.test.js,
 * test/ui-product-ask.test.js).
 *
 * Naming: document `orch --ask --from <slug>`, never invent `--ask --continue`.
 * Keep write-pipeline `orch continue` and `--seq --from` clearly distinct.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');

function readme() {
  assert.ok(fs.existsSync(readmePath), 'expected README.md at repo root');
  return fs.readFileSync(readmePath, 'utf8');
}

/** Slice from `## heading` through the next `## ` (or EOF). */
function section(md, heading) {
  const startRe = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const start = md.search(startRe);
  assert.ok(start >= 0, `expected ## ${heading} in README`);
  const rest = md.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('06-tests-docs README ask continue + product Ask chat', () => {
  it('documents orch --ask --from <slug> as same-session read-only ask continue (not --ask --continue)', () => {
    const md = readme();

    assert.match(
      md,
      /orch --ask --from <slug>/,
      'README must show orch --ask --from <slug> (angle-bracket slug form)',
    );
    assert.match(
      md,
      /--ask --from/,
      'README must name the flag pair --ask --from',
    );
    assert.match(
      md,
      /ask\.json/,
      'README must mention ask.json as the ask-session artifact',
    );
    assert.match(
      md,
      /read-only|read only/i,
      'README must frame --ask --from as read-only (same family as plain --ask)',
    );
    assert.match(
      md,
      /follow-?up|same[- ]session|continue.*ask|ask.*continue/i,
      'README must describe same-session / follow-up ask continue semantics',
    );

    // Never invent a fake flag; write-pipeline "continue" as a word elsewhere is fine.
    assert.doesNotMatch(
      md,
      /--ask\s+--continue\b|--ask-continue\b/,
      'README must not invent --ask --continue; the flag is --ask --from',
    );
  });

  it('distinguishes orch continue, --seq --from, and --ask --from', () => {
    const md = readme();

    // All three mechanisms must appear as concrete command forms.
    assert.match(md, /orch continue <slug>/);
    assert.match(md, /orch --seq --from <slug>|`--seq --from <slug>`/);
    assert.match(md, /orch --ask --from <slug>|`--ask --from <slug>`/);

    // Prefer an explicit three-way contrast (table or parallel bullets) near
    // ask continue / Execution modes / CLI Reference — not three unrelated hits.
    const contrastWindow =
      md.match(
        /(?:orch continue[\s\S]{0,1200}--seq --from[\s\S]{0,1200}--ask --from)|(?:--ask --from[\s\S]{0,1200}(?:orch continue|--seq --from)[\s\S]{0,1200}(?:orch continue|--seq --from))/,
      ) ||
      md.match(
        /(?:write[- ]pipeline|new (?:complex )?pipeline|done (?:run|worktree))[\s\S]{0,800}(?:seq\.json|seq backlog|planned)[\s\S]{0,800}(?:ask\.json|ask (?:session|follow))/i,
      );

    assert.ok(
      contrastWindow,
      'README must contrast write continue, --seq --from (seq.json), and --ask --from (ask.json) in one short table or parallel bullets',
    );

    // Purpose signals for each mechanism (loose; allow table cells or prose).
    assert.match(
      md,
      /orch continue[\s\S]{0,400}(?:new (?:complex )?pipeline|write|done)/i,
      'orch continue must stay framed as a new write pipeline on a done run/worktree',
    );
    assert.match(
      md,
      /--seq --from[\s\S]{0,400}seq\.json/,
      '--seq --from must stay tied to seq.json / planned backlog',
    );
    assert.match(
      md,
      /--ask --from[\s\S]{0,400}ask\.json/,
      '--ask --from must stay tied to ask.json follow-up',
    );
  });

  it('CLI Reference / examples: --ask --from usage, --from with --ask, incompatible flags', () => {
    const md = readme();
    const cli = section(md, 'CLI Reference');
    const examples = cli.match(/```bash([\s\S]*?)```/);
    assert.ok(examples, 'CLI Reference must keep a fenced bash Examples block');
    const bash = examples[1];

    assert.match(
      bash,
      /orch --ask\s+".*"/,
      'Examples must keep a plain orch --ask start line',
    );
    assert.match(
      bash,
      /orch --ask --from <slug>\s+"/,
      'Examples must show orch --ask --from <slug> "<follow-up>" after a start ask',
    );

    // --from blurb must cover --ask (not "--seq only").
    assert.match(
      cli,
      /--from <slug>[\s\S]{0,400}--ask/,
      'CLI Reference --from bullet must mention --ask (ask.json continue), not seq-only',
    );
    assert.match(
      cli,
      /--from <slug>[\s\S]{0,400}ask\.json|--ask[\s\S]{0,200}--from[\s\S]{0,200}ask\.json/,
      'CLI Reference must tie --ask --from to ask.json',
    );

    // Same incompatible family as plain --ask; --seq --from still rejects --ask.
    assert.match(
      md,
      /--ask --from[\s\S]{0,600}(?:--detach|--seq|--fan-out)/,
      'README must note incompatible flags for --ask --from (at least one of --detach / --seq / --fan-out near the ask-from docs)',
    );
    assert.match(
      md,
      /--seq --from[\s\S]{0,400}--ask|--ask[\s\S]{0,400}--seq --from[\s\S]{0,200}reject/i,
      'README must note that --seq --from still rejects --ask',
    );
  });

  it('Serve section documents per-product Ask chat API + UI same-session multiturn', () => {
    const md = readme();
    const serve = section(md, 'Serve (home products + mobile UI)');

    assert.match(
      serve,
      /POST\s+\/api\/products\/<product>\/ask\b|POST `?\/api\/products\/<product>\/ask`?/,
      'Serve docs must list POST /api/products/<product>/ask (start)',
    );
    assert.match(
      serve,
      /POST[\s\S]{0,80}\/api\/products\/<product>\/ask\/<slug>|POST `?\/api\/products\/<product>\/ask\/<[^>]+>`?/,
      'Serve docs must list POST …/ask/<slug> (follow-up)',
    );
    assert.match(
      serve,
      /GET[\s\S]{0,80}\/api\/products\/<product>\/ask\/<slug>|GET `?\/api\/products\/<product>\/ask\/<[^>]+>`?/,
      'Serve docs must list GET …/ask/<slug> (session)',
    );

    assert.match(
      serve,
      /--ask --from|CLI `--ask --from`|same semantics as.*--ask --from/i,
      'Serve follow-up POST must be tied to CLI --ask --from semantics',
    );
    assert.match(
      serve,
      /Ask (?:panel|chat|UI)|product Ask|same[- ]session/i,
      'Serve docs must mention the per-product UI Ask panel / same-session chat',
    );
    assert.match(
      serve,
      /multiturn|follow-?up|same[- ]session/i,
      'Serve Ask chat must be framed as same-session multiturn / follow-ups',
    );
  });

  it('Execution modes table acknowledges ask continue via --ask --from (or nearby prose)', () => {
    const md = readme();
    const modes = section(md, 'Execution modes');

    // Plain --ask row may stay; ask continue can be a row, footnote, or prose
    // immediately under the table — but --ask --from must appear in this section.
    assert.match(
      modes,
      /--ask --from/,
      'Execution modes must mention --ask --from (row, footnote, or short prose under the table)',
    );
    assert.match(
      modes,
      /ask\.json|same[- ]session|follow-?up/i,
      'Execution modes ask-from blurb must mention ask.json or same-session follow-up',
    );
  });
});
