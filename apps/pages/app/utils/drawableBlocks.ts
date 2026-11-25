import { cleanPageBlocks, normalizeCodeBlockContent } from '@classmoji/page-schema';

/**
 * Stored blocks as the page schemas can build them, for the reader and the
 * (non-live) editor: code blocks as plain text (`normalizeCodeBlockContent`),
 * then runs no schema knows made to fit (`cleanPageBlocks`: a link stored as
 * a text style becomes a link, unknown styles go). Without it BlockNote
 * throws on the whole document and the page shows nothing.
 *
 * Inline code beside other marks is kept (`keepCodeMarks`): the app schemas
 * (`pageStyleSpecs`) still draw it. Once they take BlockNote's stock styles,
 * this cleans with the stock rules too.
 *
 * Opening a page this way writes nothing: the editor's save baseline is the
 * document it opened with, so the cleaning alone marks nothing unsaved. But
 * once someone edits and saves, the blocks the save carries are the cleaned
 * ones (the editor never held the originals).
 */
export function drawableBlocks<T>(blocks: T): T {
  return cleanPageBlocks(normalizeCodeBlockContent(blocks), { keepCodeMarks: true }).blocks;
}
