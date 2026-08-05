import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract for ProductScreen ask panel:
 *
 * Unit 04-product-ask-ui:
 * - Read-only ask section-panel alongside Run / Jobs.
 * - First turn POSTs `{ prompt }` to `/api/products/<product>/ask`.
 * - Hold returned `slug` in state; surface ApiError; never jobs / clean / write.
 *
 * Unit 05-ui-multiturn:
 * - When `askSlug` is set, follow-ups POST the same `{ prompt }` body to
 *   `/api/products/<product>/ask/<askSlug>` (continue), not a new start.
 * - After success, persist `data.slug` and render the full thread from
 *   `data.session.turns` (optional GET only if session is missing).
 * - Still read-only ask — never jobs / Clean / runDetached / write continue.
 * - No agent picker, New chat, or README expansion here (unit 06 / backlog).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const uiRoot = path.join(root, 'ui');

function exists(p) {
  return fs.existsSync(p);
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
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
  // Fallback: window around any ask POST path (start or continue).
  const m = src.match(/\/api\/products\/\$\{[^}]+\}\/ask[\s\S]{0,1200}/);
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

  it('POSTs trimmed { prompt } to /api/products/:product/ask for the first turn', () => {
    const src = read(productScreenPath());

    // Start route must still exist for the first turn (…/ask without slug).
    assert.ok(
      /\/api\/products\/\$\{[^}]+\}\/ask[`'"]/.test(src) ||
        /\/api\/products\/\$\{encodeURIComponent\([^)]+\)\}\/ask[`'"]/.test(src) ||
        /\/api\/products\/\$\{[^}]+\}\/ask(?!\/)/.test(src),
      'Ask submit must POST /api/products/${encodeURIComponent(product)}/ask on start',
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
  });

  it('stores returned slug and keeps a pre+mono Ask transcript region', () => {
    const src = read(productScreenPath());

    // Hold slug from the start response for same-session follow-ups.
    assert.ok(
      /(?:data|result|json|res|body)\s*\.\s*slug\b|\.slug\b/.test(src) &&
        /useState/.test(src),
      'ProductScreen must store returned ask slug in component state',
    );
    assert.ok(
      /askSlug|askSessionSlug|sessionSlug|setAskSlug|setSlug/.test(src) ||
        (/\/ask[`'"]/.test(src) &&
          /set[A-Za-z]*Slug\s*\(\s*(?:data|result|json|res|body)\s*\.\s*slug/.test(src)),
      'returned data.slug must be assigned into ask session state (e.g. askSlug)',
    );

    // Latest-answer fallback is fine; multiturn prefers session.turns (unit 05).
    assert.ok(
      /(?:data|result|json|res|body)\s*\.\s*answer\b|setAskAnswer|setAnswer|session\.turns|\.turns\b/.test(
        src,
      ),
      'ProductScreen must display ask response content (answer and/or session.turns)',
    );
    assert.doesNotMatch(
      src,
      /<<<SUMMARY>>>/,
      'ask UI must not render or look for <<<SUMMARY>>> (answer is already stripped)',
    );

    // Plain-text region mirroring JobScreen logs.
    assert.ok(
      /<pre\b/.test(src) && /\bmono\b/.test(src),
      'Ask transcript must use pre + mono (JobScreen logs pattern)',
    );
    assert.ok(
      /className=\{?['"`][^'"`]*\b(?:logs|mono)\b/.test(src) ||
        /<pre[^>]*className=\{?['"`][^'"`]*mono/.test(src),
      'Ask <pre> should reuse .logs / .mono classes from globals.css',
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

describe('05-ui-multiturn ProductScreen same-session ask', () => {
  it('branches submitAsk: continue POST …/ask/${askSlug} when slug is set, else start …/ask', () => {
    const p = productScreenPath();
    assert.ok(p, 'expected ProductScreen component');
    const src = read(p);
    const askBody = askSubmitBody(src);
    assert.ok(askBody.length > 0, 'expected ask submit handler in ProductScreen');

    // Continue route must appear in ProductScreen (unit 05 owns this wiring).
    assert.ok(
      /\/api\/products\/\$\{[^}]+\}\/ask\/\$\{/.test(src) ||
        /\/ask\/\$\{(?:askSlug|slug|sessionSlug|askSession)/.test(src),
      'when askSlug is set, follow-ups must POST /api/products/.../ask/${askSlug}',
    );

    // Must still keep the start path for first turn.
    assert.ok(
      /\/api\/products\/\$\{[^}]+\}\/ask(?!\/)/.test(askBody) ||
        /\/api\/products\/\$\{[^}]+\}\/ask[`'"]/.test(askBody) ||
        /\/ask[`'"]/.test(askBody),
      'first turn must still POST …/ask (no slug)',
    );

    // Branch on stored ask session slug (ternary, if, or template that embeds askSlug).
    assert.ok(
      /askSlug/.test(askBody) || /askSlug/.test(src),
      'submitAsk must consult askSlug when choosing start vs continue URL',
    );
    assert.ok(
      /\?[\s\S]{0,200}\/ask\/\$\{|\bif\s*\([^)]*askSlug|askSlug\s*\?/.test(askBody) ||
        (/askSlug/.test(askBody) &&
          /\/ask\/\$\{/.test(askBody) &&
          /\/ask(?!\/)/.test(askBody)),
      'submitAsk must branch: askSlug set → …/ask/${askSlug}, else → …/ask',
    );

    // Same { prompt } body on both paths.
    assert.ok(
      /JSON\.stringify\s*\(\s*\{\s*prompt\s*\}/.test(askBody) ||
        /JSON\.stringify\s*\(\s*\{[^}]*\bprompt\b/.test(askBody) ||
        /\{\s*prompt\s*:\s*trimmed\}/.test(askBody) ||
        /\{\s*prompt\s*\}/.test(askBody),
      'continue POST must use the same { prompt } body as start',
    );
  });

  it('after success, persists data.slug and replaces Ask display with session.turns', () => {
    const src = read(productScreenPath());
    const askBody = askSubmitBody(src);

    assert.ok(
      /setAskSlug\s*\(\s*(?:data|result|json|res|body)\s*\.\s*slug/.test(askBody) ||
        /setAskSlug\s*\(\s*(?:data|result|json|res|body)\s*\.\s*slug/.test(src) ||
        (/set[A-Za-z]*Slug\s*\(/.test(askBody) &&
          /(?:data|result|json|res|body)\s*\.\s*slug/.test(askBody)),
      'success path must persist data.slug into askSlug state',
    );

    // Thread state from session.turns (or GET fallback when session missing).
    assert.ok(
      /session\s*\.\s*turns|(?:data|result|json|res|body)\s*\.\s*session/.test(askBody) ||
        /session\s*\.\s*turns|(?:data|result|json|res|body)\s*\.\s*session/.test(src),
      'success path must read data.session (turns) from the ask response',
    );
    assert.ok(
      /\.turns\b/.test(askBody) || /\.turns\b/.test(src),
      'Ask display state must be driven by session.turns, not only latest answer',
    );

    // Dedicated turns / thread state (useState), not answer-only.
    assert.ok(
      /useState[\s\S]{0,80}turns|setTurns|askTurns|setAskTurns|thread|setThread|setSession/.test(
        src,
      ) ||
        (/turns/.test(src) && /useState/.test(src)),
      'ProductScreen must hold Ask thread state (e.g. turns) for the full session',
    );
  });

  it('renders the full user/assistant thread in the Ask panel (pre/mono/logs)', () => {
    const src = read(productScreenPath());

    // Iterate ask turns specifically — not jobs.map alone.
    assert.ok(
      /(?:turns|askTurns|thread)\s*\.map\s*\(|\(?(?:turns|askTurns|thread)\)?\.map\s*\(/.test(
        src,
      ) ||
        (/\.turns\b[\s\S]{0,120}\.map\s*\(/.test(src) &&
          /\.role\b/.test(src) &&
          /\.content\b/.test(src)),
      'Ask panel must map session turns for the full thread (not only latest answer)',
    );
    assert.ok(
      /\.role\b/.test(src) && /\.content\b/.test(src),
      'thread render must use turn.role and turn.content',
    );
    // Prefer explicit user/assistant labels or role values in the Ask UI.
    assert.ok(
      /user|assistant|turn\.role|\.role\b/.test(src),
      'thread should distinguish user vs assistant turns',
    );

    // Stay inside existing visual tokens.
    assert.ok(
      /<pre\b/.test(src) && /\b(?:logs|mono)\b/.test(src),
      'thread display must reuse pre + logs/mono patterns',
    );
    assert.ok(
      /section-panel/.test(src) && (/>\s*Ask\s*</.test(src) || /['"`]Ask['"`]/.test(src)),
      'thread stays inside the Ask section-panel',
    );
  });

  it('keeps askBusy separate from Run busy and never hits jobs/write from ask', () => {
    const src = read(productScreenPath());
    const askBody = askSubmitBody(src);

    assert.ok(
      /askBusy|setAskBusy/.test(src),
      'Ask must keep askBusy separate from Run busy',
    );
    assert.ok(
      /setAskBusy\s*\(\s*true\s*\)/.test(askBody) || /setAskBusy\s*\(\s*true\s*\)/.test(src),
      'submitAsk must toggle askBusy while the request is in flight',
    );

    assert.doesNotMatch(
      askBody,
      /\/jobs(?:\/clean)?[`'"]/,
      'multiturn ask must not POST …/jobs or …/jobs/clean',
    );
    assert.doesNotMatch(
      askBody,
      /runDetached|orch continue|\/continue/,
      'multiturn ask must not touch write-pipeline continue paths',
    );
    assert.doesNotMatch(
      askBody,
      /agent\s*:|agents\s*:|setAgent/,
      'unit 05 must not add an agent picker on ask POST',
    );
  });

  it('types session.turns on AskResponse so the thread is usable without unknown casts', () => {
    const p = typesPath();
    assert.ok(p, 'expected ui/lib/types.ts');
    const typesSrc = read(p);

    assert.ok(
      /Ask(?:Response|Result|Session)\b/.test(typesSrc),
      'ui/lib/types.ts must declare AskResponse / AskSession',
    );
    assert.ok(
      /turns\s*[?:]/.test(typesSrc),
      'Ask session type must expose turns',
    );
    assert.ok(
      /role\s*[?:]/.test(typesSrc) && /content\s*[?:]/.test(typesSrc),
      'turn type must include role and content',
    );
    // session must not remain opaque unknown-only if turns are declared.
    assert.ok(
      /session\s*\?\s*:\s*(?:AskSession|\{)/.test(typesSrc) ||
        (/interface\s+AskSession|type\s+AskSession/.test(typesSrc) &&
          /session\s*\?/.test(typesSrc)),
      'AskResponse.session should be typed (AskSession), not only unknown',
    );
    assert.ok(
      /JobMode/.test(typesSrc),
      'JobMode must remain intact alongside ask types',
    );
  });
});
