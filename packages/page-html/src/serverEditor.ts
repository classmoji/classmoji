import type { BlockSchema, InlineContentSchema, StyleSchema } from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { createPageSchema } from '@classmoji/page-schema';

/**
 * BlockNote's server editor for the page schema (Node only: pulls in
 * @blocknote/server-util and jsdom), for what needs a DOM: parsing HTML
 * (`htmlToPageBlocks`) and rendering it (`blocksToFullHTML`). Import it
 * through `@classmoji/page-html`. The Y.Doc conversions do not need it:
 * they run on the plain editor in `@classmoji/page-schema/server`.
 */

function buildServerEditor() {
  return ServerBlockNoteEditor.create({ schema: createPageSchema() });
}

export type PageServerEditor = ReturnType<typeof buildServerEditor>;

/** A server editor running any schema (an app's own React specs, say). */
type AnySchemaServerEditor = ServerBlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

/**
 * A new ServerBlockNoteEditor running the page schema, or `schema` when one is
 * given (tests that render an app's schemas the way the server would).
 */
export function createServerEditor(): PageServerEditor;
export function createServerEditor(schema: object): AnySchemaServerEditor;
export function createServerEditor(schema?: object): PageServerEditor | AnySchemaServerEditor {
  return schema === undefined
    ? buildServerEditor()
    : ServerBlockNoteEditor.create({ schema: schema as never });
}

let shared: PageServerEditor | undefined;

/** One lazily created server editor per process (it holds no document). */
export function getServerEditor(): PageServerEditor {
  shared ??= createServerEditor();
  return shared;
}
