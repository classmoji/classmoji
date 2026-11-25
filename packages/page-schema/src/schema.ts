import {
  BlockNoteSchema,
  addDefaultPropsExternalHTML,
  createBlockSpec,
  createCheckListItemBlockSpec,
  createCodeBlock,
  createExtension,
  createCodeBlockSpec,
  createHeadingBlockSpec,
  createImageBlockSpec,
  createPreCode,
  createStyleSpecFromTipTapMark,
  createToggleFrame,
  defaultBlockSpecs,
  defaultStyleSpecs,
  getBlockInfoFromSelection,
  getNearestBlockPos,
  getBlockInfoFromNode,
  updateBlockTr,
  type BlockNoteEditor,
} from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { ColumnBlock, ColumnListBlock } from '@blocknote/xl-multi-column';
import type { EditorState } from 'prosemirror-state';

import { customBlockConfigs, type CustomBlockType } from './configs.ts';
import {
  codeBlockText,
  createCodeCollapse,
  createCollapseToggle,
  isCollapsible,
  type CodeCollapseNodeView,
} from './codeCollapse.ts';
import { createCopyButton, createCopyToggle, isCopyable } from './copyControl.ts';

/**
 * Default BlockNote blocks the pages app REPLACES with its own spec of the
 * same type: `video` (custom block), `codeBlock` (syntax highlighting),
 * `image` (same config, responsive render).
 */
export const REPLACED_DEFAULT_BLOCKS = ['video', 'codeBlock', 'image'] as const;

/**
 * BlockNote's default styles, except that inline code may sit beside other
 * marks. BlockNote's `code` mark excludes every formatting mark (bold, italic,
 * colours, link), so a stored run that is both code and bold, or code inside a
 * link, was never schema-valid; up to 0.55 BlockNote loaded it anyway. 0.57
 * `check()`s the document built from `initialContent` (and from inserted or
 * replaced blocks), so such a run threw "Invalid collection of marks" and the
 * whole page could not be drawn. Pages hold such runs. With `code` excluding
 * only itself they are valid: they load and draw as they did on 0.55. In the
 * editor, toggling code no longer strips a selection's other marks. Every page
 * schema (editor, in-app viewer, class site, server) uses these, so they stay
 * one schema.
 */
export const pageStyleSpecs = {
  ...defaultStyleSpecs,
  // How BlockNote builds its own `code` style, from its mark (input rule
  // included), with only the exclusion changed.
  code: createStyleSpecFromTipTapMark(
    defaultStyleSpecs.code.implementation.mark.extend({ excludes: 'code' }),
    'boolean'
  ),
};

/**
 * BlockNote's default block specs minus the ones the app replaces, with the
 * heading swapped for the page heading (`checkable` prop) and the check list
 * item for the page check list item (`personal` prop). Every page schema
 * (editor, in-app viewer, class site, server) starts from this, so they all
 * get the same two blocks.
 */
export function pageDefaultBlockSpecs() {
  const {
    video: _video,
    codeBlock: _codeBlock,
    image: _image,
    heading: _heading,
    checkListItem: _checkListItem,
    ...rest
  } = defaultBlockSpecs;
  return {
    ...rest,
    heading: createPageHeadingBlockSpec(),
    checkListItem: createPageCheckListItemBlockSpec(),
  };
}

/** Where a toggle block keeps whether it is open (BlockNote's `createToggleFrame` store). */
export type ToggledState = NonNullable<Parameters<typeof createToggleFrame>[2]>;

export interface PageHeadingOptions {
  /** The store for `editor`'s toggle headings; `undefined` for BlockNote's own. */
  toggledState?: (editor: object) => ToggledState | undefined;
}

