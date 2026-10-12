/**
 * @vitest-environment jsdom
 *
 * Enter at the very start of a block whose id keys readers' own state (a
 * checkable heading, a student check list item): the id stays with the text.
 * BlockNote's split would keep the id on the empty first half and give the
 * text a new id, so readers' ticks would follow the empty line.
 *
 * Drives a real editor (the page schema, as the pages editor builds it) with
 * real keydowns, locally, under a locked section's guard, and through Yjs.
 */
import { BlockNoteEditor } from '@blocknote/core';
// eslint-disable-next-line import/no-unresolved -- a package `exports` subpath, which the lint resolver does not read
import { withCollaboration } from '@blocknote/core/yjs';
import { TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { FRAGMENT } from '../constants.ts';
import { lockedSectionGuard } from '../lockedSectionGuard.ts';
import { createPageSchema } from '../schema.ts';
import { pageContentToYDoc } from '../server.ts';

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
const heading = (
  id: string,
  value: string,
  props: Record<string, unknown> = {},
  children: unknown[] = []
) => ({
  id,
  type: 'heading',
  props: { level: 2, ...props },
  content: value ? text(value) : [],
  children,
});
const para = (id: string, value: string) => ({
  id,
  type: 'paragraph',
  content: value ? text(value) : [],
  children: [],
});

// Toggle headings keep their open state in localStorage; this Node's jsdom
// environment has none.
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

let editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) editor._tiptapEditor.destroy();
  editors = [];
  document.body.innerHTML = '';
});

function attach(editor: Editor): Editor {
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editors.push(editor);
  return editor;
}

