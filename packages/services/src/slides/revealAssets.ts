/**
 * revealAssets.ts — every reveal.js and highlight.js URL a deck loads from a
 * CDN, built in one place, and the builtin and code themes the editor offers.
 * Browser-safe (no node imports): the slides client imports it through
 * `@classmoji/services/slides/reveal-assets`.
 *
 * Two kinds of version live here, on purpose:
 *
 * - The ENGINE versions: the reveal.js the slides app bundles (engine, core
 *   css, highlight plugin), the highlight.js that plugin bundles, and the
 *   installed highlight.js package. They must equal what is installed;
 *   `__tests__/revealAssets.test.ts` fails when they do not. The same test
 *   reads every reveal/highlight CDN URL in the repo and fails on one that
 *   names a version other than the one this module would use, names none
 *   (floats to latest), or is assembled from pieces it cannot read (a
 *   template or a concatenation). It checks versions, not authorship: a URL
 *   written out by hand at the right version passes.
 *
 * - The LOOK versions: the builtin theme stylesheets decks were built with,
 *   and the highlight styles whose colours changed after that. reveal.js 6's
 *   themes are not the 5.1.0 themes (beige, dracula, simple, serif, night,
 *   sky and league draw text or headings differently: fonts, sizes, weights,
 *   colours; every theme changed its link-hover and selection colours), and
 *   highlight.js 11.11.1's monokai colours numbers and `attr` tokens that
 *   11.9.0 left plain. These stay frozen until someone decides to change how
 *   existing decks look; they are not "left behind" pins.
 */

const JSDELIVR = 'https://cdn.jsdelivr.net/npm';
const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs';

/** The installed reveal.js (apps/slides/package.json pins it exactly). */
export const REVEAL_VERSION = '6.0.2';

/**
 * The highlight.js bundled into that reveal.js's highlight plugin: what
 * tokenises code in every deck, live and generated, so deck code styles follow it.
 */
export const HIGHLIGHT_VERSION = '11.11.1';

/**
 * The installed highlight.js package (the lockfile's), which highlights code
 * outside decks (the webapp's quiz chat). Equal to {@link HIGHLIGHT_VERSION}
 * today; the two can move apart, so each is checked against its own source.
 */
export const HIGHLIGHT_PACKAGE_VERSION = '11.11.1';

/** The reveal.js whose builtin theme stylesheets every deck is drawn with. */
export const REVEAL_THEME_VERSION = '5.1.0';

/**
 * highlight.js styles kept at the version decks were drawn with (11.9.0),
 * because the 11.11.1 file colours tokens differently. Every other style both
 * versions ship is byte-identical between them.
 */
export const HIGHLIGHT_STYLE_VERSIONS: Readonly<Record<string, string>> = {
  felipec: '11.9.0',
  monokai: '11.9.0',
};

/** reveal.js's builtin themes: the editor's theme picker, the MCP's set_theme. */
export const BUILTIN_THEMES = [
  'black',
  'white',
  'league',
  'beige',
  'night',
  'serif',
  'simple',
  'solarized',
  'moon',
  'dracula',
  'sky',
  'blood',
] as const;

/** The code themes the editor's picker offers (`value` is the highlight.js style a deck stores). */
export const CODE_THEMES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'github-dark', label: 'GitHub Dark' },
  { value: 'github', label: 'GitHub Light' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'atom-one-dark', label: 'Atom One Dark' },
  { value: 'vs2015', label: 'VS 2015' },
  { value: 'dracula', label: 'Dracula' },
];

/**
 * Code themes whose stylesheet is not `styles/<name>`, by the name decks
 * store. highlight.js ships Dracula only as a base16 style:
 * `styles/dracula.min.css` does not exist, and a deck that picked Dracula got
 * no code colours from it.
 */
export const HIGHLIGHT_STYLE_PATHS: Readonly<Record<string, string>> = {
  dracula: 'base16/dracula',
};

/** A code theme's stylesheet path below `styles/` (no extension). */
export function highlightStylePath(name: string): string {
  return Object.hasOwn(HIGHLIGHT_STYLE_PATHS, name) ? HIGHLIGHT_STYLE_PATHS[name] : name;
}

/**
 * The code theme a stylesheet path below `styles/` stands for, the inverse of
 * {@link highlightStylePath} (`base16/dracula` → `dracula`); null for a nested
 * style no code theme maps to.
 */
export function highlightStyleName(path: string): string | null {
  for (const [name, mapped] of Object.entries(HIGHLIGHT_STYLE_PATHS)) {
    if (mapped === path) return name;
  }
  return path.includes('/') ? null : path;
}

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

/** The version a highlight.js style is loaded at in decks. */
export function highlightStyleVersion(name: string): string {
  return Object.hasOwn(HIGHLIGHT_STYLE_VERSIONS, name)
    ? HIGHLIGHT_STYLE_VERSIONS[name]
    : HIGHLIGHT_VERSION;
}

/** The version a highlight.js style is loaded at on cdnjs (code outside decks). */
export function highlightStyleCdnjsVersion(name: string): string {
  return Object.hasOwn(HIGHLIGHT_STYLE_VERSIONS, name)
    ? HIGHLIGHT_STYLE_VERSIONS[name]
    : HIGHLIGHT_PACKAGE_VERSION;
}

/** A highlight.js style (minified) on jsDelivr. */
export function highlightStyleUrl(name: string): string {
  return `${JSDELIVR}/highlight.js@${highlightStyleVersion(name)}/styles/${highlightStylePath(name)}.min.css`;
}

/**
 * A highlight.js style (minified) on cdnjs, for code the installed package
 * highlights outside decks (the webapp's quiz chat loads it from there).
 */
export function highlightStyleCdnjsUrl(name: string): string {
  return `${CDNJS}/highlight.js/${highlightStyleCdnjsVersion(name)}/styles/${highlightStylePath(name)}.min.css`;
}
