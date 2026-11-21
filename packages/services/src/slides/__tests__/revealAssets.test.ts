/**
 * One source of truth for every reveal.js / highlight.js URL a deck loads.
 *
 * - The engine versions in revealAssets.ts equal the installed packages
 *   (apps/slides/package.json, the lockfile, node_modules).
 * - Every reveal/highlight CDN URL in the repo names the version
 *   revealAssets.ts would use for it (jsDelivr, unpkg, cdnjs, the highlight.js
 *   cdn-release and cdn-assets builds, `@` written `%40`), and none names no
 *   version or is assembled from pieces the scan cannot read. It checks
 *   versions, not authorship: a URL written out by hand at the right version
 *   passes. The scan lists files with git, so it needs a git checkout.
 * - The generated document loads exactly those URLs, every theme and code
 *   theme the editor offers names a file the installed packages ship, and the
 *   parser reads both generations of stored documents (5.1.0 paths and 6.x
 *   paths) and both Dracula stylesheet paths.
 */

import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateDeckHtml, parseDeckHtml } from '../deckHtml.ts';
import {
  BUILTIN_THEMES,
  CODE_THEMES,
  HIGHLIGHT_PACKAGE_VERSION,
  HIGHLIGHT_STYLE_VERSIONS,
  HIGHLIGHT_VERSION,
  REVEAL_THEME_VERSION,
  REVEAL_VERSION,
  highlightStyleCdnjsUrl,
  highlightStyleCdnjsVersion,
  highlightStyleName,
  highlightStyleUrl,
  highlightStyleVersion,
  revealCoreCssUrl,
  revealHighlightPluginCssUrl,
  revealHighlightPluginUrl,
  revealScriptUrl,
  revealThemeUrl,
} from '../revealAssets.ts';
import type { DeckJson } from '../deckTypes.ts';
import { IMPORTER_FIXTURE, STARTER_FIXTURE, seededIdGen } from './fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const run = promisify(execFile);
const text = (path: string): Promise<string> => readFile(join(ROOT, path), 'utf8');
const exists = (path: string): Promise<boolean> =>
  access(join(ROOT, path)).then(
    () => true,
    () => false
  );

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(path)) as Record<string, unknown>;
}

async function lockVersion(pkg: string): Promise<string | undefined> {
  const lock = (await readJson('package-lock.json')) as {
    packages: Record<string, { version?: string }>;
  };
  return lock.packages[`node_modules/${pkg}`]?.version;
}

/** Is ROOT the top of a git checkout? (A tarball or a Docker build context is not.) */
const GIT_CHECKOUT = await run('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT }).then(
  async ({ stdout }) => (await realpath(stdout.trim())) === (await realpath(ROOT)),
  () => false
);

