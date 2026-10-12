/**
 * @vitest-environment jsdom
 *
 * The page check list item: BlockNote's, plus `personal` (no default), through
 * every conversion the server does, and through Enter in a real editor (a new
 * line of a student check list stays personal).
 */
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createCheckListItemBlockSpec,
  defaultBlockSpecs,
} from '@blocknote/core';
import { TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { serializePageContent } from '../content.ts';
import { createPageCheckListItemBlockSpec, createPageSchema } from '../schema.ts';
import { getServerEditor, pageContentToYDoc, yDocToPageContent } from '../server.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
type AnyBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: Array<{ text?: string }>;
  children: AnyBlock[];
};

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const item = (id: string, value: string, props: Record<string, unknown> = {}) => ({
  id,
  type: 'checkListItem',
  props: { checked: false, ...props },
  content: value ? text(value) : [],
  children: [],
});

function yjsTrip(blocks: unknown[]) {
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(pageContentToYDoc({ blocks })));
  return yDocToPageContent(loaded).blocks as AnyBlock[];
}

describe('checkListItem.personal', () => {
  it('is BlockNote’s check list item config plus a boolean with no default, after `checked`', () => {
    const schema = createPageSchema();
    const spec = (schema.blockSchema as unknown as Record<string, { propSchema: object }>)
      .checkListItem;
    const base = createCheckListItemBlockSpec().config.propSchema;
    expect(spec.propSchema).toEqual({
      ...base,
      personal: { default: undefined, type: 'boolean' },
    });
    // Props serialize in schema order: `personal` after `checked`.
    expect(Object.keys(spec.propSchema).slice(-2)).toEqual(['checked', 'personal']);
  });

  it('true and false survive the Yjs round trip; absent stays absent', () => {
    const [on, off, absent] = yjsTrip([
      item('on', 'a', { personal: true }),
      item('off', 'b', { personal: false }),
      item('absent', 'c'),
    ]);
    expect(on.props.personal).toBe(true);
    expect(off.props.personal).toBe(false);
    expect('personal' in absent.props).toBe(false);
    expect(serializePageContent({ blocks: [absent] })).not.toContain('personal');
  });

  it('keeps `checked` (the author’s) next to `personal`', () => {
    const [on] = yjsTrip([item('on', 'a', { personal: true, checked: true })]);
    expect(on.props).toMatchObject({ checked: true, personal: true });
  });

  it('renders data-personal only when set, and BlockNote’s markup otherwise', async () => {
    const page = getServerEditor();
    const html = await page.blocksToFullHTML([
      item('a', 'A', { personal: true }),
      item('b', 'B', { checked: true }),
    ] as never);
    expect(html.match(/data-personal="true"/g)).toHaveLength(1);
    expect(html).not.toContain('data-personal="false"');

    // A document without the prop renders exactly as BlockNote's own block.
    const plain = BlockNoteEditor.create({
      schema: BlockNoteSchema.create({ blockSpecs: defaultBlockSpecs }),
    });
    const doc = [item('b', 'B', { checked: true }), item('c', 'C')];
    expect(await page.blocksToFullHTML(doc as never)).toBe(plain.blocksToFullHTML(doc as never));
    expect(await page.blocksToHTMLLossy(doc as never)).toBe(plain.blocksToHTMLLossy(doc as never));
    plain._tiptapEditor.destroy();
  });

  it('keeps BlockNote’s shortcuts: one extension, its input rules and Mod-Shift-9', () => {
    type Ext = { key: string; keyboardShortcuts?: Record<string, unknown>; inputRules?: unknown[] };
    const build = (spec: { extensions?: unknown[] }) =>
      (spec.extensions ?? []).map(factory =>
        (factory as (ctx: { editor: unknown }) => Ext)({ editor: undefined })
      );
    const [ours, ...more] = build(createPageCheckListItemBlockSpec() as never);
    const [theirs] = build(createCheckListItemBlockSpec() as never);
    expect(more).toHaveLength(0);
    expect(ours.key).toBe(theirs.key);
    expect(Object.keys(ours.keyboardShortcuts ?? {}).sort()).toEqual(
      Object.keys(theirs.keyboardShortcuts ?? {}).sort()
    );
    expect(ours.keyboardShortcuts?.['Mod-Shift-9']).toBe(theirs.keyboardShortcuts?.['Mod-Shift-9']);
    expect(ours.inputRules).toBe(theirs.inputRules);
    expect(ours.keyboardShortcuts?.Enter).not.toBe(theirs.keyboardShortcuts?.Enter);
  });
});