/**
 * The heading every page schema uses: BlockNote's, plus a `checkable` prop
 * (a "checkable section": readers tick the heading and its section fades).
 *
 * `checkable` has NO default (`default: undefined`, like BlockNote's own
 * `numberedListItem.start`): a heading that never had it stays without it
 * through every conversion (blocks, ProseMirror, Yjs), so stored documents
 * are not rewritten. A filled default would add `"checkable": false` to every
 * heading on the next save. When set, the block carries
 * `data-checkable="true"` (props that differ from the default become
 * `data-*` attributes).
 *
 * Config, parse rules (incl. toggle headings from `<details>`), meta,
 * `runsBefore`, the input rules and keyboard shortcuts are BlockNote's,
 * unchanged. `render`, `renderFrame` and `toExternalHTML` are rebuilt only
 * because a built spec's are already wrapped in the block structure (see
 * `createPageCodeBlockSpec`) or typed for BlockNote's own props; they are
 * copies of BlockNote 0.57's (`blocks/Heading/block.ts`, toggle headings on).
 *
 * Enter is BlockNote's (the text after the cursor moves to a new paragraph
 * below), except at the very start of a non-empty checkable heading
 * (`checkableHeadingEnter`): the heading keeps its id (readers' ticks are
 * keyed by it) and the blank line above is a heading. BlockNote up to 0.55
 * left the id on an empty copy above and moved the text to a new block;
 * since 0.56 it keeps the id too, with an empty paragraph above.
 *
 * `toggledState` picks, per editor, where a toggle heading keeps whether it
 * is open (BlockNote's `createToggleFrame` store); `undefined` (and the
 * default) is BlockNote's own, the reader's browser.
 */
export function createPageHeadingBlockSpec({ toggledState }: PageHeadingOptions = {}) {
  const base = createHeadingBlockSpec();
  const {
    render: _render,
    renderFrame: _renderFrame,
    toExternalHTML: _toExternalHTML,
    ...implementation
  } = base.implementation;
  const config = {
    ...base.config,
    propSchema: {
      ...base.config.propSchema,
      /** Readers can tick this heading's section (set from the block menu). */
      checkable: { default: undefined, type: 'boolean' as const },
    },
  };
  return createBlockSpec<typeof config.type, typeof config.propSchema, typeof config.content>(
    config,
    {
      ...implementation,
      render: block => {
        const dom = document.createElement(`h${block.props.level}`);
        return { dom, contentDOM: dom };
      },
      // A toggle heading's chevron (and "Add block" while it is open and
      // empty), around its text and children; a plain heading has no frame.
      renderFrame: (block, editor) => {
        if (!block.props.isToggleable) return undefined;
        const frame = createToggleFrame(block, editor, toggledState?.(editor));
        return {
          ...frame,
          // A heading that is no longer toggleable gets no frame.
          update: updated => !!updated.props.isToggleable && frame.update(updated),
        };
      },
      toExternalHTML: block => {
        const dom = document.createElement(`h${block.props.level}`);
        addDefaultPropsExternalHTML(block.props, dom);
        if (block.props.isToggleable) {
          const details = document.createElement('details');
          details.setAttribute('open', '');
          const summary = document.createElement('summary');
          summary.appendChild(dom);
          details.appendChild(summary);
          return { dom: details, contentDOM: dom, childrenDOM: details };
        }
        return { dom, contentDOM: dom };
      },
    },
    [...(base.extensions ?? []), checkableHeadingEnterExtension]
  )();
}

/** The check list item's extension key in BlockNote 0.55 (replaced, never doubled). */
const CHECK_LIST_SHORTCUTS_KEY = 'check-list-item-shortcuts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = BlockNoteEditor<any, any, any>;

/** BlockNote's check list item extension, as its object-form factory hands it out. */
interface CheckListShortcuts {
  key: string;
  keyboardShortcuts?: Record<string, (ctx: { editor: never }) => boolean>;
  inputRules?: ReadonlyArray<unknown>;
}

function baseCheckListShortcuts(
  extensions: ReadonlyArray<unknown> | undefined
): CheckListShortcuts | null {
  for (const factory of extensions ?? []) {
    if (typeof factory !== 'function') continue;
    // Object-form extensions ignore the context they are built with.
    const extension = (factory as (ctx: { editor: unknown }) => CheckListShortcuts)({
      editor: undefined,
    });
    if (extension?.key === CHECK_LIST_SHORTCUTS_KEY) return extension;
  }
  return null;
}

type PMNode = EditorState['doc'];

/**
 * Enter with the cursor at the very start of a non-empty block whose id
 * keys readers' own state (a checkable heading's ticks, a student check list
 * item's): adds `line(content)`, an empty block, above it and leaves the
 * block where it is, so its id stays with its text. The cursor stays at the
 * start of the text, which now sits one line lower: what the user sees is
 * what a split would show. A split (BlockNote's Enter) keeps the id on the
 * empty first half and gives the text a new id.
 *
 * Returns false, changing nothing, unless the selection is empty, at offset
 * 0 of the block's inline content, the block has content, and `line` returns
 * a block for it. One local transaction: one undo step; Yjs sends it as an
 * insertion before the block.
 */
