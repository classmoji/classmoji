/**
 * The shared reader must not depend on a router: the class site will mount it
 * as a small client island with no React Router at all, and the MCP's page
 * render the same. So nothing in `PageReader`'s module graph — its hooks, the
 * viewer it lazy-loads, the blocks BlockNote renders inside it — may import
 * `react-router` (or `react-router-dom`, `@react-router/*`).
 *
 * Checked with a real bundler (rolldown, Vite 8's), which follows every
 * static and dynamic `import()` the way the island's build will, through the
 * workspace packages and node_modules. Stylesheets and SVGs are stubbed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { rolldown } from 'rolldown';

const APP_DIR = fileURLToPath(new URL('../../app', import.meta.url));
const ROUTER = /^(react-router|react-router-dom|@react-router\/.*)(\/.*)?$/;

/** Every `react-router` import reachable from `entry`, as `specifier <- importer`. */
async function routerImportsFrom(entry: string): Promise<string[]> {
  const found: string[] = [];
  const bundle = await rolldown({
    input: path.join(APP_DIR, entry),
    platform: 'browser',
    logLevel: 'silent',
    resolve: {
      alias: { '~': APP_DIR },
      conditionNames: ['browser', 'import', 'module', 'default'],
    },
    plugins: [
      {
        name: 'router-probe',
        resolveId(source, importer) {
          // Vite / React Router virtual modules (the island's dev preamble).
          if (source.startsWith('virtual:')) return { id: source, external: true };
          if (!ROUTER.test(source)) return null;
          found.push(`${source} <- ${path.relative(APP_DIR, importer ?? '')}`);
          return { id: source, external: true };
        },
        load(id) {
          if (/\.(css|svg)(\?.*)?$/.test(id))
            return { code: 'export default ""', moduleType: 'js' };
          return null;
        },
      },
    ],
  });
  try {
    await bundle.generate({ format: 'esm' });
  } finally {
    await bundle.close();
  }
  return found;
}

test.describe('PageReader is router-free', () => {
  test.setTimeout(120_000);

  test('nothing reachable from PageReader imports react-router', async () => {
    expect(await routerImportsFrom('components/reader/PageReader.tsx')).toEqual([]);
  });

  test('nor anything reachable from the reader island (entry, mount, readiness)', async () => {
    // The island is what mounts the reader with no router at all (the MCP's
    // page render, the class site next); its own modules are held to the same
    // rule. The dev-only HMR preamble import is a virtual module the probe
    // leaves external.
    expect(await routerImportsFrom('reader-island/entry.client.ts')).toEqual([]);
  });

  test('the probe does see a router import (the editor cover still has one)', async () => {
    // A control: if the probe stopped seeing imports, the test above would pass
    // for the wrong reason.
    const found = await routerImportsFrom('components/editor/HeaderImage.tsx');
    expect(found.some(line => line.startsWith('react-router <- '))).toBe(true);
  });
});