describe('engine versions match the installed packages', () => {
  it('reveal.js: apps/slides pins it exactly, the lockfile and node_modules agree', async () => {
    const slides = (await readJson('apps/slides/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(slides.dependencies['reveal.js']).toBe(REVEAL_VERSION);
    expect(await lockVersion('reveal.js')).toBe(REVEAL_VERSION);
    expect((await readJson('node_modules/reveal.js/package.json')).version).toBe(REVEAL_VERSION);
  });

  it('highlight.js: the installed package is the lockfile one', async () => {
    expect(await lockVersion('highlight.js')).toBe(HIGHLIGHT_PACKAGE_VERSION);
    expect((await readJson('node_modules/highlight.js/package.json')).version).toBe(
      HIGHLIGHT_PACKAGE_VERSION
    );
  });

  it('highlight.js: the installed highlight plugin bundles HIGHLIGHT_VERSION', async () => {
    const plugin = await text('node_modules/reveal.js/dist/plugin/highlight.js');
    const versions = new Set([...plugin.matchAll(/[`'"](11\.\d+\.\d+)[`'"]/g)].map(m => m[1]));
    expect([...versions]).toEqual([HIGHLIGHT_VERSION]);
  });

  it('a frozen highlight style really is frozen (an older version than the installed one)', () => {
    for (const version of Object.values(HIGHLIGHT_STYLE_VERSIONS)) {
      expect(version).not.toBe(HIGHLIGHT_VERSION);
    }
    expect(REVEAL_THEME_VERSION).not.toBe(REVEAL_VERSION);
  });

  it('the installed reveal.js still draws the play/unmute button the capture pages hide', async () => {
    // apps/slides hides `.r-media-play-button` in card images and deck renders.
    expect(await text('node_modules/reveal.js/dist/reveal.js')).toContain('r-media-play-button');
  });
});

/**
 * Files that reproduce documents of the OLD generation, as they sit in
 * content repos today (5.1.0 engine URLs and all). Each is a corpus the
 * parser must keep reading; none of them is loaded by a running app.
 */
const OLD_GENERATION_CORPUS = new Set([
  // The legacy starter generator: decks it wrote still exist (fixture source).
  'apps/slides/app/utils/slideHelpers.server.ts',
  'packages/collab/src/deck/__tests__/kitchenSink.ts',
  'packages/services/src/content/extract/__tests__/fixtures/sample-deck.index.html',
  'packages/services/src/slides/__tests__/fixtures.ts',
  'packages/services/src/slides/__tests__/slideContent.service.test.ts',
  'packages/services/src/slides/__tests__/revealAssets.test.ts',
  'scripts/collab-dev/kitchenSinkDeck.ts',
]);

/** The module every URL is built in. */
const ASSETS_MODULE = 'packages/services/src/slides/revealAssets.ts';

const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|json|html?|css|md|mdx|astro|vue|svelte|ya?ml|toml|sh|txt)$|Dockerfile/;

/**
 * `[file, text]` for every tracked (or new, not ignored) text file, submodules
 * included. A submodule that is not checked out (the private `apps/ai-agent`
 * for contributors without access) lists nothing and is skipped.
 */
async function trackedTextFiles(): Promise<Array<[string, string]>> {
  const git = async (args: string[]) =>
    (
      await run('git', ['ls-files', '-z', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout.split('\0');
  const listing = new Set([
    ...(await git(['--recurse-submodules'])),
    ...(await git(['--others', '--exclude-standard'])),
  ]);
  const files = [...listing].filter(
    file => file && TEXT_FILE.test(file) && !file.startsWith('.claude/')
  );
  const read = await Promise.all(
    files.map(async file => ((await exists(file)) ? [file, await text(file)] : null))
  );
  return read.filter((entry): entry is [string, string] => entry !== null);
}

interface Finding {
  file: string;
  url: string;
  expected: string;
}

/** `@` as written in a URL, plain or percent-encoded. */
const AT = '(?:@|%40)';
const SEMVER = '(\\d+\\.\\d+\\.\\d+)';
/** A highlight.js style path below `styles/` (one folder deep at most), no extension. */
const STYLE = '((?:[\\w-]+\\/)?[\\w.-]+?)(?:\\.min)?\\.css';

/** The version a reveal.js file is loaded at: themes at the look version, the rest at the engine's. */
const revealExpected = (path: string) =>
  /\/theme\//.test(path) ? REVEAL_THEME_VERSION : REVEAL_VERSION;
/** The version a highlight.js file is loaded at in decks (styles may be frozen). */
const deckStyleExpected = (style: string | undefined) => {
  const name = style ? highlightStyleName(style) : null;
  return name ? highlightStyleVersion(name) : HIGHLIGHT_VERSION;
};
/** …and on cdnjs, for code the installed package highlights outside decks. */
const cdnjsStyleExpected = (style: string | undefined) => {
  const name = style ? highlightStyleName(style) : null;
  return name ? highlightStyleCdnjsVersion(name) : HIGHLIGHT_PACKAGE_VERSION;
};

/** Every versioned reveal/highlight CDN reference in `text` and the version it must carry. */
function pinnedReferences(text: string): Array<{ url: string; version: string; expected: string }> {
  const rules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    // jsDelivr / unpkg / esm.sh / any npm CDN
    [new RegExp(`reveal\\.js${AT}${SEMVER}(\\/[\\w./-]*)?`, 'g'), m => revealExpected(m[2] ?? '')],
    [
      new RegExp(`ajax\\/libs\\/reveal\\.js\\/${SEMVER}(\\/[\\w./-]*)?`, 'g'),
      m => revealExpected(m[2] ?? ''),
    ],
    [
      new RegExp(`highlight\\.js${AT}${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'),
      m => deckStyleExpected(m[2]),
    ],
    [
      new RegExp(`@highlightjs\\/cdn-assets${AT}${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'),
      m => deckStyleExpected(m[2]),
    ],
    [
      new RegExp(`highlightjs\\/cdn-release${AT}${SEMVER}(?:\\/build\\/styles\\/${STYLE})?`, 'g'),
      m => deckStyleExpected(m[2]),
    ],
    [
      new RegExp(`ajax\\/libs\\/highlight\\.js\\/${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'),
      m => cdnjsStyleExpected(m[2]),
    ],
  ];
  const out: Array<{ url: string; version: string; expected: string }> = [];
  for (const [re, expected] of rules) {
    for (const m of text.matchAll(re))
      out.push({ url: m[0], version: m[1], expected: expected(m) });
  }
  return out;
}

/** A version the scan cannot pin: a template, a quote (concatenation), a range or tag, or major/minor only. */
const LOOSE_VERSION = `(?:\\$\\{|['"\`]|latest|next|[\\^~]|\\d+(?:\\.\\d+)?(?![.\\d]))`;
const PACKAGE = '(?:reveal\\.js|highlight\\.js|@highlightjs\\/cdn-assets)';

/** CDN URLs for reveal/highlight that name no version, or one assembled out of sight. */
function looseReferences(text: string): string[] {
  return [
    // A loose version after the package name.
    ...text.matchAll(
      new RegExp(`(?:${PACKAGE}|highlightjs\\/cdn-release)${AT}${LOOSE_VERSION}`, 'g')
    ),
    // No version at all: the CDN serves its latest.
    ...text.matchAll(
      new RegExp(
        `(?:\\/npm\\/|unpkg\\.com\\/|esm\\.sh\\/)${PACKAGE}(?=[/'"\`?#\\s]|$)|gh\\/highlightjs\\/cdn-release(?=[/'"\`?#\\s]|$)`,
        'gm'
      )
    ),
    // cdnjs: anything but a full version after the library.
    ...text.matchAll(/ajax\/libs\/(?:reveal|highlight)\.js\/(?!\d+\.\d+\.\d+)/g),
  ].map(m => m[0]);
}

/** What the scan reports for `text`: wrong pins and loose references. */
function findings(text: string): string[] {
  return [
    ...pinnedReferences(text)
      .filter(ref => ref.version !== ref.expected)
      .map(ref => `${ref.url} (expected ${ref.expected})`),
    ...looseReferences(text),
  ];
}

describe('the CDN URL scanner', () => {
  const flagged: Array<[string, string]> = [
    ['a stale engine pin', 'https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js'],
    ['a stale style pin', 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css'],
    [
      'a theme at the engine version',
      'https://cdn.jsdelivr.net/npm/reveal.js@6.0.2/dist/theme/white.css',
    ],
    [
      'a frozen style at the new version',
      'https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/monokai.min.css',
    ],
    [
      'Dracula at the wrong version',
      'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/base16/dracula.min.css',
    ],
    [
      'a stale cdnjs style',
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
    ],
    [
      'a frozen style on cdnjs at the new version',
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/monokai.min.css',
    ],
    ['reveal.js on cdnjs', 'https://cdnjs.cloudflare.com/ajax/libs/reveal.js/5.1.0/reveal.min.css'],
    ['an `@` written %40', 'https://cdn.jsdelivr.net/npm/reveal.js%405.1.0/dist/reveal.css'],
    [
      'highlight.js cdn-release',
      'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css',
    ],
    [
      'highlight.js cdn-assets',
      'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css',
    ],
    ['unpkg', 'https://unpkg.com/reveal.js@5.1.0/dist/reveal.js'],
    ['esm.sh', 'https://esm.sh/reveal.js@5.1.0'],
    ['protocol-relative', '//cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js'],
    ['an unversioned reveal.js', 'https://cdn.jsdelivr.net/npm/reveal.js/dist/reveal.css'],
    [
      'an unversioned highlight.js',
      'https://cdn.jsdelivr.net/npm/highlight.js/styles/github.min.css',
    ],
    ['an unversioned unpkg', '"https://unpkg.com/reveal.js"'],
    [
      'an unversioned cdn-release',
      'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/styles/github.min.css',
    ],
    ['a templated version', '`https://cdn.jsdelivr.net/npm/reveal.js@${v}/dist/reveal.js`'],
    [
      'a templated cdnjs version',
      '`https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${v}/styles/github.min.css`',
    ],
    ['a concatenated version', '"https://cdn.jsdelivr.net/npm/reveal.js@" + v + "/dist/reveal.js"'],
    [
      'a version split across a template',
      '`https://cdn.jsdelivr.net/npm/reveal.js@` +\n  `5.1.0/dist/reveal.js`',
    ],
    ['a major-only version', 'https://cdn.jsdelivr.net/npm/reveal.js@6/dist/reveal.css'],
    [
      'a major-only style version',
      'https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css',
    ],
    ['latest', 'https://cdn.jsdelivr.net/npm/reveal.js@latest/dist/reveal.js'],
    [
      'a range',
      'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@^11.9.0/styles/github.min.css',
    ],
  ];
  for (const [shape, url] of flagged) {
    it(`flags ${shape}`, () => {
      expect(findings(url), url).toHaveLength(1);
    });
  }

  const passed: Array<[string, string]> = [
    ['the engine', revealScriptUrl()],
    ['the core css', revealCoreCssUrl()],
    ['the highlight plugin', revealHighlightPluginUrl()],
    ['a builtin theme', revealThemeUrl('white')],
    ['a frozen style', highlightStyleUrl('monokai')],
    ['Dracula', highlightStyleUrl('dracula')],
    ['a cdnjs style', highlightStyleCdnjsUrl('github')],
    ['a frozen cdnjs style', highlightStyleCdnjsUrl('monokai')],
    [
      'a URL written by hand at the right version',
      'https://cdn.jsdelivr.net/npm/reveal.js@6.0.2/dist/reveal.js',
    ],
    [
      'cdn-assets at the right version',
      `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HIGHLIGHT_VERSION}/styles/github.min.css`,
    ],
    ['an npm module specifier', "import 'reveal.js/dist/reveal.css';"],
    ['a node_modules path', 'node_modules/highlight.js/styles/github.min.css'],
  ];
  for (const [shape, url] of passed) {
    it(`passes ${shape}`, () => {
      expect(findings(url), url).toEqual([]);
    });
  }
});

describe.runIf(GIT_CHECKOUT)('every reveal/highlight CDN URL in the repo', () => {
  let files: Array<[string, string]> = [];
  beforeAll(async () => {
    files = await trackedTextFiles();
  });

  it('scans the files that load reveal (sanity: the walk sees them)', () => {
    const names = files.map(([file]) => file);
    expect(names).toContain(ASSETS_MODULE);
    expect(names).toContain('apps/slides/app/components/RevealSlides.tsx');
  });

  it('carries the installed version (or the frozen look version for themes and frozen styles)', () => {
    const wrong: Finding[] = [];
    for (const [file, text] of files) {
      if (OLD_GENERATION_CORPUS.has(file)) continue;
      for (const ref of pinnedReferences(text)) {
        if (ref.version !== ref.expected)
          wrong.push({ file, url: ref.url, expected: ref.expected });
      }
    }
    expect(wrong).toEqual([]);
  });

  it('names a version the scan can read (none floating, none assembled from pieces)', () => {
    const loose: Array<{ file: string; url: string }> = [];
    for (const [file, text] of files) {
      if (file === ASSETS_MODULE || OLD_GENERATION_CORPUS.has(file)) continue;
      for (const url of looseReferences(text)) loose.push({ file, url });
    }
    expect(loose).toEqual([]);
  });
});

describe.skipIf(GIT_CHECKOUT)('every reveal/highlight CDN URL in the repo', () => {
  it('needs a git checkout', () => {
    throw new Error(
      `The repo-wide CDN URL guard lists files with \`git ls-files\` and needs a git checkout; ${ROOT} is not one (a tarball or a Docker build context). Run the tests from a clone.`
    );
  });
});

const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'a1b2c3d4', html: '<h1>Hi</h1><pre><code class="language-js">let x = 1;</code></pre>' },
  ],
};

/** Every http(s) URL a document references in an href/src attribute. */
function documentUrls(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="(https:\/\/[^"]+)"/g)].map(m => m[1]);
}

/** The installed file a jsDelivr URL names (`/npm/<pkg>@<v>/<path>` → `node_modules/<pkg>/<path>`). */
function installedPath(url: string): string {
  const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/([^@]+)@[^/]+\/(.+)$/);
  if (!m) throw new Error(`not a jsDelivr npm URL: ${url}`);
  return `node_modules/${m[1]}/${m[2]}`;
}

describe('the generated document', () => {
  it('loads the engine, core css and highlight plugin at the installed version', () => {
    const html = generateDeckHtml(DECK, { title: 'T' });
    expect(documentUrls(html)).toEqual([
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.css`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_THEME_VERSION}/dist/theme/white.css`,
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/github.min.css`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.js`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/plugin/highlight.js`,
    ]);
  });

  it('keeps monokai at its frozen version, light/dark pairs included', () => {
    const html = generateDeckHtml(
      {
        ...DECK,
        theme: 'night',
        themeDark: 'black',
        codeTheme: 'monokai',
        codeThemeDark: 'github-dark',
      },
      { title: 'T' }
    );
    const urls = documentUrls(html);
    expect(urls).toContain(
      'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/monokai.min.css'
    );
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/github-dark.min.css`
    );
    expect(urls).toContain(revealThemeUrl('black'));
  });

  it('names only engine files the installed reveal.js ships', async () => {
    for (const url of [
      revealCoreCssUrl(),
      revealScriptUrl(),
      revealHighlightPluginUrl(),
      revealHighlightPluginCssUrl('monokai'),
    ]) {
      expect(url).toContain(`/reveal.js@${REVEAL_VERSION}/`);
      expect(await exists(installedPath(url)), url).toBe(true);
    }
  });

  // Themes load at 5.1.0 and frozen styles at 11.9.0 while 6.0.2 and 11.11.1
  // are installed: the installed file stands in for the CDN one (same names).
  it('names a stylesheet that exists for every builtin theme the editor offers', async () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThan(0);
    for (const theme of BUILTIN_THEMES) {
      const url = revealThemeUrl(theme);
      expect(await exists(installedPath(url)), url).toBe(true);
    }
  });

  it('names a stylesheet that exists for every code theme the editor offers', async () => {
    expect(CODE_THEMES.length).toBeGreaterThan(0);
    for (const { value } of CODE_THEMES) {
      const url = highlightStyleUrl(value);
      expect(await exists(installedPath(url)), url).toBe(true);
      const cdnjs = highlightStyleCdnjsUrl(value);
      expect(cdnjs.slice(cdnjs.indexOf('/styles/'))).toBe(url.slice(url.indexOf('/styles/')));
    }
  });

  it('defines the globals the init script calls (UMD builds)', async () => {
    expect((await text('node_modules/reveal.js/dist/reveal.js')).slice(0, 600)).toContain(
      '.Reveal='
    );
    expect((await text('node_modules/reveal.js/dist/plugin/highlight.js')).slice(0, 600)).toContain(
      '.RevealHighlight='
    );
  });

  it('cdnjs styles (code outside decks) follow the installed package, frozen ones excepted', () => {
    expect(highlightStyleCdnjsUrl('github')).toBe(
      `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HIGHLIGHT_PACKAGE_VERSION}/styles/github.min.css`
    );
    expect(highlightStyleCdnjsUrl('monokai')).toBe(
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/monokai.min.css'
    );
  });

  it('every frozen style is one the frozen version ships', async () => {
    for (const name of Object.keys(HIGHLIGHT_STYLE_VERSIONS)) {
      expect(highlightStyleUrl(name)).toContain(`@${HIGHLIGHT_STYLE_VERSIONS[name]}/styles/`);
      // and one the installed package still ships (a deck may name it)
      expect(await exists(`node_modules/highlight.js/styles/${name}.min.css`), name).toBe(true);
    }
  });
});

describe('both generations of stored documents parse the same', () => {
  const PLUGIN_CSS_OLD =
    'https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/monokai.css';
  const PLUGIN_CSS_NEW = revealHighlightPluginCssUrl('monokai');

  it('the reveal plugin stylesheet names the code theme at either path', () => {
    for (const href of [PLUGIN_CSS_OLD, PLUGIN_CSS_NEW]) {
      const doc = STARTER_FIXTURE.replace(PLUGIN_CSS_OLD, href);
      expect(doc).toContain(href);
      const { deck, warnings } = parseDeckHtml(doc, { idGen: seededIdGen() });
      expect(warnings).toEqual([]);
      expect(deck.codeTheme).toBe('monokai');
      expect(deck.extraCss).toBeUndefined();
    }
  });

  it('an old-generation document and its regeneration parse to the same deck', () => {
    for (const fixture of [IMPORTER_FIXTURE, STARTER_FIXTURE]) {
      expect(fixture).toContain('reveal.js@5.1.0/dist/reveal.css');
      const old = parseDeckHtml(fixture, { idGen: seededIdGen() });
      const regenerated = generateDeckHtml(old.deck, { title: 'T' });
      expect(regenerated).not.toContain('reveal.js@5.1.0/dist/reveal');
      expect(regenerated).not.toContain('/plugin/highlight/highlight.js');
      const again = parseDeckHtml(regenerated, { idGen: seededIdGen() });
      expect(again.warnings).toEqual([]);
      expect(again.deck).toEqual(old.deck);
    }
  });

  it('a regenerated document differs from its old-generation self only in the engine lines', () => {
    const deck = parseDeckHtml(IMPORTER_FIXTURE, { idGen: seededIdGen() }).deck;
    const now = generateDeckHtml(deck, { title: 'T' }).split('\n');
    const before = now.map(line =>
      line
        .replace(
          `reveal.js@${REVEAL_VERSION}/dist/plugin/highlight.js`,
          'reveal.js@5.1.0/plugin/highlight/highlight.js'
        )
        .replace(`reveal.js@${REVEAL_VERSION}/`, 'reveal.js@5.1.0/')
        .replace(`highlight.js@${HIGHLIGHT_VERSION}/`, 'highlight.js@11.9.0/')
    );
    const changed = now.filter((line, i) => line !== before[i]);
    expect(changed.map(line => line.trim().replace(/(href|src)="[^"]*"/, '$1="…"'))).toEqual([
      '<link rel="stylesheet" href="…">',
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: light)">',
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: dark)">',
      '<link rel="stylesheet" href="…" media="not all and (prefers-color-scheme)">',
      '<script src="…"></script>',
      '<script src="…"></script>',
    ]);
  });
});

describe('the Dracula code theme', () => {
  const DRACULA: DeckJson = { ...DECK, codeTheme: 'dracula' };
  /** What decks that picked Dracula were generated with: a stylesheet that does not exist. */
  const BROKEN = 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/dracula.min.css';

  it('loads the base16 stylesheet highlight.js ships it as', () => {
    const urls = documentUrls(generateDeckHtml(DRACULA, { title: 'T' }));
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/base16/dracula.min.css`
    );
    expect(highlightStyleName('base16/dracula')).toBe('dracula');
    expect(highlightStyleName('base16/solarized-dark')).toBeNull();
  });

  /** The document with its `data-code-theme` removed, so only the link names the theme. */
  const linkOnly = (doc: string) => doc.replace(/ data-code-theme="[^"]*"/, '');

  it('a document carrying the new link reads back as dracula, light/dark pairs included', () => {
    for (const deck of [DRACULA, { ...DECK, codeTheme: 'github', codeThemeDark: 'dracula' }]) {
      const doc = generateDeckHtml(deck, { title: 'T' });
      for (const html of [doc, linkOnly(doc)]) {
        const parsed = parseDeckHtml(html, { idGen: seededIdGen() });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.deck.extraCss).toBeUndefined();
        expect(parsed.deck.codeTheme).toBe(deck.codeTheme);
        expect(parsed.deck.codeThemeDark).toBe(deck.codeThemeDark);
      }
    }
  });

  it('a stored document with the old (missing) stylesheet still reads as dracula, and regenerates the new one', () => {
    const current = highlightStyleUrl('dracula');
    const stored = generateDeckHtml(DRACULA, { title: 'T' }).replace(current, BROKEN);
    expect(stored).toContain(BROKEN);
    for (const html of [stored, linkOnly(stored)]) {
      const parsed = parseDeckHtml(html, { idGen: seededIdGen() });
      expect(parsed.warnings).toEqual([]);
      expect(parsed.deck.extraCss).toBeUndefined();
      expect(parsed.deck.codeTheme).toBe('dracula');
      const regenerated = generateDeckHtml(parsed.deck, { title: 'T' });
      expect(regenerated).toContain(current);
      expect(regenerated).not.toContain(BROKEN);
    }
  });

  it('a nested style no code theme maps to stays an extra stylesheet', () => {
    const href = `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/base16/solarized-dark.min.css`;
    const doc = generateDeckHtml(DECK, { title: 'T' }).replace(
      '</head>',
      `<link rel="stylesheet" href="${href}">\n</head>`
    );
    const parsed = parseDeckHtml(doc, { idGen: seededIdGen() });
    expect(parsed.deck.codeTheme).toBe('github');
    expect(parsed.deck.extraCss).toEqual([{ href }]);
  });
});
