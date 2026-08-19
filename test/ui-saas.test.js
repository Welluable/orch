import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract for Orch UI SaaS redesign (design.md + task checklist):
 *
 * - Dark GitHub-inspired tokens in globals.css (bg/surface/primary/on-primary/
 *   white text + white borders, muted slate — not YAML text-muted #000000 on dark).
 * - Mona Sans / Mona Sans Mono (+ system fallbacks); drop IBM Plex; keep viewport.
 * - App chrome with persistent sidebar (brand orch, Products nav, contextual
 *   product/job crumbs or links) and full-width main; collapse/drawer on small
 *   screens — not a narrow phone-card shell alone.
 * - Shared primitives restyled (primary/secondary/danger, focus rings); no new
 *   UI library (extend globals.css only).
 * - ProductsScreen / ProductScreen SaaS density: page headers, section panels,
 *   scannable list rows — not a bare stacked-.card phone layout.
 * - Job logs: terminal-style scrollable panel with sticky toolbar + Reload logs.
 * - Preserve static export, query routing, API flows (covered primarily by
 *   test/ui-app.test.js — this file soft-guards layout/theme contracts).
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

function readJson(p) {
  return JSON.parse(read(p));
}

function walkUiSources(dir = uiRoot, acc = []) {
  if (!exists(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.next' || ent.name === 'out') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkUiSources(full, acc);
      continue;
    }
    if (/\.(tsx?|jsx?|mjs|cjs|css)$/.test(ent.name)) acc.push(full);
  }
  return acc;
}

function allUiSourceText() {
  return walkUiSources().map(read).join('\n');
}

function globalsCssPath() {
  for (const p of [
    path.join(uiRoot, 'app', 'globals.css'),
    path.join(uiRoot, 'src', 'app', 'globals.css'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

function layoutPath() {
  for (const p of [
    path.join(uiRoot, 'app', 'layout.tsx'),
    path.join(uiRoot, 'app', 'layout.jsx'),
    path.join(uiRoot, 'src', 'app', 'layout.tsx'),
    path.join(uiRoot, 'src', 'app', 'layout.jsx'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

function jobScreenPath() {
  for (const p of [
    path.join(uiRoot, 'components', 'JobScreen.tsx'),
    path.join(uiRoot, 'components', 'JobScreen.jsx'),
    path.join(uiRoot, 'src', 'components', 'JobScreen.tsx'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
}

function productsScreenPath() {
  for (const p of [
    path.join(uiRoot, 'components', 'ProductsScreen.tsx'),
    path.join(uiRoot, 'components', 'ProductsScreen.jsx'),
    path.join(uiRoot, 'src', 'components', 'ProductsScreen.tsx'),
  ]) {
    if (exists(p)) return p;
  }
  return null;
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

/** SaaS density markers: page header + section panel + scannable list rows. */
function hasSaasScreenDensity(src) {
  const pageHeader =
    /page-header|pageHeader|className=\{?['"`][^'"`]*\bpage-title\b/i.test(src) ||
    /<(?:header)\b[^>]*className/i.test(src);
  const sectionPanel =
    /section-panel|sectionPanel|className=\{?['"`][^'"`]*\b(?:section|panel)\b/i.test(
      src,
    ) || /<(?:section)\b[^>]*className/i.test(src);
  const scannableRows =
    /list-row|listRow|data-row|product-row|job-row|scannable-row/i.test(src) ||
    /className=\{?['"`][^'"`]*\b(?:row-item|list-item)\b/i.test(src);
  return { pageHeader, sectionPanel, scannableRows, ok: pageHeader && sectionPanel && scannableRows };
}

/** Hex color appears as a token value (not only in comments). */
function hasCssColor(css, hex) {
  const re = new RegExp(
    `(?:^|[\\s:;,(])#${hex.replace('#', '')}\\b|(?:^|[\\s:;,(])${hex}\\b`,
    'i',
  );
  return re.test(css);
}

describe('ui-saas design tokens (design.md)', () => {
  it('defines light SaaS palette tokens in globals.css', () => {
    const cssPath = globalsCssPath();
    assert.ok(cssPath, 'expected ui/app/globals.css');
    const css = read(cssPath);

    assert.ok(
      hasCssColor(css, 'ffffff') || /--(?:bg|background)\s*:\s*#fff\b/i.test(css),
      'expected background token #ffffff (white canvas)',
    );
    assert.ok(
      hasCssColor(css, 'f7f7f8'),
      'expected surface token #f7f7f8',
    );
    assert.ok(
      hasCssColor(css, '8e8ea0'),
      'expected primary/accent token #8e8ea0',
    );
    assert.ok(
      hasCssColor(css, '000000') || /--(?:text|ink)\s*:\s*#000\b/i.test(css),
      'expected text token #000000 for primary content text',
    );
    assert.ok(
      hasCssColor(css, '8e8ea0'),
      'expected muted token #8e8ea0 for secondary UI',
    );

    // design.md (light) requires black (#000000) primary text on a white canvas
    // with a subtle rgba border, not the prior dark-theme white-on-black tokens.
    assert.ok(
      /--(?:text|ink|fg|color-text|on-background|on-bg)\s*:\s*#(?:000000|000)\b/i.test(css),
      'expected black (#000000) primary text token (--text / --ink or equivalent)',
    );
    assert.ok(
      /--(?:border|line|stroke|border-color)\s*:\s*rgba\(\s*0,\s*0,\s*0,/i.test(css),
      'expected rgba(0, 0, 0, ...) border token (--border / --line or equivalent)',
    );
    // Dark-theme surface/background must not linger after the revert.
    assert.doesNotMatch(
      css,
      /--surface\s*:\s*#0d1117\b/i,
      'must not keep dark --surface #0d1117; use light surface #f7f7f8',
    );
    assert.doesNotMatch(
      css,
      /--(?:bg|background)\s*:\s*#000000\b/i,
      'must replace dark --bg #000000 with light background #ffffff',
    );
    assert.doesNotMatch(
      css,
      /--(?:primary|accent)\s*:\s*#8dd6ff\b/i,
      'must replace cyan --accent #8dd6ff with monochrome primary #8e8ea0',
    );
  });

  it('exposes spacing scale, radii, shadows, and motion with reduced-motion', () => {
    const css = read(globalsCssPath());

    // 4px base / scale cues (token vars or literal scale values).
    const hasSpacingScale =
      /--(?:space|spacing|sp)-?(?:base|1|xs)\s*:\s*4px/i.test(css) ||
      /--(?:space|spacing)[^;]{0,80}4px/i.test(css) ||
      (/\b4px\b/.test(css) && /\b8px\b/.test(css) && /\b16px\b/.test(css) && /\b24px\b/.test(css));
    assert.ok(hasSpacingScale, 'expected 4px-base spacing scale tokens or repeated scale values');

    assert.ok(
      /--(?:radius|radii?)(?:-sm)?\s*:\s*6px/i.test(css) ||
        /--radius-sm\s*:/i.test(css) ||
        (/\b6px\b/.test(css) && /\b8px\b/.test(css) && /\b16px\b/.test(css)),
      'expected radius scale including sm≈6px, md≈8px, lg≈16px',
    );

    assert.ok(
      /box-shadow|--(?:shadow|elevation)/i.test(css),
      'expected card/elevated shadow tokens or box-shadow usage',
    );

    assert.ok(
      /--(?:duration|motion|transition)[^;]*\d+ms|transition(?:-duration)?\s*:[^;]*\d+ms/i.test(css),
      'expected motion duration tokens (fast/base/slow ms)',
    );
    assert.ok(
      /--easing\s*:\s*ease\b|cubic-bezier\s*\(/i.test(css),
      'expected design easing token (ease or cubic-bezier(...))',
    );
    assert.ok(
      /prefers-reduced-motion/i.test(css),
      'expected @media (prefers-reduced-motion) to respect a11y',
    );
  });

  it('styles focus rings with cyan or white outline for dark surfaces', () => {
    const css = read(globalsCssPath());
    const hasFocus =
      /:focus(?:-visible)?\b[\s\S]{0,200}(?:outline|box-shadow)/i.test(css) ||
      /(?:outline|box-shadow)[\s\S]{0,80}:focus/i.test(css);
    assert.ok(hasFocus, 'expected :focus / :focus-visible outline or ring styles');

    const focusWin = css.match(/:focus(?:-visible)?\s*\{[^}]+\}/gi) || [];
    const focusBlob = focusWin.join('\n') || css;
    assert.ok(
      /#8dd6ff|#ffffff|#fff\b|var\(--(?:primary|accent|ink|text|border)/i.test(focusBlob) ||
        /outline[^;]*(?:2px|solid)/i.test(focusBlob),
      'focus ring should use cyan/white (or design token) with visible outline',
    );
  });

  it('applies black text and subtle borders in base body/surface rules (not tokens alone)', () => {
    const css = read(globalsCssPath());

    // Token layer must define black text + rgba borders (design.md light colors.text/border).
    const textTokenBlack =
      /--(?:text|ink|fg|color-text|on-background|on-bg)\s*:\s*#(?:000000|000)\b/i.test(css);
    const borderTokenSubtle =
      /--(?:border|line|stroke|border-color)\s*:\s*rgba\(\s*0,\s*0,\s*0,/i.test(css);
    assert.ok(
      textTokenBlack,
      'expected --text/--ink (or equiv) token value #000000 for primary content text',
    );
    assert.ok(
      borderTokenSubtle,
      'expected --border/--line (or equiv) token value rgba(0, 0, 0, ...) for light-theme edges',
    );

    // Usage layer: body color and panel borders must reference those black/subtle tokens.
    assert.ok(
      /(?:body|html)[^{]*\{[^}]*color\s*:\s*(?:#(?:000000|000)\b|var\(--(?:text|ink|fg|color-text|on-background|on-bg)\))/i.test(
        css,
      ),
      'body/html must set color to black or the black text token',
    );
    assert.ok(
      /border(?:(?:-color)?\s*:\s*(?:[^;]*\s+)?(?:rgba\(\s*0,\s*0,\s*0,|var\(--(?:border|line|stroke)))/i.test(
        css,
      ),
      'panels must use rgba(0, 0, 0, ...) or the border token',
    );
  });
});

describe('ui-saas typography', () => {
  it('uses Mona Sans stacks and drops IBM Plex', () => {
    const layout = layoutPath();
    assert.ok(layout, 'expected ui/app/layout.tsx');
    const layoutSrc = read(layout);
    const css = read(globalsCssPath());
    const blob = `${layoutSrc}\n${css}\n${allUiSourceText()}`;

    assert.ok(
      /Mona\s*Sans/i.test(blob),
      'expected Mona Sans (or MonaSansFallback) in layout/CSS font stack',
    );
    assert.ok(
      /Mona\s*Sans\s*Mono|MonaSansMono|--mono[^;]*mono/i.test(blob),
      'expected Mona Sans Mono (or mono stack) for code/logs',
    );
    assert.doesNotMatch(
      blob,
      /IBM\s*Plex/i,
      'must drop IBM Plex Sans/Mono in favor of Mona Sans',
    );

    assert.ok(
      /export\s+const\s+viewport\b/.test(layoutSrc) || /viewport\s*:/.test(layoutSrc),
      'layout must keep Next viewport export for mobile',
    );
  });
});

describe('ui-saas app chrome (sidebar shell)', () => {
  it('provides a sidebar app shell instead of a narrow centered topbar-only layout', () => {
    const layout = read(layoutPath());
    const css = read(globalsCssPath());
    const src = allUiSourceText();
    const blob = `${layout}\n${css}\n${src}`;

    // Persistent sidebar / nav chrome.
    const hasSidebarChrome =
      /className=\{?['"`][^'"`]*\bsidebar\b|className=\{[^}]*sidebar|\.sidebar\b|['"`]sidebar['"`]/i.test(
        blob,
      ) ||
      /<(aside|nav)\b[^>]*(?:sidebar|className)/i.test(blob) ||
      /role\s*=\s*['"]navigation['"]/i.test(blob);
    assert.ok(
      hasSidebarChrome,
      'expected persistent sidebar/nav chrome (class sidebar, <aside>/<nav>, or role=navigation)',
    );

    // Brand + Products nav.
    assert.ok(
      />\s*orch\s*</.test(blob) || /['"`]orch['"`]/.test(blob),
      'sidebar/brand must surface “orch”',
    );
    assert.ok(
      />\s*Products\s*</.test(blob) || /['"`]Products['"`]/.test(blob),
      'sidebar must include Products navigation label',
    );

    // Contextual product/job crumbs or links (checklist chrome — not brand+Products only).
    const hasCrumbChrome =
      /\b(?:crumb|crumbs|breadcrumb|breadcrumbs|nav-context|context-nav|sidebar-context)\b/i.test(
        blob,
      );
    const sidebarReadsRouteContext =
      (/\b(?:sidebar|aside|AppNav|SideNav|chrome)\b/i.test(blob) ||
        /role\s*=\s*['"]navigation['"]/i.test(blob)) &&
      /searchParams\.get\(\s*['"]product['"]\s*\)|searchParams\.get\(\s*['"]job['"]\s*\)/.test(
        blob,
      );
    const crumbLinksProductAndJob =
      hasCrumbChrome &&
      /\?product=|productSlug|encodeURIComponent\(\s*(?:product|slug)/i.test(blob) &&
      /\?job=|jobSlug|encodeURIComponent\(\s*(?:job|slug)/i.test(blob);
    assert.ok(
      hasCrumbChrome || sidebarReadsRouteContext || crumbLinksProductAndJob,
      'sidebar must include contextual product/job crumbs or links (not only brand + Products)',
    );
    // Soft-require that both product and job context can appear in chrome (links or labels).
    assert.ok(
      (/\bproduct\b/i.test(blob) && /\bjob\b/i.test(blob) && hasCrumbChrome) ||
        sidebarReadsRouteContext ||
        (/crumb|breadcrumb/i.test(blob) &&
          (/\?product=/.test(blob) || /productSlug/.test(blob)) &&
          (/\?job=/.test(blob) || /jobSlug/.test(blob))),
      'chrome must be able to surface both product and job context in sidebar crumbs/links',
    );

    // Main content region (not only nested cards inside .shell).
    assert.ok(
      /\.main\b|className=\{?['"`][^'"`]*\bmain\b|<(main)\b/i.test(blob),
      'expected a main content region (.main / <main>) beside the sidebar',
    );

    // Must not rely solely on the old narrow centered shell as the app frame.
    const stillNarrowOnly =
      /\.shell\s*\{[^}]*width\s*:\s*min\(\s*100%\s*,\s*42rem\s*\)/i.test(css) &&
      !hasSidebarChrome;
    assert.equal(
      stillNarrowOnly,
      false,
      'must replace narrow .shell (max 42rem) topbar layout with sidebar + full-width main',
    );

    // Desktop width: main/app should be able to use more than 42rem.
    assert.ok(
      /min\(\s*100%\s*,\s*(?:6[5-9]|[7-9]\d|\d{3,})rem|100%|100vw|flex\s*:\s*1|grid-template-columns/i.test(
        css,
      ) ||
        /\.app(?:-shell)?\b|\.layout\b|\.shell\b[\s\S]{0,200}display\s*:\s*(?:flex|grid)/i.test(css),
      'expected full-width / flex|grid app shell CSS (not phone-narrow column only)',
    );
  });

  it('collapses sidebar for small screens (drawer, top nav, or media query)', () => {
    const css = read(globalsCssPath());
    const src = allUiSourceText();
    const blob = `${css}\n${src}`;

    assert.ok(
      /@media\b/.test(css),
      'expected @media rules for responsive sidebar collapse',
    );

    const mobileSidebarCue =
      /@media[^{]+\{[^}]*\.(?:sidebar|nav|drawer|menu|topbar|mobile)/i.test(css) ||
      /(?:sidebar|drawer|nav).*?(?:translate|transform|display\s*:\s*none|max-height|left\s*:)/i.test(
        css,
      ) ||
      /(?:menu|hamburger|nav-toggle|sidebar-open|drawer-open|is-open)/i.test(blob) ||
      (/@media[^{]*(?:max-width|min-width)\s*:\s*(?:4|5|6|7)\d{2}px/i.test(css) &&
        /\.sidebar\b/i.test(css));
    assert.ok(
      mobileSidebarCue,
      'sidebar must collapse to top/drawer on small screens (media + sidebar/drawer cues)',
    );
  });

  it('surfaces contextual product and job crumbs or links in the sidebar chrome', () => {
    const src = allUiSourceText();
    const layout = read(layoutPath());
    const blob = `${layout}\n${src}`;

    const crumbVocab =
      /\b(?:crumb|crumbs|breadcrumb|breadcrumbs|nav-context|context-nav|sidebar-context)\b/i.test(
        src,
      );
    // Chrome that reads ?product= / ?job= (client nav component — not page switch alone).
    const navFiles = walkUiSources().filter((f) =>
      /(?:Sidebar|SideNav|AppNav|AppChrome|Nav|layout)\.(tsx|jsx|css)$/i.test(path.basename(f)) ||
      /components\/.*Nav/i.test(f),
    );
    const navBlob = navFiles.map(read).join('\n') || '';
    const chromeContext =
      /searchParams\.get\(\s*['"](?:product|job)['"]\s*\)/.test(navBlob) ||
      (/searchParams\.get\(\s*['"](?:product|job)['"]\s*\)/.test(src) &&
        /\b(?:sidebar|aside|SideNav|AppNav|crumb|breadcrumb)\b/i.test(src));

    assert.ok(
      crumbVocab || chromeContext,
      'expected sidebar contextual crumbs (crumb/breadcrumb classes) or nav chrome that reads product/job searchParams',
    );

    // Must not stop at static “Products” label — product + job destinations required.
    assert.ok(
      /\?product=|productSlug|['"]product['"]/.test(blob) &&
        /\?job=|jobSlug|['"]job['"]/.test(blob),
      'sidebar context must link or label both product and job routes',
    );
    assert.ok(
      crumbVocab ||
        (chromeContext &&
          (/href=\{?[`'"]\/\?product=|href=\{?[`'"]\/\?job=|router\.push.*product|router\.push.*job/i.test(
            src,
          ) ||
            /encodeURIComponent\(\s*(?:product|job|slug)/i.test(src))),
      'contextual chrome must expose navigable product/job links or crumbs, not brand+Products only',
    );
  });
});

describe('ui-saas primitives + no UI library', () => {
  it('keeps button.danger and primary/secondary primitives in CSS', () => {
    const css = read(globalsCssPath());
    assert.match(css, /button\.danger|\.danger\b/);
    assert.ok(
      /button\.secondary|\.secondary\b|button(?![^{]*danger)/i.test(css),
      'expected primary and secondary button styles',
    );
  });

  it('does not introduce a component UI library (extend globals.css only)', () => {
    const pkgPath = path.join(uiRoot, 'package.json');
    assert.ok(exists(pkgPath), 'expected ui/package.json');
    const pkg = readJson(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const banned = [
      '@mui/material',
      '@chakra-ui/react',
      'antd',
      '@mantine/core',
      'react-bootstrap',
      '@radix-ui/themes',
      'daisyui',
      'shadcn',
    ];
    for (const name of banned) {
      assert.equal(
        deps[name],
        undefined,
        `must not add UI library dependency ${name}; restyle via globals.css`,
      );
    }
    // Tailwind is optional-banned for this task (extend globals.css only).
    assert.equal(
      deps.tailwindcss,
      undefined,
      'task requires extending globals.css only — do not add tailwindcss',
    );
  });
});

describe('ui-saas Products / Product screen density', () => {
  it('gives ProductsScreen page headers, section panels, and scannable list rows', () => {
    const p = productsScreenPath();
    assert.ok(p, 'expected ProductsScreen component');
    const src = read(p);
    const density = hasSaasScreenDensity(src);

    assert.ok(
      density.pageHeader,
      'ProductsScreen needs a page header (page-header / <header className> / page-title) — not only h2 inside .card',
    );
    assert.ok(
      density.sectionPanel,
      'ProductsScreen needs section panels (section-panel / <section> / panel) for SaaS density',
    );
    assert.ok(
      density.scannableRows,
      'ProductsScreen product list must use scannable rows (list-row / product-row / list-item) — not a bare <ul className="list"> card stack',
    );

    // Reject "only stacked .card" with no density chrome.
    const cardOnly =
      (src.match(/className=["'`]card["'`]/g) || []).length >= 2 && !density.ok;
    assert.equal(
      cardOnly,
      false,
      'ProductsScreen must not remain a simple stacked-.card layout without SaaS density markers',
    );
  });

  it('gives ProductScreen page headers, section panels, and scannable job list rows', () => {
    const p = productScreenPath();
    assert.ok(p, 'expected ProductScreen component');
    const src = read(p);
    const density = hasSaasScreenDensity(src);

    assert.ok(
      density.pageHeader,
      'ProductScreen needs a page header (page-header / <header className> / page-title)',
    );
    assert.ok(
      density.sectionPanel,
      'ProductScreen needs section panels (section-panel / <section> / panel) for Run/Jobs regions',
    );
    assert.ok(
      density.scannableRows,
      'ProductScreen job list must use scannable rows (list-row / job-row / list-item)',
    );

    const cardOnly =
      (src.match(/className=["'`]card["'`]/g) || []).length >= 2 && !density.ok;
    assert.equal(
      cardOnly,
      false,
      'ProductScreen must not remain a simple stacked-.card layout without SaaS density markers',
    );

    // Preserve Clean jobs + Run contracts at the density layer (soft).
    assert.ok(
      />\s*Clean jobs\s*</.test(src) || /['"`]Clean jobs['"`]/.test(src),
      'ProductScreen must keep Clean jobs control',
    );
    assert.ok(/\bid\b/.test(src) && /uuid|v4/i.test(src), 'Run job must still send caller id');
  });
});

describe('ui-saas Job logs terminal panel', () => {
  it('structures logs as a proper terminal-style panel with sticky toolbar', () => {
    const jobPath = jobScreenPath();
    assert.ok(jobPath, 'expected JobScreen component');
    const jobSrc = read(jobPath);
    const css = read(globalsCssPath());
    const blob = `${jobSrc}\n${css}`;

    assert.ok(
      />\s*Reload logs\s*</.test(jobSrc) || /['"`]Reload logs['"`]/.test(jobSrc),
      'logs toolbar must keep Reload logs control',
    );

    // Panel chrome: dedicated logs panel / terminal class, or sticky log toolbar.
    const hasLogsPanelChrome =
      /className=\{?['"`][^'"`]*\b(?:logs-panel|log-panel|terminal|logs-view|console)\b/i.test(
        jobSrc,
      ) ||
      /\.(?:logs-panel|log-panel|terminal|logs-view|console)\b/i.test(css) ||
      (/logs-toolbar|log-toolbar|sticky/i.test(blob) && /\.logs\b/.test(css));
    assert.ok(
      hasLogsPanelChrome,
      'expected terminal/logs-panel chrome (class logs-panel|terminal|console or sticky logs toolbar)',
    );

    // Sticky toolbar cue in CSS or JobScreen.
    assert.ok(
      /position\s*:\s*sticky/i.test(css) ||
        /logs-toolbar|log-header|sticky/i.test(blob),
      'expected sticky logs toolbar (position:sticky or logs-toolbar class)',
    );

    // Readable terminal surface: min-height + overflow scroll + mono.
    const logsRule =
      css.match(/\.logs\b[^{]*\{[^}]+\}/i)?.[0] ||
      css.match(/\.(?:logs-panel|terminal|console)\b[^{]*\{[^}]+\}/i)?.[0] ||
      '';
    const logsCssBlob = logsRule || css;
    assert.ok(
      /min-height\s*:\s*(?:1[2-9]|[2-9]\d)\w*|min-height\s*:\s*(?:40|50|60|70|80)vh/i.test(
        logsCssBlob,
      ) ||
        /min-height\s*:\s*(?:12|14|16|18|20|22|24)rem/i.test(logsCssBlob),
      'logs panel must set a readable min-height (not a tiny afterthought)',
    );
    assert.ok(
      /overflow\s*:\s*auto|overflow-y\s*:\s*auto|overflow\s*:\s*scroll/i.test(logsCssBlob),
      'logs panel must be scrollable (overflow auto/scroll)',
    );
    assert.ok(
      /font-family\s*:\s*var\(--mono\)|font-family[^;]*mono|className=\{?['"`][^'"`]*\bmono\b/i.test(
        blob,
      ),
      'logs must use monospace type',
    );

    // Must still fetch logs via apiText / .../logs (behavioral contract).
    assert.ok(
      /\/logs/.test(jobSrc) && (/apiText/.test(jobSrc) || /fetch\s*\(/.test(jobSrc)),
      'JobScreen must still load logs via apiText or fetch …/logs',
    );
  });

  it('keeps job ops console cohesion (controls + files near logs, not only stacked phone cards)', () => {
    const jobSrc = read(jobScreenPath());
    const css = read(globalsCssPath());

    // Files list + Pause/Resume/Stop still present.
    assert.ok(/>\s*Pause\s*</.test(jobSrc) || /['"`]Pause['"`]/.test(jobSrc));
    assert.ok(/>\s*Resume\s*</.test(jobSrc) || /['"`]Resume['"`]/.test(jobSrc));
    assert.ok(/>\s*Stop\s*</.test(jobSrc) || /['"`]Stop['"`]/.test(jobSrc));
    assert.ok(
      /file\.path|file\.status|\{\s*path\s*,\s*status\s*\}/.test(jobSrc),
      'files list must still read path + status',
    );

    // Console layout cue: grid/flex ops layout or dedicated job-console class.
    const consoleLayout =
      /className=\{?['"`][^'"`]*\b(?:job-console|ops|console|job-layout|job-grid)\b/i.test(
        jobSrc,
      ) ||
      /\.(?:job-console|ops-console|job-layout|job-grid)\b/i.test(css) ||
      (/display\s*:\s*grid/i.test(css) && /\.logs\b/.test(css));
    assert.ok(
      consoleLayout,
      'Job screen should use an ops-console / grid layout so controls, logs, and files feel unified',
    );
  });
});

describe('ui-saas preserves prior API/routing contracts', () => {
  it('keeps static export and query-param product/job routing', () => {
    const cfgCandidates = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'];
    const cfgPath = cfgCandidates
      .map((n) => path.join(uiRoot, n))
      .find(exists);
    assert.ok(cfgPath, 'expected ui/next.config.*');
    assert.match(read(cfgPath), /output\s*:\s*['"]export['"]/);

    const src = allUiSourceText();
    assert.ok(
      /useSearchParams|URLSearchParams/.test(src),
      'must keep client searchParams routing for ?product= / ?job=',
    );
    assert.match(src, /\?product=|['"`]product['"`]/);
    assert.match(src, /\?job=|['"`]job['"`]/);
  });

  it('does not add auth UI or HTTP DELETE', () => {
    const src = allUiSourceText();
    assert.doesNotMatch(src, /Authorization\s*:/i);
    assert.doesNotMatch(src, /\btype\s*=\s*['"]password['"]/);
    assert.doesNotMatch(src, /method\s*:\s*['"]DELETE['"]/);
  });
});
