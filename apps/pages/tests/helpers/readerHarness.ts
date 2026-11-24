/**
 * The real reader in a real browser, for unit specs that need its DOM.
 *
 * Bundles the reader island's mount (`app/reader-island/mount.tsx`: PageReader,
 * BlockNoteViewer, the app's blocks) with rolldown, Vite 8's bundler, once per
 * worker, and loads it into a Playwright page with the stylesheets every page
 * surface ships. The island reads its data from the same inline JSON block the
 * class site writes (`serializeIslandData`) and marks the document ready the
 * same way (`data-render-ready`), so a spec sees the DOM a reader sees.
 *
 * Stylesheet imports are stubbed in the bundle and the real files are added to
 * the page instead (Tailwind's entry, which needs its compiler, is left out).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { rolldown } from 'rolldown';

import {
  READER_ISLAND_DATA_ID,
  READER_ISLAND_ROOT_ID,
  serializeIslandData,
  type ReaderIslandData,
} from '~/reader-island/contract.ts';
import { SITE_STYLES } from '~/site/styles.ts';

const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url));
const ENTRY = fileURLToPath(new URL('./reader-harness/entry.ts', import.meta.url));
const require = createRequire(import.meta.url);

let bundle: Promise<string> | null = null;

const HARNESS_ORIGIN = 'http://reader-harness.test';

/** The island mount as one ES module (dynamic imports inlined). */
export function readerBundle(): Promise<string> {
  bundle ??= (async () => {
    const build = await rolldown({
      input: ENTRY,
      platform: 'browser',
      logLevel: 'silent',
      resolve: {
        alias: { '~': APP_DIR },
        conditionNames: ['browser', 'import', 'module', 'default'],
      },
      transform: {
        define: {
          'process.env.NODE_ENV': '"production"',
          'import.meta.env.DEV': 'false',
          'import.meta.env': '{}',
        },
      },
      plugins: [
        {
          name: 'reader-harness-assets',
          load(id) {
            if (/\.(css|svg)(\?.*)?$/.test(id))
              return { code: 'export default ""', moduleType: 'js' };
            return null;
          },
        },
      ],
    });
    try {
      const { output } = await build.generate({ format: 'esm', codeSplitting: false });
      return output[0].code;
    } finally {
      await build.close();
    }
  })();
  return bundle;
}

const STYLESHEETS = [
  require.resolve('@mantine/core/styles.css'),
  require.resolve('@blocknote/core/style.css'),
  require.resolve('@blocknote/mantine/style.css'),
  path.join(APP_DIR, 'styles/blocknote-overrides.css'),
  path.join(APP_DIR, 'styles/page-sections.css'),
  path.join(APP_DIR, 'styles/page-reader.css'),
];

/** A signed-out reader's island data for `blocks` on a class site. */
export function siteIslandData(blocks: unknown[]): ReaderIslandData {
  return {
    surface: 'site',
    page: { id: 'page-1', title: 'Harness', width: 2, is_draft: false },
    payload: {
      content: blocks,
      coverImage: null,
      assets: {},
      srcSets: {},
      mediaDownloads: {},
      readerSections: {
        staff: false,
        signedIn: false,
        member: false,
        showChecks: false,
        showUnlock: false,
        canCheck: false,
        canUnlock: false,
        checked: [],
        unlocked: {},
      },
      signInUrl: '/sign-in',
      links: {},
      scheduleHref: null,
      description: null,
      frameHosts: null,
    },
  };
}

/**
 * Mount `blocks` in the reader, in a class-site article `width` px wide, and
 * wait until the island says it is ready. Fails on the island's error state.
 */
export async function mountReader(
  page: Page,
  blocks: unknown[],
  { width = 700, data = siteIslandData(blocks) }: { width?: number; data?: ReaderIslandData } = {}
): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error?.stack ?? error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const css = STYLESHEETS.map(file => readFileSync(file, 'utf-8')).join('\n');
  // A real origin (BlockNote's toggles read localStorage, which about:blank
  // refuses), served by the page's own router: nothing listens on it.
  const bundleCode = await readerBundle();
  await page.route(`${HARNESS_ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/reader.js')
      return route.fulfill({ body: bundleCode, contentType: 'text/javascript' });
    return route.fulfill({
      contentType: 'text/html',
      body:
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>${SITE_STYLES}</style></head>` +
        `<body><div class="site-article" style="width: ${width}px">` +
        `<div id="${READER_ISLAND_ROOT_ID}"></div></div>` +
        `<script type="application/json" id="${READER_ISLAND_DATA_ID}">${serializeIslandData(data)}</script>` +
        `<script type="module" src="/reader.js"></script>` +
        `</body></html>`,
    });
  });
  await page.goto(`${HARNESS_ORIGIN}/`);
  await page.waitForFunction(
    () =>
      document.documentElement.hasAttribute('data-render-ready') ||
      document.documentElement.hasAttribute('data-render-error'),
    undefined,
    { timeout: 30_000 }
  );
  expect(
    await page.evaluate(() => document.documentElement.getAttribute('data-render-error')),
    `the reader island failed: ${errors.join('\n')}`
  ).toBeNull();
}
