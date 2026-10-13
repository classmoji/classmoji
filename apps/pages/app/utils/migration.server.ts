import {
  htmlToPageBlocks,
  type HtmlToPageBlocksOptions,
  type PageBlock,
} from '@classmoji/page-schema/server';

import { withServerBlockNoteLock } from '~/site/render.server.ts';

/**
 * Legacy page HTML (`index.html`) -> BlockNote blocks, for the in-app viewer,
 * the class site and the cover-image write.
 *
 * The conversion itself is `htmlToPageBlocks` in @classmoji/page-schema: the
 * one converter live editing seeds a legacy page with too, so every surface
 * shows the same blocks. Pass the page's `title` so a first `<h1>` that is
 * not the title is kept.
 *
 * It runs BlockNote's server editor, which swaps the process's JSDOM globals
 * just as a render does: it takes the render lock (`withServerBlockNoteLock`)
 * itself, so never call it from inside that lock (the lock is not reentrant).
 * Conversions also queue among themselves inside the converter.
 */
export function migrateHtmlToBlockNote(
  html: string,
  options: HtmlToPageBlocksOptions = {}
): Promise<PageBlock[]> {
  return withServerBlockNoteLock(() => htmlToPageBlocks(html, options));
}
