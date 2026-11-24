/**
 * The reader island's server half and build glue: the inline data block it
 * writes (escaping), the tags a document gets (dev and build), and where the
 * build finds the island's files (Vite's manifest). The client half (readiness,
 * toggles) is in reader-island-client.spec.ts; the render route that uses all
 * of it in render-page.spec.ts.
 *
 * `ReaderIsland` itself (a .tsx component) cannot be rendered here: the
 * Playwright runner compiles JSX to its own component-testing objects. It is
 * a straight map over `readerIslandTags` plus the data block written with
 * `serializeIslandData`, which is what these tests pin; its rendered markup is
 * checked by the step's end-to-end run against the real render route.
 */
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { test, expect } from '@playwright/test';

import {
  READER_ISLAND_DATA_ID,
  READER_ISLAND_ROOT_ID,
  parseIslandData,
  safeIslandOrigin,
  serializeIslandData,
  type ReaderIslandData,
} from '../../app/reader-island/contract.ts';
import { readerIslandTags } from '../../app/reader-island/ReaderIsland.tsx';
import {
  READER_ISLAND_EAGER_IMPORTS,
  READER_ISLAND_ENTRY,
  devIslandAssets,
  islandAssetsFromManifest,
} from '../../readerIslandAssets.js';

const HOSTILE = 'Ends here: </script><!--<script>window.__pwned = 1</script> and <b>tags</b>';

function islandData(text = HOSTILE): ReaderIslandData {
  return {
    surface: 'render',
    page: { id: 'page-1', title: 'A </script> title', width: 2, is_draft: false },
    payload: {
      content: [
        { id: 'p1', type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }] },
      ],
      coverImage: null,
      assets: {},
      srcSets: {},
      mediaDownloads: {},
      readerSections: {
        staff: true,
        signedIn: false,
        member: false,
        canCheck: false,
        canUnlock: false,
        checked: [],
        unlocked: {},
      },
      signInUrl: null,
      links: {},
      scheduleHref: null,
      description: null,
      frameHosts: null,
    },
  };
}

test.describe('the inline data block', () => {
  test('carries no `<` at all, and parses back to the same data', () => {
    const data = islandData();
    const text = serializeIslandData(data);
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>');
    expect(text).toContain('\\u003c!--\\u003cscript>');
    expect(parseIslandData(text)).toEqual({ ...data, apiBase: '', downloadOrigin: '' });
  });

  test('an HTML parser keeps `</script>` and `<!--<script` in a paragraph inside ONE data element', () => {
    // What `ReaderIsland` writes: the data block (its text exactly
    // `serializeIslandData`), then the entry module.
    const html =
      `<script type="application/json" id="${READER_ISLAND_DATA_ID}">${serializeIslandData(islandData())}</script>` +
      '<script type="module" src="/assets/entry.js"></script>';
    const { document } = new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window;
    const scripts = [...document.querySelectorAll('script')];
    // The data block and the module script: nothing the paragraph opened.
    expect(scripts.map(s => s.getAttribute('type'))).toEqual(['application/json', 'module']);
    const data = parseIslandData(document.getElementById(READER_ISLAND_DATA_ID)?.textContent);
    expect(data?.payload.content).toEqual(islandData().payload.content);
    expect(data?.page.title).toBe('A </script> title');
  });

  test('anything missing or malformed reads as no data', () => {
    expect(parseIslandData(null)).toBeNull();
    expect(parseIslandData('')).toBeNull();
    expect(parseIslandData('{nope')).toBeNull();
    expect(parseIslandData('{"page":{"id":"x"}}')).toBeNull();
    expect(parseIslandData('{"page":{"id":"x"},"payload":{"content":"x"}}')).toBeNull();
  });
});

test.describe('where the reader may send requests (apiBase, downloadOrigin)', () => {
  test('only this host or a bare https origin; anything else reads as this host', () => {
    const accepted = ['', 'https://pages.classmoji.io', 'https://cs52.classmoji.io'];
    for (const value of accepted) expect(safeIslandOrigin(value)).toBe(value);
    const refused = [
      'https://pages.classmoji.io/',
      'https://pages.classmoji.io/api',
      'https://pages.classmoji.io?x=1',
      'https://pages.classmoji.io#x',
      'https://user:pw@pages.classmoji.io',
      'http://pages.classmoji.io',
      'http://localhost:7100',
      'javascript:alert(1)',
      '//evil.example',
      '/api',
      'evil.example',
      42,
      null,
      undefined,
    ];
    for (const value of refused) expect(safeIslandOrigin(value), String(value)).toBe('');
  });

  test('in dev, http on localhost and *.localhost too (never another http host)', () => {
    expect(safeIslandOrigin('http://localhost:7100', { dev: true })).toBe('http://localhost:7100');
    expect(safeIslandOrigin('http://cs52.site.localhost:7431', { dev: true })).toBe(
      'http://cs52.site.localhost:7431'
    );
    expect(safeIslandOrigin('http://evil.example', { dev: true })).toBe('');
    expect(safeIslandOrigin('http://localhost.evil.example', { dev: true })).toBe('');
  });

  test('the parsed data carries only accepted origins', () => {
    const text = serializeIslandData({
      ...islandData('x'),
      apiBase: 'https://evil.example/steal',
      downloadOrigin: 'https://pages.classmoji.io',
    });
    const data = parseIslandData(text, { dev: false });
    expect(data?.apiBase).toBe('');
    expect(data?.downloadOrigin).toBe('https://pages.classmoji.io');
    const local = serializeIslandData({ ...islandData('x'), apiBase: 'http://localhost:7100' });
    expect(parseIslandData(local, { dev: false })?.apiBase).toBe('');
    expect(parseIslandData(local, { dev: true })?.apiBase).toBe('http://localhost:7100');
  });
});

