import type {
  BlockNoteEditorOptions,
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';
import { createPageSchema } from '@classmoji/page-schema';

/**
 * BlockNote's server editor for the page schema (Node only: pulls in
 * @blocknote/server-util and jsdom), for what needs a DOM: parsing HTML
 * (`htmlToPageBlocks`) and rendering it (`blocksToFullHTML`). Import it
 * through `@classmoji/page-html`. The Y.Doc conversions do not need it:
 * they run on the plain editor in `@classmoji/page-schema/server`.
 */

let sharedDocument: Document | undefined;

/** One JSDOM document per process (BlockNote's `getDocument`), for every server editor. */
function serverDocument(): Document {
  sharedDocument ??= getDocument();
  return sharedDocument;
}

/**
 * BlockNote's server editor with the DOM globals set only while one of its
 * calls runs. BlockNote's own (since 0.57) installs `window` and `document`
 * for good on its first call; the Trigger worker that converts pages runs
 * other code too, which keeps seeing a process without a DOM. So each call
 * sets the globals to the editor's document and puts back what was there
 * before, as BlockNote's `_withJSDOM` did up to 0.56.
 */
class ScopedDomServerEditor<
  BSchema extends BlockSchema,
  ISchema extends InlineContentSchema,
  SSchema extends StyleSchema,
> extends ServerBlockNoteEditor<BSchema, ISchema, SSchema> {
  private readonly dom: Document;

  static createScoped<
    BSchema extends BlockSchema,
    ISchema extends InlineContentSchema,
    SSchema extends StyleSchema,
  >(options: Partial<BlockNoteEditorOptions<BSchema, ISchema, SSchema>>, dom: Document) {
    return new ScopedDomServerEditor<BSchema, ISchema, SSchema>(options, dom);
  }

  protected constructor(
    options: Partial<BlockNoteEditorOptions<BSchema, ISchema, SSchema>>,
    dom: Document
  ) {
    super(options, dom);
    this.dom = dom;
  }

  override async _withDOM<T>(fn: (document: Document) => Promise<T>): Promise<T> {
    enterDom(this.dom);
    try {
      return await super._withDOM(fn);
    } finally {
      leaveDom();
    }
  }
}

const DOM_GLOBALS = ['window', 'document'] as const;

/**
 * How many server-editor calls are running, and the globals from before the
 * first. Calls overlap (two conversions awaited together): only the first one
 * in sets the globals and only the last one out puts back what was there, so
 * an overlapping call never restores another's globals or leaves its own.
 * A global that did not exist is deleted again, not left as `undefined`.
 */
let domDepth = 0;
let savedGlobals: Array<{ key: (typeof DOM_GLOBALS)[number]; had: boolean; value: unknown }> = [];

function enterDom(dom: Document) {
  if (domDepth++ > 0) return;
  savedGlobals = DOM_GLOBALS.map(key => ({
    key,
    had: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: Reflect.get(globalThis, key),
  }));
  Object.assign(globalThis, { window: dom.defaultView, document: dom });
}

function leaveDom() {
  if (--domDepth > 0) return;
  for (const { key, had, value } of savedGlobals) {
    if (had) Reflect.set(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  savedGlobals = [];
}

function buildServerEditor() {
  return ScopedDomServerEditor.createScoped({ schema: createPageSchema() }, serverDocument());
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
    : ScopedDomServerEditor.createScoped<BlockSchema, InlineContentSchema, StyleSchema>(
        { schema: schema as never },
        serverDocument()
      );
}

let shared: PageServerEditor | undefined;

/** One lazily created server editor per process (it holds no document). */
export function getServerEditor(): PageServerEditor {
  shared ??= createServerEditor();
  return shared;
}
