/**
 * revealAssets.ts — every reveal.js and highlight.js URL a deck loads from a
 * CDN, built in one place, and the builtin and code themes the editor offers.
 * Browser-safe (no node imports): the slides client imports it through
 * `@classmoji/services/slides/reveal-assets`.
 *
 * Every version here equals what is installed: the reveal.js the slides app
 * bundles (engine, core css, highlight plugin, builtin themes), the
 * highlight.js that plugin bundles (every deck code style), and the installed
 * highlight.js package (code styles outside decks).
 * `__tests__/revealAssets.test.ts` fails when they do not. The same test
 * reads every reveal/highlight CDN URL in the repo and fails on one that
 * names a version other than the one this module would use, names none
 * (floats to latest), or is assembled from pieces it cannot read (a template
 * or a concatenation). It checks versions, not authorship: a URL written out
 * by hand at the right version passes.
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

/** A builtin theme's stylesheet. */
export function revealThemeUrl(name: string): string {
  return `${JSDELIVR}/reveal.js@${REVEAL_VERSION}/dist/theme/${name}.css`;
}

/** A highlight.js style (minified) on jsDelivr, for code in decks. */
export function highlightStyleUrl(name: string): string {
  return `${JSDELIVR}/highlight.js@${HIGHLIGHT_VERSION}/styles/${highlightStylePath(name)}.min.css`;
}

/**
 * A highlight.js style (minified) on cdnjs, for code the installed package
 * highlights outside decks (the webapp's quiz chat loads it from there).
 */
export function highlightStyleCdnjsUrl(name: string): string {
  return `${CDNJS}/highlight.js/${HIGHLIGHT_PACKAGE_VERSION}/styles/${highlightStylePath(name)}.min.css`;
}