function enterAtStartAddsLineAbove(
  editor: AnyEditor,
  line: (content: PMNode) => { type: string; attrs: Record<string, unknown> } | null
): boolean {
  return editor.transact(tr => {
    const { selection } = tr;
    if (!selection.empty || selection.$from.parentOffset !== 0) return false;
    const info = getBlockInfoFromSelection(tr);
    if (!info.hasContent) return false;
    const { block: bnBlock, content: blockContent } = info;
    if (selection.$from.parent !== blockContent.node || blockContent.node.childCount === 0) {
      return false;
    }
    const wanted = line(blockContent.node);
    if (!wanted) return false;
    const { schema } = tr.doc.type;
    // A container without an id: BlockNote's UniqueID plugin gives it one.
    const container = bnBlock.node.type.create(
      null,
      schema.nodes[wanted.type].create(wanted.attrs)
    );
    // The selection maps past the insertion: it stays at the text's start.
    tr.insert(bnBlock.beforePos, container);
    tr.scrollIntoView();
    return true;
  });
}

/**
 * Enter at the start of a non-empty checkable heading: an empty heading
 * above (`enterAtStartAddsLineAbove`), the heading keeps its id and text.
 * The new line is what BlockNote's split leaves above today, the same type
 * and props (level, toggle, colours, alignment), minus `checkable`: it is a
 * blank line the author is about to write into, and a blank heading with a
 * reader tick box would be a section with nothing to tick.
 */
function checkableHeadingEnter(editor: AnyEditor): boolean {
  return enterAtStartAddsLineAbove(editor, content => {
    if (content.type.name !== 'heading' || content.attrs.checkable !== true) return null;
    const { checkable: _checkable, ...attrs } = content.attrs;
    return { type: 'heading', attrs };
  });
}

const checkableHeadingEnterExtension = createExtension({
  key: 'checkable-heading-enter',
  keyboardShortcuts: {
    Enter: ({ editor }: { editor: AnyEditor }) => checkableHeadingEnter(editor),
  },
});

/**
 * Enter at the start of a non-empty check list item: an empty, unticked item
 * above (`enterAtStartAddsLineAbove`; a student item's is a student item too),
 * the item keeps its id, text and `checked` — as BlockNote 0.56+ does for
 * every other block, so readers' ticks and comments stay with the text.
 */
function checkListItemEnterAtStart(editor: AnyEditor): boolean {
  return enterAtStartAddsLineAbove(editor, content =>
    content.type.name === 'checkListItem'
      ? { type: 'checkListItem', attrs: content.attrs.personal === true ? { personal: true } : {} }
      : null
  );
}

/**
 * Enter in a check list item, as BlockNote 0.55's (`handleEnter`): an empty
 * item becomes a paragraph; otherwise the item is split and the text after
 * the cursor moves to a new item below. Two differences: the new item keeps
 * `personal` (a student check list stays one when the author adds a line),
 * and at the very start of an item the new line goes above instead
 * (`checkListItemEnterAtStart`, so the item keeps its id). Every other prop
 * starts fresh, as in BlockNote (`checked` is not carried).
 */
function checkListItemEnter(editor: AnyEditor): boolean {
  const { blockInfo, selectionEmpty } = editor.transact(tr => ({
    blockInfo: getBlockInfoFromSelection(tr),
    selectionEmpty: tr.selection.anchor === tr.selection.head,
  }));
  if (!blockInfo.hasContent) return false;
  const { block: blockContainer, content: blockContent } = blockInfo;
  if (blockContent.node.type.name !== 'checkListItem' || !selectionEmpty) return false;

  if (blockContent.node.childCount === 0) {
    editor.transact(tr => {
      updateBlockTr(tr, blockContainer.beforePos, { type: 'paragraph', props: {} });
    });
    return true;
  }

  const personal = blockContent.node.attrs.personal === true;
  return editor.transact(tr => {
    tr.deleteSelection();
    tr.scrollIntoView();
    // BlockNote's `splitBlockTr(tr, pos, keepType)`, with `personal` kept.
    const at = tr.selection.from;
    const near = getNearestBlockPos(tr.doc, at);
    const info = getBlockInfoFromNode(near.node, near.posBeforeNode);
    if (!info.hasContent) return false;
    tr.split(at, 2, [
      { type: info.block.node.type, attrs: {} },
      { type: info.content.node.type, attrs: personal ? { personal: true } : {} },
    ]);
    return true;
  });
}

