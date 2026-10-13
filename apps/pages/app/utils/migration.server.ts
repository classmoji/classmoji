import {
  htmlToPageBlocks,
  type HtmlToPageBlocksOptions,
  type PageBlock,
} from '@classmoji/page-schema/server';

/**
 * Legacy page HTML (`index.html`) -> BlockNote blocks, for the in-app viewer,
 * the class site and the cover-image write.
 *
 * The conversion itself is `htmlToPageBlocks` in @classmoji/page-schema: the
 * one converter live editing seeds a legacy page with too, so every surface
 * shows the same blocks. Pass the page's `title` so a first `<h1>` that is
 * not the title is kept.
 *
 * It runs BlockNote's server editor (JSDOM globals): on the class site, call
 * it inside `withServerBlockNoteLock`.
 */
export function migrateHtmlToBlockNote(
  html: string,
  options: HtmlToPageBlocksOptions = {}
): Promise<PageBlock[]> {
  return htmlToPageBlocks(html, options);
}
