/**
 * The reader island's client entry: a module script in a server-routed,
 * non-hydrated document (`ReaderIsland.tsx` writes the tags). It loads the
 * mount module — the shared reader and BlockNote — and mounts it.
 *
 * A `.ts` file (no JSX) on purpose: React Router's refresh transform wraps
 * every JSX module with a check that throws unless its preamble ran, and these
 * documents' CSP refuses the inline preamble the App document uses. So in dev
 * this entry loads the preamble as a MODULE first, then the reader. In a build
 * the `import.meta.env.DEV` branch is dead code and the refresh runtime is not
 * shipped. No top-level await: the build target includes Safari 14.
 *
 * Anything that fails before the reader is on screen (the chunk does not
 * load, the data is missing, the reader throws) ends in the island's failure
 * state (`showIslandError`), never a page left on its loading line.
 */
import { showIslandError } from './islandDom.ts';

const preamble: Promise<unknown> = import.meta.env.DEV
  ? import('virtual:react-router/inject-hmr-runtime' as string)
  : Promise.resolve();

preamble
  .then(() => import('./mount.tsx'))
  .then(({ mountReaderIsland }) => mountReaderIsland())
  .catch(error => showIslandError(error));