/**
 * The check list item every page schema uses: BlockNote's, plus a `personal`
 * prop (a "student check list": each reader ticks their own copy; the stored
 * `checked` is the author's and is what readers who cannot tick see).
 *
 * `personal` has NO default (`default: undefined`, like the heading's
 * `checkable`): an item that never had it stays without it through every
 * conversion, so stored documents are not rewritten. Turning it off sets it
 * back to `undefined`, never `false`. When set, the block carries
 * `data-personal="true"`.
 *
 * Config (apart from the prop), parse rules, `parseContent`, meta,
 * `runsBefore`, the `[ ]`/`[x]` input rules and Mod-Shift-9 are BlockNote's,
 * unchanged. `render` and `toExternalHTML` are copies of BlockNote 0.57's
 * (`blocks/ListItem/CheckListItem/block.ts`), rebuilt only because a built
 * spec's are already wrapped in the block structure. Enter is BlockNote's,
 * except that the new item keeps `personal` and, at the start of a student
 * item, goes above it (`checkListItemEnter`).
 */
export function createPageCheckListItemBlockSpec() {
  const base = createCheckListItemBlockSpec();
  // BlockNote's check list item has no frame; the type is dropped with it.
  const {
    render: _render,
    renderFrame: _renderFrame,
    toExternalHTML: _toExternalHTML,
    ...implementation
  } = base.implementation;
  const config = {
    ...base.config,
    propSchema: {
      ...base.config.propSchema,
      /** Each reader ticks their own copy (set from the block menu). */
      personal: { default: undefined, type: 'boolean' as const },
    },
  };
  const shortcuts = baseCheckListShortcuts(base.extensions as ReadonlyArray<unknown> | undefined);
  const extension = createExtension({
    key: CHECK_LIST_SHORTCUTS_KEY,
    keyboardShortcuts: {
      ...(shortcuts?.keyboardShortcuts ?? {}),
      Enter: ({ editor }: { editor: AnyEditor }) =>
        checkListItemEnterAtStart(editor) || checkListItemEnter(editor),
    },
    ...(shortcuts?.inputRules ? { inputRules: shortcuts.inputRules as never } : {}),
  });
  return createBlockSpec<typeof config.type, typeof config.propSchema, typeof config.content>(
    config,
    {
      ...implementation,
      render: (block, editor) => {
        const dom = document.createDocumentFragment();
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = block.props.checked;
        if (block.props.checked) checkbox.setAttribute('checked', '');
        checkbox.disabled = !editor.isEditable;
        checkbox.addEventListener('change', () => {
          if (!editor.isEditable) return;
          editor.updateBlock(block, { props: { checked: !block.props.checked } } as never);
        });
        // A <p>, not an <li>: an <li> would need a <ul> the schema cannot have.
        const paragraph = document.createElement('p');
        const div = document.createElement('div');
        div.contentEditable = 'false';
        div.appendChild(checkbox);
        dom.appendChild(div);
        dom.appendChild(paragraph);
        return { dom, contentDOM: paragraph } as never;
      },
      toExternalHTML: block => {
        const dom = document.createElement('li');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = block.props.checked;
        if (block.props.checked) checkbox.setAttribute('checked', '');
        const paragraph = document.createElement('p');
        addDefaultPropsExternalHTML(block.props, dom);
        dom.appendChild(checkbox);
        dom.appendChild(paragraph);
        return { dom, contentDOM: paragraph };
      },
    },
    [extension]
  )();
}

/** The languages the code block's select offers, keyed by canonical id. */
const CODE_LANGUAGES: Record<string, { name: string; aliases?: readonly string[] }> =
  codeBlockOptions.supportedLanguages;

/**
 * The language select's entry for a stored `language`: the id itself when it
 * is one, the id an alias belongs to (`bash` -> `shellscript`, `js` ->
 * `javascript`, case-insensitive, like BlockNote's own alias lookup), and
 * `text` for anything else (unknown names, empty, non-strings).
 *
 * Display only. The stored value is never rewritten from this; the block
 * keeps whatever language it was saved with until a user picks another.
 */