function mount(initialContent: unknown[], guard = false): Editor {
  return attach(
    BlockNoteEditor.create({
      schema: createPageSchema(),
      extensions: guard ? [lockedSectionGuard()] : [],
      initialContent: initialContent as never,
    }) as Editor
  );
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
  if (pos < 0) throw new Error(`no block ${id}`);
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

/** The block holding the cursor and the cursor's offset in its text. */
function caret(editor: Editor) {
  const { selection } = editor.prosemirrorState;
  return {
    id: editor.getTextCursorPosition().block.id,
    offset: selection.$from.parentOffset,
    empty: selection.empty,
  };
}

describe('Enter at the start of a student check list item', () => {
  it('adds an empty, unticked student item above; the item keeps its id, text and tick', () => {
    const editor = mount([item('a', 'first', { personal: true, checked: true })]);
    cursorIn(editor, 'a', 0);
    pressEnter(editor);
    const [added, original] = blocks(editor);
    expect(added.type).toBe('checkListItem');
    expect(typeof added.id).toBe('string');
    expect(added.id).not.toBe('a');
    expect(textOf(added)).toBe('');
    expect(added.props).toMatchObject({ personal: true, checked: false });
    expect(original.id).toBe('a');
    expect(textOf(original)).toBe('first');
    expect(original.props).toMatchObject({ personal: true, checked: true });
    expect(caret(editor)).toEqual({ id: 'a', offset: 0, empty: true });
  });

  it('one undo takes it back', () => {
    const editor = mount([item('a', 'first', { personal: true })]);
    cursorIn(editor, 'a', 0);
    pressEnter(editor);
    expect(blocks(editor)).toHaveLength(2);
    editor.undo();
    expect(blocks(editor).map(block => [block.id, textOf(block)])).toEqual([['a', 'first']]);
  });

  it('in the middle and at the end: BlockNote’s split, the new item below stays personal', () => {
    const middle = mount([item('a', 'onetwo', { personal: true })]);
    cursorIn(middle, 'a', 3);
    pressEnter(middle);
    const [first, second] = blocks(middle);
    expect([first.id, textOf(first), textOf(second)]).toEqual(['a', 'one', 'two']);
    expect(second.props.personal).toBe(true);
    expect(caret(middle)).toEqual({ id: second.id, offset: 0, empty: true });

    const end = mount([item('b', 'first', { personal: true })]);
    cursorIn(end, 'b', 5);
    pressEnter(end);
    const [kept, added] = blocks(end);
    expect([kept.id, textOf(kept), textOf(added)]).toEqual(['b', 'first', '']);
    expect(added.props.personal).toBe(true);
  });

  it('an empty student item still becomes a paragraph (leaving the list)', () => {
    const editor = mount([
      item('a', 'first', { personal: true }),
      item('b', '', { personal: true }),
    ]);
    cursorIn(editor, 'b', 0);
    pressEnter(editor);
    const [, second] = blocks(editor);
    expect([second.id, second.type]).toEqual(['b', 'paragraph']);
  });

  it('a plain item keeps BlockNote’s split at the start (its id stays on the empty line)', () => {
    const editor = mount([item('a', 'first')]);
    cursorIn(editor, 'a', 0);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect([first.id, textOf(first)]).toEqual(['a', '']);
    expect(second.id).not.toBe('a');
    expect(textOf(second)).toBe('first');
  });
});

describe('Enter at the start of a checkable heading', () => {
  it('adds an empty heading above with the same props minus `checkable`; the heading keeps its id', () => {
    const editor = mount([
      heading('h', 'Setup', {
        level: 3,
        checkable: true,
        textColor: 'red',
        backgroundColor: 'blue',
        textAlignment: 'center',
      }),
    ]);
    cursorIn(editor, 'h', 0);
    pressEnter(editor);
    const [added, original] = blocks(editor);
    expect(added.type).toBe('heading');
    expect(typeof added.id).toBe('string');
    expect(added.id).not.toBe('h');
    expect(textOf(added)).toBe('');
    expect(added.props).toMatchObject({
      level: 3,
      textColor: 'red',
      backgroundColor: 'blue',
      textAlignment: 'center',
    });
    expect('checkable' in added.props).toBe(false);
    expect(original.id).toBe('h');
    expect(textOf(original)).toBe('Setup');
    expect(original.props).toMatchObject({ level: 3, checkable: true });
    expect(caret(editor)).toEqual({ id: 'h', offset: 0, empty: true });
  });

  it('a toggle heading keeps its children (and stays the toggle that holds them)', () => {
    const editor = mount([
      heading('h', 'Setup', { isToggleable: true, checkable: true }, [para('c', 'child')]),
    ]);
    cursorIn(editor, 'h', 0);
    pressEnter(editor);
    const [added, original] = blocks(editor);
    expect(added.children).toEqual([]);
    expect(added.props.isToggleable).toBe(true);
    expect(original.id).toBe('h');
    expect(original.children.map(child => child.id)).toEqual(['c']);
  });

  it('one undo takes it back', () => {
    const editor = mount([heading('h', 'Setup', { checkable: true })]);
    cursorIn(editor, 'h', 0);
    pressEnter(editor);
    expect(blocks(editor)).toHaveLength(2);
    editor.undo();
    const [only, ...rest] = blocks(editor);
    expect(rest).toEqual([]);
    expect([only.id, textOf(only), only.props.checkable]).toEqual(['h', 'Setup', true]);
  });

  it('in the middle and at the end: BlockNote’s paragraph below, the heading keeps its id', () => {
    const middle = mount([heading('h', 'SetUp', { checkable: true })]);
    cursorIn(middle, 'h', 3);
    pressEnter(middle);
    const [first, second] = blocks(middle);
    expect([first.id, first.type, textOf(first)]).toEqual(['h', 'heading', 'Set']);
    expect([second.type, textOf(second)]).toEqual(['paragraph', 'Up']);

    const end = mount([heading('g', 'Setup', { checkable: true })]);
    cursorIn(end, 'g', 5);
    pressEnter(end);
    const [kept, added] = blocks(end);
    expect([kept.id, textOf(kept), added.type, textOf(added)]).toEqual([
      'g',
      'Setup',
      'paragraph',
      '',
    ]);
  });

  it('an empty checkable heading: BlockNote’s new paragraph below, the cursor moves there', () => {
    const editor = mount([heading('h', '', { checkable: true })]);
    cursorIn(editor, 'h', 0);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect([first.id, first.type, first.props.checkable]).toEqual(['h', 'heading', true]);
    expect(second.type).toBe('paragraph');
    expect(caret(editor).id).toBe(second.id);
  });

  it('a heading that is not checkable keeps BlockNote’s split at the start', () => {
    const editor = mount([heading('h', 'Setup')]);
    cursorIn(editor, 'h', 0);
    pressEnter(editor);
    const [first, second] = blocks(editor);
    expect([first.id, first.type, textOf(first)]).toEqual(['h', 'heading', '']);
    expect([second.type, textOf(second)]).toEqual(['heading', 'Setup']);
    expect(second.id).not.toBe('h');
  });
});

describe('inside a locked section', () => {
  function lockedPage() {
    return [
      para('P', 'intro'),
      {
        id: 'L',
        type: 'lockedSection',
        props: { title: 'Solution' },
        children: [
          heading('H', 'Step one', { checkable: true }),
          item('I', 'Install', { personal: true }),
        ],
      },
    ];
  }
  const body = (editor: Editor) => blocks(editor)[1].children;

  it('Enter at the start of the first body line (a checkable heading) adds the line inside', () => {
    const editor = mount(lockedPage(), true);
    cursorIn(editor, 'H', 0);
    pressEnter(editor);
    expect(body(editor)).toHaveLength(3);
    expect(body(editor).map(block => [block.type, textOf(block)])).toEqual([
      ['heading', ''],
      ['heading', 'Step one'],
      ['checkListItem', 'Install'],
    ]);
    expect(body(editor)[1].id).toBe('H');
    expect(blocks(editor).map(block => block.id)).toEqual(['P', 'L']);
  });

  it('Enter at the start of a student item in the body adds the line inside', () => {
    const editor = mount(lockedPage(), true);
    cursorIn(editor, 'I', 0);
    pressEnter(editor);
    expect(
      body(editor)
        .map(block => block.id)
        .slice(-1)
    ).toEqual(['I']);
    expect(body(editor)).toHaveLength(3);
    expect(body(editor)[1].props).toMatchObject({ personal: true, checked: false });
    expect(blocks(editor).map(block => block.id)).toEqual(['P', 'L']);
  });
});

describe('live (Yjs)', () => {
  /** Two editors on two linked Y.Docs, as two people in one room. */
  function pair(initialContent: unknown[]) {
    // Both start from the stored document, so neither has it in its undo stack.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const seed = Y.encodeStateAsUpdate(pageContentToYDoc({ blocks: initialContent }));
    Y.applyUpdate(docA, seed);
    Y.applyUpdate(docB, seed);
    docA.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') Y.applyUpdate(docB, update, 'remote');
    });
    docB.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') Y.applyUpdate(docA, update, 'remote');
    });
    const make = (doc: Y.Doc, name: string) =>
      attach(
        BlockNoteEditor.create(
          withCollaboration({
            schema: createPageSchema(),
            collaboration: {
              provider: undefined,
              fragment: doc.getXmlFragment(FRAGMENT),
              user: { name, color: '#000' },
            },
          } as never)
        ) as Editor
      );
    const a = make(docA, 'a');
    const b = make(docB, 'b');
    return { a, b };
  }

  it('the other editor sees the id stay with the text; undo takes it back for both', () => {
    const { a, b } = pair([
      heading('h', 'Setup', { checkable: true }),
      item('i', 'Install', { personal: true }),
    ]);
    expect(blocks(b).map(block => block.id)).toEqual(['h', 'i']);

    cursorIn(a, 'h', 0);
    pressEnter(a);
    expect(blocks(b).map(block => [block.type, textOf(block)])).toEqual([
      ['heading', ''],
      ['heading', 'Setup'],
      ['checkListItem', 'Install'],
    ]);
    expect(blocks(b)[1].id).toBe('h');
    expect(blocks(b).map(block => block.id)).toEqual(blocks(a).map(block => block.id));

    a.undo();
    expect(blocks(b).map(block => block.id)).toEqual(['h', 'i']);
    expect(blocks(a).map(block => block.id)).toEqual(['h', 'i']);

    cursorIn(a, 'i', 0);
    pressEnter(a);
    expect(blocks(b).map(block => [block.type, textOf(block)])).toEqual([
      ['heading', 'Setup'],
      ['checkListItem', ''],
      ['checkListItem', 'Install'],
    ]);
    expect(blocks(b)[2].id).toBe('i');
    expect(blocks(b)[1].props).toMatchObject({ personal: true, checked: false });
  });
});