test.describe('the island markup', () => {
  test('a build: its stylesheets, module preloads and the hashed entry as the module script', () => {
    expect(
      readerIslandTags({
        dev: false,
        entry: '/assets/entry.client-abc.js',
        css: ['/assets/reader.css'],
        preloads: ['/assets/mount.js', '/assets/viewer.js'],
      })
    ).toEqual({
      stylesheets: ['/assets/reader.css'],
      modulePreloads: ['/assets/mount.js', '/assets/viewer.js'],
      moduleScript: '/assets/entry.client-abc.js',
    });
    expect(READER_ISLAND_ROOT_ID).toBe('reader-island-root');
  });

  test('dev: the entry source path, no tags of its own (Vite injects the CSS)', () => {
    const assets = devIslandAssets();
    expect(assets).toEqual({
      dev: true,
      entry: '/app/reader-island/entry.client.ts',
      css: [],
      preloads: [],
    });
    expect(readerIslandTags(assets)).toEqual({
      stylesheets: [],
      modulePreloads: [],
      moduleScript: '/app/reader-island/entry.client.ts',
    });
  });

  test('the client-build stub (no entry) is refused rather than rendering a script with no src', () => {
    expect(() => readerIslandTags({ dev: false, entry: '', css: [], preloads: [] })).toThrow(
      /no entry/
    );
  });
});

test.describe('where the build put the island (Vite manifest)', () => {
  // The shape of a real client manifest (`react-router build`, 2026-11-24),
  // trimmed: the entry, its dynamic mount, the reader with its lazy viewer and
  // emoji picker, the viewer's static graph, and the code-block chunk whose
  // dynamic imports are Shiki's grammars.
  const MANIFEST = {
    [READER_ISLAND_ENTRY]: {
      file: 'assets/entry.client-CdH6.js',
      src: READER_ISLAND_ENTRY,
      isEntry: true,
      imports: ['_contract-A.js', '_preload-helper-B.js'],
      dynamicImports: ['app/reader-island/mount.tsx'],
    },
    '_contract-A.js': { file: 'assets/contract-A.js' },
    '_preload-helper-B.js': { file: 'assets/preload-helper-B.js' },
    'app/reader-island/mount.tsx': {
      file: 'assets/mount-2fU.js',
      imports: ['_PageReader-C.js', READER_ISLAND_ENTRY, '_blocknote-code-block-D.js'],
    },
    '_PageReader-C.js': {
      file: 'assets/PageReader-C.js',
      css: ['assets/PageReader-C.css'],
      imports: ['_react-dom-E.js'],
      dynamicImports: [
        'app/components/comments/EmojiMartPicker.tsx',
        'app/components/viewer/BlockNoteViewer.tsx',
      ],
    },
    '_react-dom-E.js': { file: 'assets/react-dom-E.js' },
    'app/components/viewer/BlockNoteViewer.tsx': {
      file: 'assets/BlockNoteViewer-F.js',
      css: ['assets/page-sections-F.css'],
      imports: ['_react-dom-E.js', '_blocknote-code-block-D.js'],
    },
    'app/components/comments/EmojiMartPicker.tsx': {
      file: 'assets/EmojiMartPicker-G.js',
      css: ['assets/emoji-G.css'],
    },
    '_blocknote-code-block-D.js': {
      file: 'assets/blocknote-code-block-D.js',
      dynamicImports: [
        '_python-H.js',
        '../../node_modules/@shikijs/langs-precompiled/dist/css.mjs',
      ],
    },
    '_python-H.js': { file: 'assets/python-H.js' },
    '../../node_modules/@shikijs/langs-precompiled/dist/css.mjs': { file: 'assets/css-I.js' },
  };

  test('the entry, the mount and the viewer with their static graphs; lazy chunks stay lazy', () => {
    expect(READER_ISLAND_EAGER_IMPORTS).toEqual(['app/components/viewer/BlockNoteViewer.tsx']);
    const assets = islandAssetsFromManifest(MANIFEST);
    expect(assets.dev).toBe(false);
    expect(assets.entry).toBe('/assets/entry.client-CdH6.js');
    expect(assets.css).toEqual(['/assets/PageReader-C.css', '/assets/page-sections-F.css']);
    expect(assets.preloads).toEqual([
      '/assets/contract-A.js',
      '/assets/preload-helper-B.js',
      '/assets/mount-2fU.js',
      '/assets/PageReader-C.js',
      '/assets/react-dom-E.js',
      '/assets/BlockNoteViewer-F.js',
      '/assets/blocknote-code-block-D.js',
    ]);
    // Never preloaded: the entry itself (it is the module script), the emoji
    // picker and Shiki's grammars.
    for (const lazy of ['entry.client', 'EmojiMartPicker', 'emoji-G', 'python-H', 'css-I']) {
      expect([...assets.preloads, ...assets.css].join(' ')).not.toContain(lazy);
    }
  });

  test('a non-root base prefixes every URL', () => {
    const assets = islandAssetsFromManifest(MANIFEST, READER_ISLAND_ENTRY, '/pages/');
    expect(assets.entry).toBe('/pages/assets/entry.client-CdH6.js');
    expect(assets.preloads.every(url => url.startsWith('/pages/assets/'))).toBe(true);
  });

  test('a build without the entry fails the server build instead of shipping no reader', () => {
    expect(() => islandAssetsFromManifest({})).toThrow(/not in the client manifest/);
  });
});
