/**
 * One source of truth for every reveal.js / highlight.js URL a deck loads.
 *
 * - The engine versions in revealAssets.ts equal the installed packages
 *   (apps/slides/package.json, the lockfile, node_modules).
 * - No file in the repo writes a reveal/highlight CDN URL at any other
 *   version, or builds one by hand: a new hard-coded URL fails here.
 * - The generated document loads exactly those URLs, every one of them a file
 *   the installed package ships, and the parser reads both generations of
 *   stored documents (5.1.0 paths and 6.x paths).
 */

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateDeckHtml, parseDeckHtml } from '../deckHtml.ts';
import {
  HIGHLIGHT_PACKAGE_VERSION,
  HIGHLIGHT_STYLE_VERSIONS,
  HIGHLIGHT_VERSION,
  REVEAL_THEME_VERSION,
  REVEAL_VERSION,
  highlightStyleCdnjsUrl,
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

const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html?|css|md|mdx|astro|ya?ml|toml|sh|txt)$|Dockerfile/;

/** `[file, text]` for every tracked (or new, not ignored) text file, submodules included. */
async function trackedTextFiles(): Promise<Array<[string, string]>> {
  const git = async (args: string[]) =>
    (
      await promisify(execFile)('git', ['ls-files', '-z', ...args], {
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

/** Every pinned reveal/highlight CDN reference in `text` and the version it must carry. */
function pinnedReferences(text: string): Array<{ url: string; version: string; expected: string }> {
  const out: Array<{ url: string; version: string; expected: string }> = [];
  for (const m of text.matchAll(/reveal\.js@(\d+\.\d+\.\d+)(\/[\w./-]*)?/g)) {
    const path = m[2] ?? '';
    const expected = path.startsWith('/dist/theme/') ? REVEAL_THEME_VERSION : REVEAL_VERSION;
    out.push({ url: m[0], version: m[1], expected });
  }
  const style = (name: string | undefined) =>
    name ? highlightStyleVersion(name) : HIGHLIGHT_VERSION;
  for (const m of text.matchAll(
    /highlight\.js@(\d+\.\d+\.\d+)(?:\/styles\/([\w.-]+?)(?:\.min)?\.css)?/g
  )) {
    out.push({ url: m[0], version: m[1], expected: style(m[2]) });
  }
  // cdnjs styles colour code the installed package highlights (outside decks).
  for (const m of text.matchAll(/ajax\/libs\/highlight\.js\/(\d+\.\d+\.\d+)/g)) {
    out.push({ url: m[0], version: m[1], expected: HIGHLIGHT_PACKAGE_VERSION });
  }
  return out;
}

/** CDN URLs for reveal/highlight that are built by hand or name a loose version. */
function looseReferences(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:(?:reveal|highlight)\.js@(?:\$\{|latest|next|[\^~]|\d+(?:\.\d+)?(?![.\d]))|ajax\/libs\/highlight\.js\/\$\{)/g
    ),
  ].map(m => m[0]);
}

describe('every reveal/highlight CDN URL in the repo', () => {
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

  it('is built through revealAssets.ts, never by hand', () => {
    const handBuilt: Array<{ file: string; url: string }> = [];
    for (const [file, text] of files) {
      if (file === ASSETS_MODULE || OLD_GENERATION_CORPUS.has(file)) continue;
      for (const url of looseReferences(text)) handBuilt.push({ file, url });
    }
    expect(handBuilt).toEqual([]);
  });

  it('the scanner itself flags a stale pin and a hand-built URL', () => {
    const stale = pinnedReferences(
      '<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>' +
        '<link href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">' +
        '<link href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">'
    );
    expect(stale.map(r => r.version === r.expected)).toEqual([false, false, false]);
    const fine = pinnedReferences(
      [revealScriptUrl(), revealThemeUrl('white'), highlightStyleUrl('monokai')].join(' ')
    );
    expect(fine.every(r => r.version === r.expected)).toBe(true);
    expect(
      looseReferences('`https://cdn.jsdelivr.net/npm/reveal.js@${v}/dist/reveal.js`')
    ).toHaveLength(1);
    expect(looseReferences('https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js')).toHaveLength(
      1
    );
    expect(looseReferences('https://cdn.jsdelivr.net/npm/reveal.js@6.0.2/dist/reveal.js')).toEqual(
      []
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

  it('names only files the installed packages ship', async () => {
    const prefix = `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/`;
    for (const url of [
      revealCoreCssUrl(),
      revealScriptUrl(),
      revealHighlightPluginUrl(),
      revealHighlightPluginCssUrl('monokai'),
    ]) {
      expect(url.startsWith(prefix)).toBe(true);
      expect(await exists(`node_modules/reveal.js/${url.slice(prefix.length)}`), url).toBe(true);
    }
    for (const name of ['github', 'github-dark', 'atom-one-dark', 'vs2015']) {
      expect(await exists(`node_modules/highlight.js/styles/${name}.min.css`), name).toBe(true);
      expect(highlightStyleVersion(name)).toBe(HIGHLIGHT_VERSION);
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
    expect(highlightStyleCdnjsUrl('github')).toBe(
      `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HIGHLIGHT_PACKAGE_VERSION}/styles/github.min.css`
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
