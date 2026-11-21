/**
 * revealAssets.ts — every reveal.js and highlight.js URL a deck loads from a
 * CDN, built in one place. Browser-safe (no node imports): the slides client
 * imports it through `@classmoji/services/slides/reveal-assets`.
 *
 * Two kinds of version live here, on purpose:
 *
 * - The ENGINE versions: the reveal.js the slides app bundles (engine, core
 *   css, highlight plugin) and the highlight.js that plugin bundles. They must
 *   equal the installed packages; `__tests__/revealAssets.test.ts` fails when
 *   they do not, and when any reveal/highlight CDN URL in the repo is written
 *   by hand instead of through this module.
 *
 * - The LOOK versions: the builtin theme stylesheets decks were built with,
 *   and the highlight styles whose colours changed after that. reveal.js 6's
 *   themes are not the 5.1.0 themes (beige, dracula and simple lost their
 *   fonts and heading sizes; every theme changed its link and selection
 *   colours), and highlight.js 11.11.1's monokai colours numbers and `attr`
 *   tokens that 11.9.0 left plain. These stay frozen until someone decides to
 *   change how existing decks look; they are not "left behind" pins.
 */

const JSDELIVR = 'https://cdn.jsdelivr.net/npm';

/** The installed reveal.js (apps/slides/package.json pins it exactly). */
export const REVEAL_VERSION = '6.0.2';

/** The highlight.js bundled into that reveal.js's highlight plugin. */
export const HIGHLIGHT_VERSION = '11.11.1';

/** The reveal.js whose builtin theme stylesheets every deck is drawn with. */
export const REVEAL_THEME_VERSION = '5.1.0';

/**
 * highlight.js styles kept at the version decks were drawn with, because the
 * installed version's file colours tokens differently. A style not listed
 * here is byte-identical between that version and {@link HIGHLIGHT_VERSION}.
 */
export const HIGHLIGHT_STYLE_VERSIONS: Readonly<Record<string, string>> = {
  monokai: '11.9.0',
};

/** reveal.js's core stylesheet. */
export function revealCoreCssUrl(): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_VERSION}/dist/reveal.css`;
}

/** reveal.js itself (UMD build: defines `window.Reveal`). */
export function revealScriptUrl(): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_VERSION}/dist/reveal.js`;
}

/** reveal.js's highlight plugin (UMD build: defines `window.RevealHighlight`). */
export function revealHighlightPluginUrl(): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_VERSION}/dist/plugin/highlight.js`;
}

/** A stylesheet that ships with reveal.js's highlight plugin (`monokai`, `zenburn`). */
export function revealHighlightPluginCssUrl(name: string): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_VERSION}/dist/plugin/highlight/${name}.css`;
}

/** A builtin theme's stylesheet, at the version decks are drawn with. */
export function revealThemeUrl(name: string): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_THEME_VERSION}/dist/theme/${name}.css`;
}

/** The version a highlight.js style is loaded at. */
export function highlightStyleVersion(name: string): string {
  return Object.hasOwn(HIGHLIGHT_STYLE_VERSIONS, name)
    ? HIGHLIGHT_STYLE_VERSIONS[name]
    : HIGHLIGHT_VERSION;
}

/** A highlight.js style (minified) on jsDelivr. */
export function highlightStyleUrl(name: string): string {
  return `${JSDELIVR}/highlight.js@${highlightStyleVersion(name)}/styles/${name}.min.css`;
}

/** A highlight.js style (minified) on cdnjs, for pages whose policy names cdnjs. */
export function highlightStyleCdnjsUrl(name: string): string {
  return `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${highlightStyleVersion(name)}/styles/${name}.min.css`;
}