describe('Enter in a check list item', () => {
  let editors: Editor[] = [];
  afterEach(() => {
    for (const editor of editors) editor._tiptapEditor.destroy();
    editors = [];
    document.body.innerHTML = '';
  });

  function mount(initialContent: unknown[]): Editor {
    const editor = BlockNoteEditor.create({
      schema: createPageSchema(),
      initialContent: initialContent as never,
    }) as Editor;
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    editors.push(editor);
    return editor;
  }

  /** Put the cursor `offset` characters into block `id`'s text. */
  function cursorIn(editor: Editor, id: string, offset: number) {
    let pos = -1;
    editor._tiptapEditor.state.doc.descendants((node, at) => {
      if (pos >= 0) return false;
      if (node.attrs.id === id) {
        pos = at + 2; // blockContainer → blockContent → text
        return false;
      }
      return true;
    });
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + offset)));
  }

  function pressEnter(editor: Editor) {
    editor.prosemirrorView!.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  }

  const blocks = (editor: Editor) => editor.document as unknown as AnyBlock[];
  const textOf = (block: AnyBlock) => (block.content ?? []).map(run => run.text ?? '').join('');

  it('at the end of a personal item: the new item is personal and not checked', () => {
    const editor = mount([item('a', 'first', { personal: true, checked: true })]);
    cursorIn(editor, 'a', 5);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect(first.props).toMatchObject({ personal: true, checked: true });
    expect(second.type).toBe('checkListItem');
    expect(second.props.personal).toBe(true);
    expect(second.props.checked).toBe(false);
  });

  it('at the start: the emptied item and the moved text are both personal', () => {
    const editor = mount([item('a', 'first', { personal: true })]);
    cursorIn(editor, 'a', 0);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect(textOf(first)).toBe('');
    expect(first.props.personal).toBe(true);
    expect(textOf(second)).toBe('first');
    expect(second.props.personal).toBe(true);
  });

  it('in the middle: the text after the cursor moves to a personal item', () => {
    const editor = mount([item('a', 'onetwo', { personal: true })]);
    cursorIn(editor, 'a', 3);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect([textOf(first), textOf(second)]).toEqual(['one', 'two']);
    expect(second.props.personal).toBe(true);
  });

  it('a plain item still splits into a plain item (no `personal` key at all)', () => {
    const editor = mount([item('a', 'first')]);
    cursorIn(editor, 'a', 5);
    pressEnter(editor);
    const [, second] = blocks(editor);
    expect(second.type).toBe('checkListItem');
    expect('personal' in second.props).toBe(false);
    expect(serializePageContent({ blocks: editor.document as never })).not.toContain('personal');
  });

  it('an empty personal item becomes a paragraph, without the prop', () => {
    const editor = mount([
      item('a', 'first', { personal: true }),
      item('b', '', { personal: true }),
    ]);
    cursorIn(editor, 'b', 0);
    pressEnter(editor);
    const [, second] = blocks(editor);
    expect(second.type).toBe('paragraph');
    expect('personal' in second.props).toBe(false);
  });

  it('one undo takes back the split', () => {
    const editor = mount([item('a', 'onetwo', { personal: true })]);
    cursorIn(editor, 'a', 3);
    pressEnter(editor);
    expect(blocks(editor)).toHaveLength(2);
    editor.undo();
    expect(blocks(editor)).toHaveLength(1);
    expect(textOf(blocks(editor)[0])).toBe('onetwo');
  });
});
