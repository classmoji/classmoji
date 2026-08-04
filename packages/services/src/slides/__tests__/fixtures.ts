/**
 * Fixture inventory for the deck-engine gate (plan §9 P3).
 *
 * The starter fixture is driven off the REAL legacy generator
 * (apps/slides/app/utils/slideHelpers.server.ts). The importer fixture is a
 * hand-built replica of slidesComImporter.server.ts's generateSlideHtml output
 * (that function is module-private and its module pulls JSZip/prisma/
 * cloudinary, so driving it directly from a services unit test is not
 * feasible; the byte shape below mirrors it exactly). The canonical editor
 * fixture mirrors $slideId/route.tsx generateSlideHtml.
 */

import { generateSlideTemplate } from '../../../../../apps/slides/app/utils/slideHelpers.server.ts';

/** Deterministic 8-char id generator for tests. */
export function seededIdGen(prefix = 's'): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(8 - prefix.length, '0')}`;
}

const SCRIPTS_DEFAULT = `  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: true,
      transition: 'slide',
      plugins: [RevealHighlight]
    });
  </script>`;

export const SL_BLOCK_VISIBILITY_CSS = `
    /* Override slides.com animation system - make all elements fully visible */
    .sl-block-content,
    .sl-block-content[data-animation-type],
    .sl-block-content[data-animation-type="fade-in"],
    .sl-block-content[data-animation-type="fade-out"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
  `;

// ─── 1. Starter template (REAL legacy generator output) ─────────────────────
// Covers: monokai-via-reveal-plugin link, missing data-theme, inline <style>,
// center:false, no section ids.
export const STARTER_FIXTURE = generateSlideTemplate('Intro to JavaScript');

// ─── 2. Importer-shaped doc (media-pair variant) ────────────────────────────
// Covers: light/dark media-query theme + code pairs with `not all` fallbacks,
// sl-blocks, sl-block-visibility override style, 960/700/center:false.
export const IMPORTER_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Imported Deck</title>
  <!-- Reveal.js core CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <!-- Light mode slide theme -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="(prefers-color-scheme: light)">
  <!-- Dark mode slide theme -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/black.css" media="(prefers-color-scheme: dark)">
  <!-- Fallback for browsers without prefers-color-scheme support -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" media="not all and (prefers-color-scheme)">
  <!-- Light mode code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css" media="(prefers-color-scheme: light)">
  <!-- Dark mode code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
  <!-- Fallback code theme for browsers without prefers-color-scheme support -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css" media="not all and (prefers-color-scheme)">
  <style>${SL_BLOCK_VISIBILITY_CSS}</style>
</head>
<body class="">
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-transition="fade"><div class="sl-block" data-block-type="text" style="width: 600px; left: 80px; top: 120px;"><div class="sl-block-content" data-animation-type="fade-in"><h2>Imported Title</h2></div></div></section>
<section><div class="sl-block" data-block-type="image"><div class="sl-block-content"><img src="assets/diagram.png" alt="Diagram"></div></div><aside class="notes">Imported speaker notes</aside></section>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: false,
      transition: 'slide',
      width: 960,
      height: 700,
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;

// ─── 3. Importer shared-theme variant ───────────────────────────────────────
// Covers: shared: theme with .slidesthemes/ asset links (consumed, never
// extraCss), body classes, no code links (codeTheme defaults).
export const SHARED_THEME_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared Theme Deck</title>
  <!-- Reveal.js core CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <!-- slides.com full CSS (includes fonts, themes, sl-block styles) -->
  <link rel="stylesheet" href="https://test-org.github.io/content-test-org-26w/.slidesthemes/my-theme/lib/offline-v2.css">
  <!-- Custom theme CSS (user customizations from slides.com) -->
  <link rel="stylesheet" href="https://test-org.github.io/content-test-org-26w/.slidesthemes/my-theme/custom-theme.css">
  <style>${SL_BLOCK_VISIBILITY_CSS}</style>
</head>
<body class="reveal-viewport theme-font-montserrat theme-color-white-blue">
  <div class="reveal" data-theme="shared:my-theme">
    <div class="slides">
<section><div class="sl-block" data-block-type="text"><div class="sl-block-content"><h1>Shared</h1></div></div></section>
<section><div class="sl-block" data-block-type="text"><div class="sl-block-content"><p>Body</p></div></div></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

/** Opts matching SHARED_THEME_FIXTURE for byte-stable regeneration. */
export const SHARED_THEME_URLS = {
  libCssUrl:
    'https://test-org.github.io/content-test-org-26w/.slidesthemes/my-theme/lib/offline-v2.css',
  customThemeUrl:
    'https://test-org.github.io/content-test-org-26w/.slidesthemes/my-theme/custom-theme.css',
  bodyClasses: 'reveal-viewport theme-font-montserrat theme-color-white-blue',
};

// ─── 4. Canonical editor output ─────────────────────────────────────────────
// Covers: single theme link, highlight.js styles link, data-cm-id already
// present, leaf notes.
export const CANONICAL_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Presentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <!-- Reveal.js theme -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/league.css">
  <!-- Code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/monokai.min.css">
</head>
<body class="">
  <div class="reveal" data-theme="league" data-code-theme="monokai">
    <div class="slides">
<section data-cm-id="aaaa1111"><h2>First</h2><p>Hello world</p></section>
<section data-cm-id="bbbb2222"><h2>Second</h2><aside class="notes">Remember to pause</aside></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 5. Hand-edited runtime-cruft doc ───────────────────────────────────────
// Covers: editing-mode/slide-hidden/stack/present/past/future classes,
// aria-hidden, HTML hidden, display in inline style (only that property
// removed), data-hidden promotion.
export const CRUFT_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Cruft Deck</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section class="present editing-mode keep-me" aria-hidden="true" style="display: none; color: red;" data-cm-id="cruft001"><h2>Painted</h2></section>
<section class="slide-hidden" data-hidden="true" hidden data-cm-id="cruft002"><h2>Hidden slide</h2></section>
<section class="stack" data-cm-id="cruft003">
<section class="past" data-cm-id="cruft004"><p>child one</p></section>
<section class="future" data-cm-id="cruft005"><p>child two</p></section>
</section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 6. Vertical stacks with container attrs + stack-level notes ────────────
export const STACKS_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Stacks</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/night.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="night" data-code-theme="github">
    <div class="slides">
<section data-cm-id="flat0001"><h2>Flat</h2></section>
<section data-cm-id="stack001" data-transition="zoom">
<section data-cm-id="leaf0001"><h2>Vertical 1</h2></section>
<section data-cm-id="leaf0002"><h2>Vertical 2</h2><aside class="notes">child note</aside></section>
<aside class="notes">stack-level note</aside>
</section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 7. Sandpack sl-block with JSON payload ─────────────────────────────────
// Covers: <script type="application/json" data-sandpack-files> payload —
// byte-identical through round-trip.
export const SANDPACK_JSON = `{"/App.js":{"code":"const x = 1 < 2 && 'y';\\nexport default function App() {\\n  return <div>{\\"a & b\\"}</div>;\\n}","active":true},"/styles.css":{"code":"body { margin: 0; }"}}`;

export const SANDPACK_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Sandpack Deck</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="sand0001"><h2>Playground</h2><div class="sl-block" data-block-type="sandpack"><div class="sl-block-content"><div class="sandpack-embed" data-template="react" data-theme="auto" data-layout="preview-right"><script type="application/json" data-sandpack-files>${SANDPACK_JSON}</script></div></div></div></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 8. Escaped pre>code ────────────────────────────────────────────────────
// Covers: escaped entities inside code blocks stay escaped through round-trip.
export const ESCAPED_CODE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Code Deck</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="code0001"><h2>HTML sample</h2><pre><code class="language-html">&lt;div class="box"&gt;
  &lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;
&lt;/div&gt;</code></pre></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 9. data-hidden + data-background-* + non-default transition ────────────
export const BACKGROUND_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Backgrounds</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/dracula.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="dracula" data-code-theme="github">
    <div class="slides">
<section data-cm-id="bg000001" data-background-color="#ff5500"><h2>Solid</h2></section>
<section data-cm-id="bg000002" data-background-image="https://example.com/img.png?a=1&amp;b=2" data-background-size="cover" data-hidden="true"><h2>Hidden image bg</h2></section>
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: true,
      transition: 'fade',
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;

// ─── 10. Multi-aside section (tolerant notes matching) ──────────────────────
// Second aside uses upper-case tag, single quotes, and an extra class.
export const MULTI_ASIDE_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Notes Deck</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="note0001"><h2>Talk</h2><aside class="notes">First note</aside><p>Body between asides</p><ASIDE class='notes extra'>Second note</ASIDE></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 11. Quote-bearing attr values ──────────────────────────────────────────
export const QUOTE_ATTR_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Quotes</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="quot0001" data-caption='He said "hi" &amp; left' data-note="a &lt; b"><h2>Quoted</h2></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 12. Duplicate data-cm-id (uniqueness enforcement) ──────────────────────
export const DUP_ID_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Dup Ids</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="dupdupdu"><h2>Keeper</h2></section>
<section data-cm-id="dupdupdu"><h2>Re-minted</h2></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 13. Stray builtin link + genuine extraCss link ─────────────────────────
// Covers: builtin-shaped link that doesn't fit → dropped with warning, NEVER
// extraCss; unrecognized non-theme link → extraCss with media preserved.
export const STRAY_LINK_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Stray Links</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/beige.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" media="print">
</head>
<body>
  <div class="reveal" data-theme="white" data-code-theme="github">
    <div class="slides">
<section data-cm-id="stray001"><h2>Links</h2></section>
    </div>
  </div>
${SCRIPTS_DEFAULT}
</body>
</html>`;

// ─── 14. Zero root sections → DECK_PARSE_FAILED ─────────────────────────────
export const ZERO_SECTIONS_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Empty</title>
</head>
<body>
  <div class="reveal">
    <div class="slides"></div>
  </div>
</body>
</html>`;

// ─── Editor fragment (RevealSlides getCurrentContent shape) ─────────────────
export const EDITOR_FRAGMENT = `<div class="slides" data-theme="moon" data-code-theme="github-dark">
<section data-cm-id="frag0001"><h2>One</h2></section>
<section data-cm-id="frag0002"><h2>Two</h2><aside class="notes">frag note</aside></section>
<section data-cm-id="frag0003">
<section data-cm-id="frag0004"><p>nested</p></section>
</section>
</div>`;

/** All full-document fixtures that must satisfy the round-trip invariants. */
export const ROUND_TRIP_FIXTURES: Array<{
  name: string;
  html: string;
  themeUrls?: { libCssUrl?: string; customThemeUrl?: string; bodyClasses?: string };
}> = [
  { name: 'starter-template', html: STARTER_FIXTURE },
  { name: 'importer-media-pair', html: IMPORTER_FIXTURE },
  { name: 'importer-shared-theme', html: SHARED_THEME_FIXTURE, themeUrls: SHARED_THEME_URLS },
  { name: 'canonical-editor', html: CANONICAL_FIXTURE },
  { name: 'hand-edited-cruft', html: CRUFT_FIXTURE },
  { name: 'vertical-stacks', html: STACKS_FIXTURE },
  { name: 'sandpack-payload', html: SANDPACK_FIXTURE },
  { name: 'escaped-pre-code', html: ESCAPED_CODE_FIXTURE },
  { name: 'hidden-and-backgrounds', html: BACKGROUND_FIXTURE },
  { name: 'multi-aside', html: MULTI_ASIDE_FIXTURE },
  { name: 'quote-attr-values', html: QUOTE_ATTR_FIXTURE },
  { name: 'duplicate-ids', html: DUP_ID_FIXTURE },
  { name: 'stray-theme-link', html: STRAY_LINK_FIXTURE },
];
