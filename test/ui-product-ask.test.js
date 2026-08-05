import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract for unit 04-product-ask-ui (Product ask chat panel):
 *
 * - ProductScreen gains a read-only ask section-panel (question input + answer
 *   display) alongside existing Run / Jobs — not a replacement for them.
 * - First turn POSTs `{ prompt }` to `/api/products/<product>/ask` via the
 *   shared `api()` helper (prefer `prompt`; never jobs / clean / write queue).
 * - Success: render returned `answer` as plain CLI `--ask` body text
 *   (`pre` + `mono` / `.logs` style); hold returned `slug` in component state
 *   for later same-session follow-ups (unit 05 wires POST/GET …/ask/:slug).
 * - Do not implement multiturn `/ask/<slug>` POST/GET, agent picker, or
 *   README expansion here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const uiRoot = path.join(root, 'ui');

function exists(p) {
  return fs.existsSync(p);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function productScreenPath() {
  for (const p of [
    path.join(uiRoot, 'components', 'ProductScreen.tsx'),
    path.join(uiRoot, 'components', 'ProductScreen.jsx'),
    path.join(uiRoot, 'src', 'components', 'ProductScreen.tsx'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

function typesPath() {
  for (const p of [
    path.join(uiRoot, 'lib', 'types.ts'),
    path.join(uiRoot, 'src', 'lib', 'types.ts'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

/**
 * Slice a named function/const body from source (rough brace match).
 * Returns '' when the name is absent.
 */
function extractFnBody(src, name) {
  const re = new RegExp(
    `(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\([^)]*\\)\\s*\\{` +
      `|(?:const|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{`,
  );
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < src.length && depth > 0; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return src.slice(start, i - 1);
}

/** First ask submit handler body we can find by conventional names. */
function askSubmitBody(src) {
  for (const name of [
    'ask',
    'askSubmit',
    'submitAsk',
    'runAsk',
    'sendAsk',
    'onAsk',
    'handleAsk',
    'askQuestion',
  ]) {
    const body = extractFnBody(src, name);
    if (body && /\/ask/.test(body)) return body;
  }
  // Fallback: window around the start-ask POST path (not …/ask/${slug}).
  const m = src.match(
    /\/api\/products\/\$\{[^}]+\}\/ask(?!\/)[\s\S]{0,900}/,
  );
  return m ? m[0] : '';
}

describe('04-product-ask-ui ProductScreen ask panel', () => {
  it('keeps Run and Jobs panels and adds an Ask section-panel', () => {
    const p = productScreenPath();
    assert.ok(p, 'expected ProductScreen component');
    const src = read(p);

    assert.ok(
      /section-panel/.test(src),
      'ProductScreen must keep section-panel layout',
    );
    assert.ok(
      />\s*Run\s*</.test(src) || /['"`]Run['"`]/.test(src),
      'ProductScreen must keep the Run panel',
    );
    assert.ok(
      />\s*Jobs\s*</.test(src) || /['"`]Jobs['"`]/.test(src),
      'ProductScreen must keep the Jobs panel',
    );
    assert.ok(
      />\s*Ask\s*</.test(src) || /['"`]Ask['"`]/.test(src) || /<h2[^>]*>\s*Ask\s*</.test(src),
      'ProductScreen must expose a user-facing Ask section heading',
    );
    // Ask region should be a section-panel (SaaS density), not a one-off card.
    assert.ok(
      /section-panel[\s\S]{0,200}Ask|Ask[\s\S]{0,200}section-panel|>\s*Ask\s*<[\s\S]{0,80}/.test(
        src,
      ) ||
        (src.match(/section-panel/g) || []).length >= 3,
      'Ask UI must live in a section-panel alongside Run/Jobs',
    );
  });

  it('POSTs trimmed { prompt } to /api/products/:product/ask (start path only)', () => {
    const src = read(productScreenPath());

    // Start route: …/ask without a trailing /${slug} segment on the first turn.
    assert.ok(
      /\/api\/products\/\$\{[^}]+\}\/ask[`'"]/.test(src) ||
        /\/api\/products\/\$\{encodeURIComponent\([^)]+\)\}\/ask/.test(src),
      'Ask submit must POST /api/products/${encodeURIComponent(product)}/ask',
    );

    // Prefer field name `prompt` in the JSON body (API also accepts question).
    assert.ok(
      /JSON\.stringify\s*\(\s*\{\s*prompt\s*\}/.test(src) ||
        /JSON\.stringify\s*\(\s*\{[^}]*\bprompt\b/.test(src) ||
        /\{\s*prompt\s*\}/.test(src),
      'Ask POST body must include { prompt } (prefer prompt over question)',
    );

    assert.ok(
      /method\s*:\s*['"]POST['"]/.test(src) && /\/ask/.test(src),
      'Ask must use POST',
    );

    // Trim empty prompts before send (no-op or error — either is fine).
    const askBody = askSubmitBody(src);
    assert.ok(
      askBody.length > 0,
      'expected an ask submit handler (or POST …/ask call site) in ProductScreen',
    );
    assert.ok(
      /\.trim\s*\(/.test(askBody) || /\.trim\s*\(/.test(src),
      'Ask prompt must be trimmed before POST',
    );

    // Unit 04 must not wire continue: POST …/ask/${slug} or GET …/ask/${slug}.
    assert.doesNotMatch(
      src,
      /\/api\/products\/\$\{[^}]+\}\/ask\/\$\{/,
      'unit 04 must not POST/GET /api/products/.../ask/${slug} (unit 05 owns multiturn)',
    );
    assert.doesNotMatch(
      src,
      /\/ask\/\$\{(?:askSlug|slug|sessionSlug|askSession)/,
      'unit 04 must not continue via /ask/${storedSlug} yet',
    );
  });

  it('stores returned slug and renders answer like CLI --ask (pre + mono)', () => {
    const src = read(productScreenPath());

    // Hold slug from the start response for later same-session follow-ups.
    assert.ok(
      /(?:data|result|json|res|body)\s*\.\s*slug\b|\.slug\b/.test(src) &&
        /useState/.test(src),
      'ProductScreen must store returned ask slug in component state',
    );
    // A dedicated ask-slug state (not only Run job slug) — look for ask*Slug or set*Slug near ask.
    assert.ok(
      /askSlug|askSessionSlug|sessionSlug|setAskSlug|setSlug/.test(src) ||
        (/\/ask[`'"]/.test(src) &&
          /set[A-Za-z]*Slug\s*\(\s*(?:data|result|json|res|body)\s*\.\s*slug/.test(src)),
      'returned data.slug must be assigned into ask session state (e.g. askSlug)',
    );

    // Display stripped answer text (CLI body), not <<<SUMMARY>>> chrome.
    assert.ok(
      /(?:data|result|json|res|body)\s*\.\s*answer\b|setAskAnswer|setAnswer/.test(src),
      'ProductScreen must read/display data.answer from the ask response',
    );
    assert.doesNotMatch(
      src,
      /<<<SUMMARY>>>/,
      'ask UI must not render or look for <<<SUMMARY>>> (answer is already stripped)',
    );

    // Plain-text region mirroring JobScreen logs.
    assert.ok(
      /<pre\b/.test(src) && /\bmono\b/.test(src),
      'answer display must use pre + mono (JobScreen logs pattern)',
    );
    assert.ok(
      /className=\{?['"`][^'"`]*\b(?:logs|mono)\b/.test(src) ||
        /<pre[^>]*className=\{?['"`][^'"`]*mono/.test(src),
      'answer <pre> should reuse .logs / .mono classes from globals.css',
    );
  });

  it('surfaces ApiError and never routes ask through jobs / clean / write pipeline', () => {
    const src = read(productScreenPath());
    const askBody = askSubmitBody(src);

    assert.ok(
      /ApiError/.test(src),
      'Ask failures must use the existing ApiError / error paragraph pattern',
    );
    assert.ok(
      /className=\{?['"`][^'"`]*\berror\b|className=\{[^}]*error/.test(src),
      'errors must render via the existing .error paragraph pattern',
    );

    assert.ok(askBody.length > 0, 'expected ask submit body to inspect');
    assert.doesNotMatch(
      askBody,
      /\/jobs(?:\/clean)?[`'"]/,
      'ask submit must not POST …/jobs or …/jobs/clean',
    );
    assert.doesNotMatch(
      askBody,
      /runDetached|orch continue|\/continue/,
      'ask submit must not touch write-pipeline continue paths',
    );
    // Ask path itself must hit /ask, not jobs.
    assert.match(askBody, /\/ask/);
  });

  it('optionally types the ask response in ui/lib/types.ts without breaking JobMode', () => {
    const p = typesPath();
    assert.ok(p, 'expected ui/lib/types.ts');
    const typesSrc = read(p);

    assert.ok(
      /JobMode/.test(typesSrc) && /'seq'|\"seq\"/.test(typesSrc),
      'JobMode / jobs types must remain for Run',
    );

    // Soft: a small Ask response type is encouraged.
    const hasAskType =
      /Ask(?:Response|Result|Session)?\b/.test(typesSrc) ||
      (/answer\s*[?:]/.test(typesSrc) && /slug\s*[?:]/.test(typesSrc));
    assert.ok(
      hasAskType,
      'ui/lib/types.ts should declare a small Ask response type ({ slug, answer, session? })',
    );
  });
});