export function codeBlockDisplayLanguage(language: unknown): string {
  if (typeof language !== 'string') return 'text';
  if (Object.hasOwn(CODE_LANGUAGES, language)) return language;
  const wanted = language.trim().toLowerCase();
  if (!wanted) return 'text';
  for (const [id, { aliases }] of Object.entries(CODE_LANGUAGES)) {
    if (id.toLowerCase() === wanted || aliases?.some(a => a.toLowerCase() === wanted)) {
      return id;
    }
  }
  return 'text';
}

/**
 * Where BlockNote 0.55 keeps the Shiki highlighter it loads lazily for code
 * blocks (`lazyShikiPlugin`, not exported by `@blocknote/core`). The pages
 * reader island waits on it before it calls a page drawn; a test here pins it
 * against the installed BlockNote, so an upgrade that moves it fails a test.
 */
export const BLOCKNOTE_SHIKI_HIGHLIGHTER = Symbol.for('blocknote.shikiHighlighterPromise');

/**
 * The language BlockNote's highlighter is asked to paint a stored `language`
 * in: the canonical id (`js` -> `javascript`, `bash` -> `shellscript`), or
 * `text` — which it never sends to Shiki — for `plain`, `''` and any name the
 * bundle does not have. Never the stored value itself: Shiki throws for a
 * language its bundle lacks, inside BlockNote's highlight pass, and the pass
 * stops there, leaving every code block AFTER it in the document unpainted.
 */
export function codeBlockHighlightLanguage(language: unknown): string {
  return codeBlockDisplayLanguage(language);
}

/**
 * The code block every page schema uses: BlockNote's, with the language
 * select tolerant of any stored language, a `copyable` prop and a
 * `collapsible` prop.
 *
 * BlockNote 0.55's render throws `Language <x> is not supported.` when a
 * block's language is not a KEY of `supportedLanguages` — and saved pages hold
 * aliases (`bash`, `js`, `py`, `yml`), names BlockNote never knew, and `''`.
 * 0.46 just left the select blank. This is BlockNote's spec with these changes:
 * the select is told `codeBlockDisplayLanguage(language)` instead of the raw
 * value, and the title bar gets the copy control (copyControl.ts) and, in
 * the editor, the collapse toggle; a collapsible block also gets the bar
 * along its bottom (codeCollapse.ts). Parse,
 * input rule, keyboard shortcuts, the block's `data-language` and
 * `toExternalHTML` are BlockNote's, unchanged (the highlight language is the
 * canonical one, `codeBlockHighlightLanguage`), so
 * documents read and write exactly as before; picking a language in the
 * select writes its canonical id.
 *
 * `collapsible` has NO default (`default: undefined`, like the heading's
 * `checkable`): a code block that never had it stays without it through
 * every conversion, so stored documents are not rewritten, and one without
 * it renders exactly as before. Turning it off sets it back to `undefined`.
 */
