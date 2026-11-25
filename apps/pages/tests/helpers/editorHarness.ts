/**
 * The real page editor in a real browser, for unit specs about its behaviour
 * (focus, menus, toolbars). Bundles `tests/helpers/editor-harness/entry.tsx`
 * (PageEditor, alone, from the same app code the page route renders) with
 * rolldown in production mode, once per worker, and loads it into a Playwright
 * page with the stylesheets the editor ships. `live` binds it to a local Yjs
 * document, as in a classroom with live editing.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { rolldown } from 'rolldown';

const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url));
const ENTRY = fileURLToPath(new URL('./editor-harness/entry.tsx', import.meta.url));
const require = createRequire(import.meta.url);
const ORIGIN = 'http://editor-harness.test';

const STYLESHEETS = [
  require.resolve('@mantine/core/styles.css'),
  require.resolve('@blocknote/core/style.css'),
  require.resolve('@blocknote/mantine/style.css'),
  path.join(APP_DIR, 'styles/blocknote-overrides.css'),
  path.join(APP_DIR, 'styles/page-sections.css'),
];

let bundle: Promise<string> | null = null;

function editorBundle(): Promise<string> {
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
          name: 'editor-harness-assets',
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

/** Mount the editor and wait until it is drawn. */
export async function mountEditor(
  page: Page,
  { live = false }: { live?: boolean } = {}
): Promise<void> {
  const code = await editorBundle();
  const css = STYLESHEETS.map(file => readFileSync(file, 'utf-8')).join('\n');
  await page.route(`${ORIGIN}/**`, route => {
    if (new URL(route.request().url()).pathname === '/editor.js')
      return route.fulfill({ body: code, contentType: 'text/javascript' });
    return route.fulfill({
      contentType: 'text/html',
      body:
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
        `<body><div id="root"></div><script type="module" src="/editor.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/${live ? '?collab=1' : ''}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.locator('.bn-editor[contenteditable="true"]').waitFor();
}
