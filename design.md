---
version: alpha
name: GitHub
description: "Join the world's most widely adopted, AI-powered developer platform where millions of developers, businesses, and the largest open source community build software that advances humanity."
sourceUrl: "https://github.com"

colors:
  primary: "#8dd6ff"
  on-primary: "#111111"
  background: "#000000"
  surface: "#0d1117"
  border: "#ffffff"
  text: "#ffffff"
  text-muted: "#000000"
  accent: "#0d1117"

typography:
  display:
    fontFamily: "Mona Sans, MonaSansFallback, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji"
    fontSize: 40px
    fontWeight: 460
    lineHeight: 1.2
  heading:
    fontFamily: "Mona Sans, MonaSansFallback, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji"
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.4
  body:
    fontFamily: "Mona Sans, MonaSansFallback, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "Mona Sans Mono, monospace"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.5px

spacing:
  base: 4px
  scale: [4, 8, 12, 16, 20, 24, 32, 40, 48, 64]

radius:
  sm: 6px
  md: 8px
  lg: 16px
  xl: 24px

shadows:
  card: "rgba(209, 217, 224, 0.25) 0px 0px 0px 1px, rgba(37, 41, 46, 0.04) 0px 6px 12px -3px, rgba(37, 41, 46, 0.12) 0px 6px 18px 0px"
  elevated: "rgba(209, 217, 224, 0.25) 0px 0px 0px 1px, rgba(37, 41, 46, 0.04) 0px 6px 12px -3px, rgba(37, 41, 46, 0.12) 0px 6px 18px 0px"

motion:
  duration-fast: 80ms
  duration-base: 400ms
  duration-slow: 800ms
  easing: "cubic-bezier(0.16, 1, 0.3, 1)"

breakpoints: [380px, 420px, 544px, 600px, 767px, 768px, 800px, 804px, 876px, 1012px, 1029px, 1150px, 1200px, 1280px, 1300px, 1400px, 1464px, 1600px, 1728px]
---

## Rationale

GitHub's design system reflects its position as a **developer-first, AI-augmented collaborative platform**. The dark theme (black `#000000` background with `#0d1117` surfaces) reduces eye strain during extended coding sessions and establishes a professional, forward-thinking aesthetic that appeals to engineers. The measured color palette prioritizes **high contrast and clarity**—white text on near-black, with a bright cyan primary (`#8dd6ff`) that signals interactivity and draws attention to critical actions (sign-in, CTAs). The typography stack (Mona Sans as the primary font) is custom-built for the brand, signaling investment in distinctive visual identity while fallbacks ensure reliability across platforms. Spacing follows a strict 4px base unit with a thoughtful scale (4, 8, 12, 16, 20, 24, 32, 48, 64), enabling precise alignment and rhythm across thousands of repositories, pull requests, and collaborative interfaces. The system balances **density with breathing room**—necessary for information-heavy dashboards while maintaining legibility and cognitive load management for developers context-switching between code, discussions, and settings.

## 1. Visual Theme & Atmosphere

GitHub operates in **dark mode by default**, creating a nocturnal, focused environment that mirrors many developers' work habits and IDEs. The near-black background (`#000000`) with slightly elevated surface cards (`#0d1117`) provides subtle depth without introducing bright, distracting elements. The accent color (`#484f58`—a muted slate) is used for secondary UI and disabled states, creating a clear visual hierarchy without competing for attention. The overall mood is **professional, technical, and minimal**—nothing frivolous. This aligns with GitHub's identity as the world's largest open-source collaboration platform where substance matters more than decoration. The sparse use of color (primarily cyan for actions, white for text) enforces focus and makes intentional interactive elements unmissable.

## 2. Color System

**Primary**: `#8dd6ff` (bright cyan) is deployed on CTAs, links, and interactive affordances, creating strong visual separation against the dark background. This color choice is modern, energetic, and commonly associated with technology and code editors.

**Background & Surfaces**: 
- `#000000` (pure black) as the main canvas
- `#0d1117` (charcoal) for elevated components (cards, modals, panels)
This 2-level hierarchy ensures interactive content feels "floating" or "lifted" without introducing multiple tonal layers.

**Text**:
- `#ffffff` (white) for primary content and high-emphasis text
- `#000000` (black—unusually) marked as `text-muted`, suggesting this may be used for overlays or inverted states (white-on-primary backgrounds)

**Border & Accent**:
- `#ffffff` (white borders) provide crisp edge definition in a dark context
- `#484f58` (muted slate) for secondary UI, hover states, or disabled interactions

This is a **deliberately desaturated palette**—no gradients or complex color relationships—enabling rapid visual processing and reducing cognitive load for long work sessions.

## 3. Typography

GitHub employs a **tiered hierarchy** to manage vast amounts of structured content:

**Display** (40px, 460 weight, 1.2 line height): Reserved for page heroes and major section introductions. The lighter weight (460) keeps large text readable and elegant rather than heavy.

**Heading** (24px, 600 weight, 1.5 line height): Used for section titles, repository names, and issue/PR headers. The 1.5 line height prevents crowding and aids scanning.