export function createPageCodeBlockSpec() {
  const base = createCodeBlockSpec(codeBlockOptions);
  // `render`/`toExternalHTML` on a built spec are already wrapped in the
  // block structure; the rebuilt spec wraps its own, so take only the rest
  // (BlockNote's code block has no `renderFrame`).
  const {
    render: _render,
    renderFrame: _renderFrame,
    toExternalHTML: _toExternalHTML,
    ...implementation
  } = base.implementation;
  const config = {
    ...base.config,
    propSchema: {
      ...base.config.propSchema,
      /** Readers may copy the code (a Copy button; select and copy). */
      copyable: { default: true },
      /** Long code shows its first lines and a bar to open it (codeCollapse.ts). */
      collapsible: { default: undefined, type: 'boolean' as const },
    },
  };
  return createBlockSpec<typeof config.type, typeof config.propSchema, typeof config.content>(
    config,
    {
      ...implementation,
      meta: {
        ...implementation.meta,
        // The canonical language, or plain text for one the bundle lacks
        // (`codeBlockHighlightLanguage`): an unknown language stays plain and
        // the code blocks after it are still highlighted.
        highlight: (block: { props: { language?: unknown } }) =>
          codeBlockHighlightLanguage(block.props.language),
      },
      // A `function`: BlockNote calls it with `this.renderType` (a live node
      // view, or a one-off `blocksToFullHTML` render) and the node view's props.
      render: function (block, editor) {
        const rendered = createCodeBlock(block, editor, {
          selectedLanguage: codeBlockDisplayLanguage(block.props.language),
          supportedLanguages: CODE_LANGUAGES,
        });
        // The select's wrapper is already outside the editable content
        // (contenteditable=false); the controls go in beside it.
        // (No `instanceof HTMLElement`: a server render has a document but
        // not always the DOM globals.)
        const bar = rendered.dom.firstChild as HTMLElement | null;
        if (bar?.nodeName !== 'DIV') return rendered;
        if (editor.isEditable) {
          // Left of the copy toggle. Off is `undefined`, never `false`: a
          // block that never had the prop must not gain one.
          bar.appendChild(
            createCollapseToggle(isCollapsible(block.props), () => {
              // Read the live value, as the copy toggle does.
              const current = editor.getBlock(block.id);
              const collapsible = current ? isCollapsible(current.props) : false;
              editor.updateBlock(block.id, {
                props: { collapsible: collapsible ? undefined : true },
              });
            })
          );
        }
        const control = editor.isEditable
          ? createCopyToggle(isCopyable(block.props), () => {
              // The node view is rebuilt on every prop change, but read the
              // live value anyway: a peer may have flipped it.
              const current = editor.getBlock(block.id);
              const copyable = current ? isCopyable(current.props) : true;
              editor.updateBlock(block.id, { props: { copyable: !copyable } });
            })
          : isCopyable(block.props)
            ? createCopyButton(() => rendered.contentDOM.textContent ?? '')
            : null;
        if (control) bar.appendChild(control);

        const pre = rendered.contentDOM.parentElement;
        if (!isCollapsible(block.props) || !pre) return rendered;
        const view = this as { renderType?: string; props?: CodeCollapseNodeView };
        const collapse = createCodeCollapse({
          editor,
          blockId: block.id,
          chrome: bar,
          pre,
          text: codeBlockText(block.content),
          live: view.renderType === 'nodeView' && view.props ? view.props : null,
        });
        return {
          ...rendered,
          ignoreMutation: collapse.ignoreMutation,
          ...(collapse.update ? { update: collapse.update } : {}),
          destroy: () => {
            collapse.destroy();
            rendered.destroy();
          },
        };
      },
      toExternalHTML: block => createPreCode(block),
    },
    base.extensions
  )();
}

/**
 * A block spec with the shared config and a render that draws nothing.
 *
 * The ProseMirror node (name, content, group, attrs) comes from the config
 * alone, which is all Yjs <-> blocks conversion needs. The render exists
 * only because BlockNote requires one; nothing on the server mounts it.
 */
function serverSpec<T extends CustomBlockType>(type: T) {
  const config = customBlockConfigs[type];
  const inline = config.content === 'inline';
  return createBlockSpec(config, {
    render: () => {
      const dom = globalThis.document?.createElement('div') as HTMLElement;
      return inline ? { dom, contentDOM: dom } : { dom };
    },
  })();
}

/**
 * The page block schema with no React, no DOM and no app aliases: BlockNote's
 * defaults (minus the replaced ones), the code block, the image block,
 * multi-column, and the app's custom blocks built from the shared configs.
 *
 * Block for block, the ProseMirror schema it produces is the pages editor's
 * (pinned by apps/pages/tests/unit/page-schema-parity.spec.ts).
 */
export function createPageSchema() {
  return BlockNoteSchema.create({
    styleSpecs: pageStyleSpecs,
    blockSpecs: {
      ...pageDefaultBlockSpecs(),
      codeBlock: createPageCodeBlockSpec(),
      image: createImageBlockSpec(),
      // The column specs as written, not `multiColumnSchema.blockSpecs`: a
      // built spec has lost its keyboard settings (see apps/pages' blocks).
      column: ColumnBlock,
      columnList: ColumnListBlock,
      callout: serverSpec('callout'),
      terminal: serverSpec('terminal'),
      profile: serverSpec('profile'),
      divider: serverSpec('divider'),
      embed: serverSpec('embed'),
      video: serverSpec('video'),
      pageLink: serverSpec('pageLink'),
      navGrid: serverSpec('navGrid'),
      lockedSection: serverSpec('lockedSection'),
    },
  });
}

export type PageSchema = ReturnType<typeof createPageSchema>;
