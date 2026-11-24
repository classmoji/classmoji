import { BlockNoteEditor } from '@blocknote/core';

import { createPageSchema } from './schema.ts';

/**
 * A plain BlockNote editor for the page schema, never mounted: what the Y.Doc
 * conversions in `@classmoji/page-schema/server` run on. It needs no DOM (no
 * `window`, no `document`), so it also runs in workerd. HTML parsing and
 * rendering need one and live in `@classmoji/page-html`.
 * Import it through `@classmoji/page-schema/server`.
 */

function buildPageEditor() {
  return BlockNoteEditor.create({ schema: createPageSchema() });
}

export type PageEditor = ReturnType<typeof buildPageEditor>;

/** The ProseMirror schema the page schema builds. */
export type PagePmSchema = PageEditor['pmSchema'];

/** A new unmounted BlockNote editor running the page schema. */
export function createPageEditor(): PageEditor {
  return buildPageEditor();
}

let shared: PageEditor | undefined;

/** One lazily created page editor per process (it holds no document). */
export function getPageEditor(): PageEditor {
  shared ??= createPageEditor();
  return shared;
}

/** The page schema's ProseMirror schema (the shared editor's). */
export function pmSchema(): PagePmSchema {
  return getPageEditor().pmSchema;
}