**Body** (16px, 500 weight, 1.5 line height): Standard reading text. Mid-weight and generous line height support long-form content (README files, discussions, documentation). The 16px baseline prioritizes legibility on diverse devices.

**Mono** (12px, 400 weight, 1.5 line height, 0.5px letter spacing): Code blocks, file paths, and inline code. Smaller size saves horizontal space; letter spacing prevents visual blurring of symbols and operators critical to developers.

**Font Stack**: Mona Sans (GitHub's custom typeface) with system fallbacks ensures brand consistency while remaining resilient. The monospace variant supports code rendering without requiring a third-party library.

## 4. Components & Patterns

GitHub's measured design supports:

**Cards & Panels**: 
- Deployed with `card` shadow (inset border at `rgba(209, 217, 224, 0.25)` + soft drop shadow)
- `md` radius (8px) for file listings, issue cards, and commit previews
- Creates visual grouping without harsh edges

**Interactive Elements**:
- Primary CTAs (Sign in, Sign up, MCP Registry) use the cyan primary with white text and `md` radius
- Secondary actions styled with border or inverted color to reduce visual weight
- Hover and active states managed via motion (see Motion & Interaction)

**Navigation**:
- Top-level nav likely uses the surface color with white text
- Search bar (`Search code, repositories, users...`) is a prominent affordance, likely with cyan accent on focus

**Feedback & Status**:
- Saved searches, alerts, and secondary navigation use accent color (`#484f58`) for lower-priority information
- Critical information (secret protection CTAs) likely emphasize primary cyan

## 5. Spacing & Layout

The **4px base unit** is the foundation:

| Tier | Value | Use Case |
|------|-------|----------|
| 4px  | Tight spacing within components (icon padding, inline gaps) |
| 8px  | Small padding/margins (button internal spacing) |
| 12px | Form field padding, compact list items |
| 16px | Standard container padding, moderate gaps |
| 20px | Breathing room between sections |
| 24px | Section dividers, major content breaks |
| 32px | Large gaps between layout regions |
| 48px | Hero section spacing, modal padding |
| 64px | Page-level breaks |

This scale enables **pixel-perfect alignment** across responsive breakpoints while keeping file sizes predictable. The 19 measured breakpoints (380px to 1728px) suggest GitHub prioritizes mobile, tablet, desktop, and ultra-wide displays—necessary for a truly global developer audience accessing via phones during standups and on 4K monitors at workstations.

## 6. Motion & Interaction

**Timing**:
- `durationFastMs: 80`: Micro-interactions (icon toggling, popover entry)
- `durationBaseMs: 400`: Standard transitions (page navigation, modal open)
- `durationSlowMs: 800`: Elaborate animations (hero parallax, staggered list reveals)

**Easing**: `cubic-bezier(0.165, 0.84, 0.44, 1)` is a **custom easing curve** leaning toward ease-out, creating snappy, natural motion that feels responsive without appearing stiff. This is faster on the way in, slower on the way out—ideal for UI that feels reactive to user input.

**Use Cases**:
- Focus states on inputs/buttons: 80ms opacity fade
- Dropdown menus: 400ms slide + fade
- Modals/overlays: 400ms scale-in with easing
- Navigation transitions: 400ms–800ms staggered element reveals

The motion system avoids being decorative; every transition serves to clarify relationships, confirm actions, or guide attention.

## Accessibility

### Contrast Ratios

**Primary text pair** (`#ffffff` text on `#000000` background):
- **Measured contrast: 21:1** (white on pure black)
- **WCAG AAA compliant** (7:1 minimum for AAA; 4.5:1 for AA)
- This exceeds all standards and is ideal for extended reading

**Interactive text** (white on `#8dd6ff` primary):
- **Estimated contrast: ~3.2:1** (white text on bright cyan)
- **Does NOT meet WCAG AA (4.5:1)** for body text
- **Acceptable for UI labels/buttons** if button text is large (18px+) or bold; should be tested with actual rendering
- Recommendation: Use white text on primary only for short labels; consider `on-primary: #111111` (dark text) for larger content areas

**Muted text** (`text-muted: #000000` on background):
- Likely **inverted for light-mode or overlay states**; on dark backgrounds this is unreadable and suggests tokens are context-aware
- Never use black text on black background in dark mode

### Minimum Requirements

- **Touch target**: GitHub's UI should enforce 44×44px minimum for buttons, links, and form controls (measured spacing scale supports this—32px + 8px padding = 48px minimum)
- **Focus indicator**: Implement a **2px solid white or cyan outline with 2px offset** for keyboard navigation. The bright primary cyan would provide sufficient contrast against dark backgrounds while maintaining brand consistency
- **Keyboard navigation**: All CTAs (Sign in, Sign up, MCP Registry) and interactive components must be reachable via Tab and operable via Enter/Space
- **ARIA labels**: Repository names, issue states, PR statuses, and save/bookmark buttons require semantic HTML or explicit `aria-label` attributes
- **Color alone must not convey meaning**: Icons next to status text (closed PRs, draft issues) should include text labels, not color alone
- **Motion**: Respect `prefers-reduced-motion` media query; disable 800ms slow animations for users who've opted out
