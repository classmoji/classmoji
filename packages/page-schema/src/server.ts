import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';

import { normalizeCodeBlockContent } from './codeContent.ts';
import { COVER_IMAGE_KEY, FRAGMENT, META_MAP } from './constants.ts';
import type { PageContent, PageCoverImage } from './content.ts';
import { createPageSchema } from './schema.ts';

/**
 * Server-only helpers (Node): the BlockNote server editor for the page
 * schema, and the Y.Doc <-> page content conversions the collab server and
 * the git worker use. Pulls in @blocknote/server-util (jsdom), so keep it
 * out of browser bundles — the browser entry is `@classmoji/page-schema`.
 */

function buildServerEditor() {
  return ServerBlockNoteEditor.create({ schema: createPageSchema() });
}

export type PageServerEditor = ReturnType<typeof buildServerEditor>;

/** A new ServerBlockNoteEditor running the page schema. */
export function createServerEditor(): PageServerEditor {
  return buildServerEditor();
}

let shared: PageServerEditor | undefined;

/** One lazily created server editor per process (it holds no document). */
export function getServerEditor(): PageServerEditor {
  shared ??= createServerEditor();
  return shared;
}

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
export function blocksToYDoc(
  blocks: unknown[],
  editor: PageServerEditor = getServerEditor()
): Y.Doc {
  return editor.blocksToYDoc(normalizeCodeBlockContent(blocks) as never, FRAGMENT);
}

/**
 * The blocks in `doc`'s FRAGMENT. Converts a CLONE: the conversion deletes
 * any element the schema rejects, and on a live document that deletion would
 * reach every editor.
 */
export function yDocToBlocks(doc: Y.Doc, editor: PageServerEditor = getServerEditor()): unknown[] {
  return editor.yDocToBlocks(cloneDoc(doc), FRAGMENT);
}

/** Page content (`content.json` shape) -> a new Y.Doc: blocks + meta.coverImage. */
export function pageContentToYDoc(
  content: PageContent,
  editor: PageServerEditor = getServerEditor()
): Y.Doc {
  const doc = blocksToYDoc(content.blocks, editor);
  if (content.coverImage != null) {
    doc.getMap(META_MAP).set(COVER_IMAGE_KEY, content.coverImage);
  }
  return doc;
}

/** A Y.Doc -> page content (`content.json` shape), read from a clone. */
export function yDocToPageContent(
  doc: Y.Doc,
  editor: PageServerEditor = getServerEditor()
): PageContent {
  const copy = cloneDoc(doc);
  const blocks: unknown[] = editor.yDocToBlocks(copy, FRAGMENT);
  const cover = copy.getMap(META_MAP).get(COVER_IMAGE_KEY) as PageCoverImage | undefined;
  return cover == null ? { blocks } : { blocks, coverImage: cover };
}
