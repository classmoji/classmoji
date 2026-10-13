import { ServerBlockNoteEditor } from '@blocknote/server-util';

import { createPageSchema } from './schema.ts';

/**
 * The BlockNote server editor for the page schema (Node only: pulls in
 * @blocknote/server-util and jsdom). Its own module so `server.ts` and
 * `html.ts` can both use it without importing each other. Import it through
 * `@classmoji/page-schema/server`.
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
