/**
 * Where the reader island's JS, CSS and chunk preloads are, as the
 * `classmoji:reader-island-assets` Vite plugin (readerIslandAssets.js) reports
 * them: the entry's source path in dev, the hashed build files otherwise.
 *
 * Server only, and read only from a LOADER (which hands it to the document
 * through loader data): the client build runs before the manifest this is
 * built from exists, and a route must not export anything that depends on a
 * `.server.ts` module.
 */
import assets from 'virtual:reader-island-assets';

import type { ReaderIslandAssets } from './ReaderIsland.tsx';

export const readerIslandAssets: ReaderIslandAssets = assets;
