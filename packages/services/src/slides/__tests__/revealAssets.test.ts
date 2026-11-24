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
 *   parser reads every generation of stored documents (5.1.0 paths, 6.x
 *   engine with 5.1.0 themes and 11.9.0 monokai/felipec, all 6.x) and both
 *   Dracula stylesheet paths.
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
  HIGHLIGHT_VERSION,
  REVEAL_VERSION,
  SOURCE_SANS_PRO_VERSION,
  highlightStyleCdnjsUrl,
  highlightStyleName,
  highlightStyleUrl,
  isThemeFontStylesheet,
  revealCoreCssUrl,
  revealHighlightPluginCssUrl,
  revealHighlightPluginUrl,
  revealScriptUrl,
  revealThemeExtraStylesheets,
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

/**
 * Every versioned reveal/highlight CDN reference in `text` and the version it
 * must carry: every reveal.js file (themes included) at the installed reveal,
 * every highlight.js file in decks at the version reveal's plugin bundles, and
 * cdnjs styles (code outside decks) at the installed highlight.js package.
 */
function pinnedReferences(text: string): Array<{ url: string; version: string; expected: string }> {
  const rules: Array<[RegExp, string]> = [
    // jsDelivr / unpkg / esm.sh / any npm CDN
    [new RegExp(`reveal\\.js${AT}${SEMVER}(\\/[\\w./-]*)?`, 'g'), REVEAL_VERSION],
    [new RegExp(`ajax\\/libs\\/reveal\\.js\\/${SEMVER}(\\/[\\w./-]*)?`, 'g'), REVEAL_VERSION],
    [new RegExp(`highlight\\.js${AT}${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'), HIGHLIGHT_VERSION],
    [
      new RegExp(`@highlightjs\\/cdn-assets${AT}${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'),
      HIGHLIGHT_VERSION,
    ],
    [
      new RegExp(`highlightjs\\/cdn-release${AT}${SEMVER}(?:\\/build\\/styles\\/${STYLE})?`, 'g'),
      HIGHLIGHT_VERSION,
    ],
    [
      new RegExp(`ajax\\/libs\\/highlight\\.js\\/${SEMVER}(?:\\/styles\\/${STYLE})?`, 'g'),
      HIGHLIGHT_PACKAGE_VERSION,
    ],
    // The Source Sans Pro faces beige needs (revealThemeExtraStylesheets).
    [
      new RegExp(`@fontsource\\/source-sans-pro${AT}${SEMVER}(\\/[\\w./-]*)?`, 'g'),
      SOURCE_SANS_PRO_VERSION,
    ],
  ];
  const out: Array<{ url: string; version: string; expected: string }> = [];
  for (const [re, expected] of rules) {
    for (const m of text.matchAll(re)) out.push({ url: m[0], version: m[1], expected });
  }
  return out;
}

/** A version the scan cannot pin: a template, a quote (concatenation), a range or tag, or major/minor only. */
const LOOSE_VERSION = `(?:\\$\\{|['"\`]|latest|next|[\\^~]|\\d+(?:\\.\\d+)?(?![.\\d]))`;
const PACKAGE =
  '(?:reveal\\.js|highlight\\.js|@highlightjs\\/cdn-assets|@fontsource\\/source-sans-pro)';

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
      'a theme at the 5.1.0 look',
      'https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css',
    ],
    [
      'monokai at the 11.9.0 look',
      'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/monokai.min.css',
    ],
    [
      'felipec at the 11.9.0 look',
      'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/felipec.min.css',
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
      'monokai on cdnjs at the 11.9.0 look',
      'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/monokai.min.css',
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
    [
      'a theme font at another version',
      'https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@5.2.5/400.css',
    ],
    [
      'an unversioned theme font',
      'https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro/400.css',
    ],
    ['a floating theme font', 'https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@5/400.css'],
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
    ['monokai', highlightStyleUrl('monokai')],
    ['felipec', highlightStyleUrl('felipec')],
    ['Dracula', highlightStyleUrl('dracula')],
    ['a cdnjs style', highlightStyleCdnjsUrl('github')],
    ['monokai on cdnjs', highlightStyleCdnjsUrl('monokai')],
    [
      'a URL written by hand at the right version',
      'https://cdn.jsdelivr.net/npm/reveal.js@6.0.2/dist/reveal.js',
    ],
    [
      'a theme written by hand at the right version',
      'https://cdn.jsdelivr.net/npm/reveal.js@6.0.2/dist/theme/white.css',
    ],
    [
      'monokai written by hand at the right version',
      'https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/monokai.min.css',
    ],
    [
      'cdn-assets at the right version',
      `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HIGHLIGHT_VERSION}/styles/github.min.css`,
    ],
    ['an npm module specifier', "import 'reveal.js/dist/reveal.css';"],
    ['a node_modules path', 'node_modules/highlight.js/styles/github.min.css'],
    ...revealThemeExtraStylesheets('beige').map((url): [string, string] => [
      `beige's font stylesheet ${url.slice(url.lastIndexOf('/') + 1)}`,
      url,
    ]),
    [
      'a theme font written by hand at the right version',
      `https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@${SOURCE_SANS_PRO_VERSION}/600.css`,
    ],
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

  it('carries the installed version (themes and every code style included)', () => {
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
  it('loads the engine, core css, theme and highlight plugin at the installed version', () => {
    const html = generateDeckHtml(DECK, { title: 'T' });
    expect(documentUrls(html)).toEqual([
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.css`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/theme/white.css`,
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/github.min.css`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/reveal.js`,
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/plugin/highlight.js`,
    ]);
  });

  it('loads monokai, felipec and both themes at the installed versions, light/dark pairs included', () => {
    const html = generateDeckHtml(
      {
        ...DECK,
        theme: 'night',
        themeDark: 'black',
        codeTheme: 'monokai',
        codeThemeDark: 'felipec',
      },
      { title: 'T' }
    );
    const urls = documentUrls(html);
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/monokai.min.css`
    );
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/highlight.js@${HIGHLIGHT_VERSION}/styles/felipec.min.css`
    );
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/theme/night.css`
    );
    expect(urls).toContain(
      `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist/theme/black.css`
    );
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

  it('names a stylesheet that exists for every builtin theme the editor offers', async () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThan(0);
    for (const theme of BUILTIN_THEMES) {
      const url = revealThemeUrl(theme);
      expect(url).toContain(`/reveal.js@${REVEAL_VERSION}/`);
      expect(await exists(installedPath(url)), url).toBe(true);
    }
  });

  it('names a stylesheet that exists for every code theme the editor offers', async () => {
    expect(CODE_THEMES.length).toBeGreaterThan(0);
    for (const { value } of CODE_THEMES) {
      const url = highlightStyleUrl(value);
      expect(url).toContain(`/highlight.js@${HIGHLIGHT_VERSION}/`);
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

  it('cdnjs styles (code outside decks) follow the installed package', () => {
    for (const name of ['github', 'monokai', 'felipec']) {
      expect(highlightStyleCdnjsUrl(name)).toBe(
        `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HIGHLIGHT_PACKAGE_VERSION}/styles/${name}.min.css`
      );
    }
  });
});

describe("beige's Source Sans Pro", () => {
  const BEIGE: DeckJson = { ...DECK, theme: 'beige' };
  const FONT_URLS = revealThemeExtraStylesheets('beige');
  const fontLinks = (html: string) =>
    [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"([^>]*)>/g)]
      .filter(m => isThemeFontStylesheet(m[1]))
      .map(m => m[1] + m[2]);

  it('beige, and only beige, needs font stylesheets: 400 and 600, upright and italic', () => {
    expect(FONT_URLS).toEqual(
      ['400', '400-italic', '600', '600-italic'].map(
        face =>
          `https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@${SOURCE_SANS_PRO_VERSION}/${face}.css`
      )
    );
    for (const theme of BUILTIN_THEMES) {
      if (theme !== 'beige') expect(revealThemeExtraStylesheets(theme), theme).toEqual([]);
    }
    for (const other of ['shared:x', 'custom:x.css', 'nope']) {
      expect(revealThemeExtraStylesheets(other)).toEqual([]);
    }
  });

  it('a beige document loads them right after the theme, once, without media', () => {
    const html = generateDeckHtml(BEIGE, { title: 'T' });
    expect(fontLinks(html)).toEqual(FONT_URLS);
    const urls = documentUrls(html);
    expect(urls.indexOf(FONT_URLS[0])).toBe(urls.indexOf(revealThemeUrl('beige')) + 1);
    for (const deck of [
      { ...BEIGE, themeDark: 'black' },
      { ...DECK, theme: 'white', themeDark: 'beige' },
      { ...BEIGE, themeDark: 'beige' },
    ]) {
      expect(fontLinks(generateDeckHtml(deck, { title: 'T' })), JSON.stringify(deck)).toEqual(
        FONT_URLS
      );
    }
  });

  it('no other theme gets them', () => {
    for (const theme of BUILTIN_THEMES) {
      if (theme === 'beige') continue;
      const html = generateDeckHtml({ ...DECK, theme, themeDark: 'black' }, { title: 'T' });
      expect(fontLinks(html), theme).toEqual([]);
      expect(html).not.toContain('@fontsource');
    }
  });

  it('a stored beige document reads back as the same deck: the font links are part of the theme', () => {
    for (const deck of [BEIGE, { ...DECK, theme: 'white', themeDark: 'beige' }]) {
      const html = generateDeckHtml(deck, { title: 'T' });
      for (const doc of [html, html.replace(/ data-theme="[^"]*"/, '')]) {
        const parsed = parseDeckHtml(doc, { idGen: seededIdGen() });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.deck.extraCss).toBeUndefined();
        expect(generateDeckHtml(parsed.deck, { title: 'T' })).toBe(html);
      }
    }
  });

  it('an old beige document without them parses the same, and regenerates with them', () => {
    const current = generateDeckHtml(BEIGE, { title: 'T' });
    const old = current
      .split('\n')
      .filter(line => !line.includes('@fontsource'))
      .join('\n');
    expect(fontLinks(old)).toEqual([]);
    const fromOld = parseDeckHtml(old, { idGen: seededIdGen() });
    const fromCurrent = parseDeckHtml(current, { idGen: seededIdGen() });
    expect(fromOld.warnings).toEqual([]);
    expect(fromOld.deck).toEqual(fromCurrent.deck);
    expect(generateDeckHtml(fromOld.deck, { title: 'T' })).toBe(current);
  });

  it('a font link stored at another version is still the theme’s, and regenerates pinned', () => {
    const current = generateDeckHtml(BEIGE, { title: 'T' });
    const stored = current.replaceAll(
      `source-sans-pro@${SOURCE_SANS_PRO_VERSION}/`,
      'source-sans-pro@5.2.5/'
    );
    expect(stored).toContain('source-sans-pro@5.2.5/');
    const parsed = parseDeckHtml(stored, { idGen: seededIdGen() });
    expect(parsed.deck.extraCss).toBeUndefined();
    expect(generateDeckHtml(parsed.deck, { title: 'T' })).toBe(current);
  });

  it('on a deck whose theme needs no fonts, the same link is the author’s and stays extra css', () => {
    const href = FONT_URLS[0];
    const doc = generateDeckHtml(DECK, { title: 'T' }).replace(
      '</head>',
      `<link rel="stylesheet" href="${href}">\n</head>`
    );
    const parsed = parseDeckHtml(doc, { idGen: seededIdGen() });
    expect(parsed.deck.extraCss).toEqual([{ href }]);
  });

  it('on a beige deck, an author’s own Source Sans Pro link stays extra css', () => {
    const v = SOURCE_SANS_PRO_VERSION;
    const own = [
      { href: `https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@${v}/700.css` },
      { href: `https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@${v}/index.css` },
      { href: `https://example.com/npm/@fontsource/source-sans-pro@${v}/400.css` },
      {
        href: `https://cdn.jsdelivr.net/npm/@fontsource/source-sans-pro@${v}/400.css`,
        media: 'print',
      },
    ];
    const links = own
      .map(c => `<link rel="stylesheet" href="${c.href}"${c.media ? ` media="${c.media}"` : ''}>`)
      .join('\n');
    const doc = generateDeckHtml(BEIGE, { title: 'T' }).replace('</head>', `${links}\n</head>`);
    const parsed = parseDeckHtml(doc, { idGen: seededIdGen() });
    expect(parsed.deck.extraCss).toEqual(own);
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

  it('a regenerated document differs from its old-generation self only in the asset lines', () => {
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
      // core css
      '<link rel="stylesheet" href="…">',
      // theme light/dark/fallback
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: light)">',
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: dark)">',
      '<link rel="stylesheet" href="…" media="not all and (prefers-color-scheme)">',
      // code style light/dark/fallback
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: light)">',
      '<link rel="stylesheet" href="…" media="(prefers-color-scheme: dark)">',
      '<link rel="stylesheet" href="…" media="not all and (prefers-color-scheme)">',
      // engine and highlight plugin
      '<script src="…"></script>',
      '<script src="…"></script>',
    ]);
  });

  /**
   * What the generator wrote while themes were held at reveal.js 5.1.0 and
   * monokai/felipec at highlight.js 11.9.0 (a 6.x engine around them): today's
   * document with those links put back.
   */
  function heldLookDocument(deck: DeckJson): string {
    // (No beige font links then either.)
    let html = generateDeckHtml(deck, { title: 'T' })
      .split('\n')
      .filter(line => !line.includes('@fontsource/'))
      .join('\n');
    for (const name of BUILTIN_THEMES) {
      html = html.replaceAll(
        revealThemeUrl(name),
        `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${name}.css`
      );
    }
    for (const name of ['monokai', 'felipec']) {
      html = html.replaceAll(
        highlightStyleUrl(name),
        `https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${name}.min.css`
      );
    }
    return html;
  }

  /** The document with its `data-theme` / `data-code-theme` removed, so only the links name them. */
  const linksOnly = (doc: string) =>
    doc.replace(/ data-theme="[^"]*"/, '').replace(/ data-code-theme="[^"]*"/, '');

  const HELD_LOOK_DECKS: DeckJson[] = [
    { ...DECK, theme: 'night', codeTheme: 'monokai' },
    { ...DECK, theme: 'beige', codeTheme: 'felipec' },
    {
      ...DECK,
      theme: 'simple',
      themeDark: 'dracula',
      codeTheme: 'felipec',
      codeThemeDark: 'monokai',
    },
    { ...DECK, theme: 'serif', themeDark: 'black', codeTheme: 'github', codeThemeDark: 'monokai' },
  ];

  it('a 5.1.0-theme / 11.9.0-monokai/felipec document reads back as the same deck', () => {
    for (const deck of HELD_LOOK_DECKS) {
      const stored = heldLookDocument(deck);
      expect(stored).toContain('reveal.js@5.1.0/dist/theme/');
      expect(stored).toMatch(/highlight\.js@11\.9\.0\/styles\/(?:monokai|felipec)\.min\.css/);
      for (const html of [stored, linksOnly(stored)]) {
        const parsed = parseDeckHtml(html, { idGen: seededIdGen() });
        expect(parsed.warnings).toEqual([]);
        expect(parsed.deck.extraCss).toBeUndefined();
        expect(parsed.deck.theme).toBe(deck.theme);
        expect(parsed.deck.themeDark).toBe(deck.themeDark);
        expect(parsed.deck.codeTheme).toBe(deck.codeTheme);
        expect(parsed.deck.codeThemeDark).toBe(deck.codeThemeDark);
        expect(parsed.deck).toEqual(
          parseDeckHtml(generateDeckHtml(deck, { title: 'T' }), { idGen: seededIdGen() }).deck
        );
      }
    }
  });

  it('regenerating such a document loads the installed theme and code style', () => {
    for (const deck of HELD_LOOK_DECKS) {
      const parsed = parseDeckHtml(heldLookDocument(deck), { idGen: seededIdGen() });
      const regenerated = generateDeckHtml(parsed.deck, { title: 'T' });
      expect(regenerated).toBe(generateDeckHtml(deck, { title: 'T' }));
      expect(regenerated).not.toContain('reveal.js@5.1.0');
      expect(regenerated).not.toContain('highlight.js@11.9.0');
    }
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
