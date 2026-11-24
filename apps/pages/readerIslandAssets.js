/**
 * The reader island's build glue (vite.config.js).
 *
 * The island (`app/reader-island/`) is a small client entry that mounts the
 * shared page reader into a server-routed, NON-hydrated document (the MCP's
 * page render and the class site). It is built by the SAME client
 * build as React Router's own entries: `READER_ISLAND_ENTRY` is added to the
 * client environment's rollup inputs (array form, which Vite's config merge
 * concatenates with React Router's).
 *
 * A route's loader learns where the hashed files landed from
 * `virtual:reader-island-assets`, served by `readerIslandAssetsPlugin`:
 *   - dev: the entry's source path; Vite serves it and its CSS arrives as
 *     JS-injected <style> tags from the module graph;
 *   - client build: a stub (the client graph never reads it — only a loader
 *     does, through `app/reader-island/assets.server.ts` — and the client
 *     manifest does not exist yet);
 *   - SSR build: read from `build/client/.vite/manifest.json`. React Router
 *     builds the client environment first and forces `build.manifest: true`
 *     on it, deleting the file only after both builds, so it is on disk while
 *     the SSR build loads this module.
 *
 * Plain JavaScript (no TypeScript) so the Vite config loads it without a
 * transform, and the unit suite can import `islandAssetsFromManifest`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The island's client entry, relative to the app root (also its manifest key). */
export const READER_ISLAND_ENTRY = 'app/reader-island/entry.client.ts';

/**
 * Modules the reader loads with a dynamic `import()` that the island needs at
 * once anyway, so they are preloaded with the rest instead of fetched only
 * when the reader asks: the viewer itself (`PageReader` lazy-loads it, so the
 * pages app's server render never touches BlockNote).
 */
export const READER_ISLAND_EAGER_IMPORTS = ['app/components/viewer/BlockNoteViewer.tsx'];

const VIRTUAL_ID = 'virtual:reader-island-assets';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * @typedef {object} ReaderIslandAssets
 * @property {boolean} dev
 * @property {string} entry The entry module's URL (the source path in dev).
 * @property {string[]} css Stylesheets of the entry and the reader chunk's static graph.
 * @property {string[]} preloads `modulepreload` URLs: the reader chunk and its static imports.
 */

/**
 * @typedef {object} ManifestChunk
 * @property {string} file
 * @property {string[]} [css]
 * @property {string[]} [imports]
 * @property {string[]} [dynamicImports]
 */

/** @returns {ReaderIslandAssets} */
export function devIslandAssets(entry = READER_ISLAND_ENTRY) {
  return { dev: true, entry: `/${entry}`, css: [], preloads: [] };
}

/**
 * Where the island's files are in a client build, from Vite's manifest: the
 * entry; the CSS and preloads of its static graph; its dynamic imports (the
 * mount module) with THEIR static graphs; and, anywhere in that, a dynamic
 * import named in `eager` (the viewer) with its static graph. No other
 * dynamic edge: chunks the reader loads lazily (Shiki and its grammars, the
 * emoji picker) stay lazy.
 *
 * @param {Record<string, ManifestChunk>} manifest
 * @param {string} [entryKey]
 * @param {string} [base] Public base path ('/' for this app).
 * @param {readonly string[]} [eager]
 * @returns {ReaderIslandAssets}
 */
export function islandAssetsFromManifest(
  manifest,
  entryKey = READER_ISLAND_ENTRY,
  base = '/',
  eager = READER_ISLAND_EAGER_IMPORTS
) {
  const entry = manifest[entryKey];
  if (!entry) throw new Error(`[reader-island] ${entryKey} is not in the client manifest`);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const css = new Set();
  const preloads = new Set();
  const seen = new Set();
  const eagerKeys = new Set(eager);
  /** @param {string} key */
  const walk = key => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) return;
    preloads.add(`${prefix}${chunk.file}`);
    for (const file of chunk.css ?? []) css.add(`${prefix}${file}`);
    for (const imported of chunk.imports ?? []) walk(imported);
    for (const dynamic of chunk.dynamicImports ?? []) if (eagerKeys.has(dynamic)) walk(dynamic);
  };
  walk(entryKey);
  for (const dynamic of entry.dynamicImports ?? []) walk(dynamic);
  const entryUrl = `${prefix}${entry.file}`;
  preloads.delete(entryUrl);
  return { dev: false, entry: entryUrl, css: [...css], preloads: [...preloads] };
}

/** The Vite plugin serving `virtual:reader-island-assets`. */
export function readerIslandAssetsPlugin() {
  let root = process.cwd();
  let base = '/';
  let clientOutDir = 'build/client';
  return {
    name: 'classmoji:reader-island-assets',
    /** @param {any} config */
    configResolved(config) {
      root = config.root;
      base = config.base ?? '/';
      clientOutDir = config.environments?.client?.build?.outDir ?? clientOutDir;
    },
    /** @param {string} id */
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    /**
     * @this {any}
     * @param {string} id
     */
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const environment = this.environment;
      if (environment?.config?.command === 'serve') {
        return `export default ${JSON.stringify(devIslandAssets())};`;
      }
      if (environment?.name === 'client') {
        return `export default ${JSON.stringify({ dev: false, entry: '', css: [], preloads: [] })};`;
      }
      const manifestPath = path.resolve(root, clientOutDir, '.vite/manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return `export default ${JSON.stringify(islandAssetsFromManifest(manifest, READER_ISLAND_ENTRY, base))};`;
    },
  };
}
