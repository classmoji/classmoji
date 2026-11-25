import * as Y from 'yjs';
import {
  blocksToYDoc as coreBlocksToYDoc,
  yDocToBlocks as coreYDocToBlocks,
} from '@blocknote/core/yjs';

import { normalizeCodeBlockContent } from './codeContent.ts';
import { COVER_IMAGE_KEY, FRAGMENT, META_MAP } from './constants.ts';
import type { PageContent, PageCoverImage } from './content.ts';
import { getPageEditor, type PageEditor } from './editor.ts';

/**
 * Server-side Y.Doc helpers for the page schema: a plain (unmounted)
 * BlockNote editor and the Y.Doc <-> page content conversions the collab
 * server, the git worker, the MCP and the pages app use. No DOM: nothing here
 * imports jsdom or `@blocknote/server-util`, directly or through another
 * module, so it runs in Node and in workerd alike (a test pins that). HTML
 * parsing and rendering (the legacy `index.html` converter) are in the
 * Node-only `@classmoji/page-html`. Keep it out of browser bundles
 * anyway: the browser entry is `@classmoji/page-schema`.
 */

export {
  createPageEditor,
  getPageEditor,
  pmSchema,
  type PageEditor,
  type PagePmSchema,
} from './editor.ts';
export { validatePageBlocks, type PageContentProblem } from './validateContent.ts';

/** A detached copy of `doc`: read from this, never from a live document. */
export function cloneDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/**
 * Blocks -> a new Y.Doc with the blocks in FRAGMENT. For SEEDING only (a new
 * document); never use it to rewrite a live document. Code blocks are seeded
 * as plain text (`normalizeCodeBlockContent`): BlockNote 0.55 refuses a link
 * inside one.
 */
export function blocksToYDoc(blocks: unknown[], editor: PageEditor = getPageEditor()): Y.Doc {
  return coreBlocksToYDoc(editor, normalizeCodeBlockContent(blocks) as never, FRAGMENT);
}

/**
 * The blocks in `doc`'s FRAGMENT. Converts a CLONE: the conversion deletes
 * any element the schema rejects, and on a live document that deletion would
 * reach every editor.
 */
export function yDocToBlocks(doc: Y.Doc, editor: PageEditor = getPageEditor()): unknown[] {
  return coreYDocToBlocks(editor, cloneDoc(doc), FRAGMENT);
}

/** Page content (`content.json` shape) -> a new Y.Doc: blocks + meta.coverImage. */
export function pageContentToYDoc(
  content: PageContent,
  editor: PageEditor = getPageEditor()
): Y.Doc {
  const doc = blocksToYDoc(content.blocks, editor);
  if (content.coverImage != null) {
    doc.getMap(META_MAP).set(COVER_IMAGE_KEY, content.coverImage);
  }
  return doc;
}

/** A Y.Doc -> page content (`content.json` shape), read from a clone. */
export function yDocToPageContent(doc: Y.Doc, editor: PageEditor = getPageEditor()): PageContent {
  const copy = cloneDoc(doc);
  const blocks: unknown[] = coreYDocToBlocks(editor, copy, FRAGMENT);
  const cover = copy.getMap(META_MAP).get(COVER_IMAGE_KEY) as PageCoverImage | undefined;
  return cover == null ? { blocks } : { blocks, coverImage: cover };
}
