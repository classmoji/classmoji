/**
 * @vitest-environment jsdom
 *
 * A locked section's body stays under its lock while the author edits.
 *
 * The body of a `lockedSection` is its children; readers who have not
 * unlocked it are served the block without them. Any edit that leaves a
 * former body block outside every locked section would serve that block to
 * everyone. These tests drive a real BlockNote editor (the page schema plus
 * `lockedSectionGuard`, as the pages editor builds it) through the keys and
 * commands that change or remove blocks, and check after each one that every
 * non-empty former body block is still inside a locked section.
 */
import { BlockNoteEditor } from '@blocknote/core';
import { TextSelection } from 'prosemirror-state';
import { ySyncPluginKey } from 'y-prosemirror';
import { afterEach, describe, expect, it } from 'vitest';

import { lockedSectionGuard } from '../lockedSectionGuard.ts';
import { createPageSchema } from '../schema.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = { id: string; type: string; content?: any; props?: any; children: AnyBlock[] };

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const para = (id: string, value: string, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  content: value ? text(value) : [],
  children,
});

/** The body blocks with text: none may ever end up outside a lock. */
const SECRETS = ['S1', 'S2', 'S4', 'IN', 'IN-p'];

function page() {
  return [
    para('P', 'intro'),
    {
      id: 'L',
      type: 'lockedSection',
      props: { title: 'Solution' },
      children: [
        para('S1', 'secret one'),
        para('S2', 'secret two'),
        para('S3', ''),
        para('S4', 'secret four'),
        {
          id: 'IN',
          type: 'lockedSection',
          props: { title: 'Hint' },
          children: [para('IN-p', 'inner secret')],
        },
      ],
    },
    para('N', 'next'),
  ];
}

let editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) editor._tiptapEditor.destroy();
  editors = [];
  document.body.innerHTML = '';
});

function mount(initialContent: unknown[] = page(), guard = true): Editor {
  const editor = BlockNoteEditor.create({
    schema: createPageSchema(),
    extensions: guard ? [lockedSectionGuard()] : [],
    initialContent: initialContent as never,
  }) as Editor;
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editors.push(editor);
  return editor;
}

/** Ids of blocks with text (or children) that sit outside every locked section. */
function escaped(editor: Editor, ids = SECRETS): string[] {
  const out: string[] = [];
  const visit = (blocks: AnyBlock[], locked: boolean) => {
    for (const block of blocks) {
      const nonEmpty =
        block.children.length > 0 || !Array.isArray(block.content) || block.content.length > 0;
      if (!locked && ids.includes(block.id) && nonEmpty) out.push(block.id);
      visit(block.children, locked || block.type === 'lockedSection');
    }
  };
  visit(editor.document as AnyBlock[], false);
  return out;
}

/** Every id in the document, at any depth. */
function allIds(editor: Editor): string[] {
  const out: string[] = [];
  const visit = (blocks: AnyBlock[]) => {
    for (const block of blocks) {
      out.push(block.id);
      visit(block.children);
    }
  };
  visit(editor.document as AnyBlock[]);
  return out;
}

/**
 * A real keydown on the editor's DOM, as a browser sends it (Tiptap's
 * `keyboardShortcut` command keeps only the steps of what a handler
 * dispatches, not its selection). jsdom is not a Mac: Mod is Ctrl.
 */
function press(editor: Editor, shortcut: string) {
  const parts = shortcut.split('-');
  const key = parts.pop()!;
  const mods = new Set(parts);
  editor.prosemirrorView!.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: mods.has('Mod') || mods.has('Ctrl'),
      shiftKey: mods.has('Shift'),
      altKey: mods.has('Alt'),
    })
  );
}

/** Position of the lockedSection content node of block `id`. */
function contentPos(editor: Editor, id: string): number {
  let pos = -1;
  editor._tiptapEditor.state.doc.descendants((node, at) => {
    if (pos >= 0) return false;
    if (node.attrs.id === id) {
      pos = at + 1;
      return false;
    }
    return true;
  });
  if (pos < 0) throw new Error(`no block ${id}`);
  return pos;
}

function selectNode(editor: Editor, id: string) {
  editor._tiptapEditor.commands.setNodeSelection(contentPos(editor, id));
}

function selectedNodeType(editor: Editor): string | null {
  const selection = editor._tiptapEditor.state.selection as { node?: { type: { name: string } } };
  return selection.node?.type.name ?? null;
}

describe('the test can see an escape (no guard)', () => {
  it('Delete at the end of the block before un-nests the body', () => {
    const editor = mount(page(), false);
    editor.setTextCursorPosition('P', 'end');
    press(editor, 'Delete');
    expect(escaped(editor)).not.toEqual([]);
  });

  it('Backspace at the start of the first body line lifts the body out', () => {
    const editor = mount(page(), false);
    editor.setTextCursorPosition('S1', 'start');
    press(editor, 'Backspace');
    expect(escaped(editor)).not.toEqual([]);
  });

  it('Shift-Tab on the last body line moves it out', () => {
    const blocks = page();
    (blocks[1] as { children: unknown[] }).children.splice(4, 1); // S4 last
    const editor = mount(blocks, false);
    editor.setTextCursorPosition('S4', 'start');
    press(editor, 'Shift-Tab');
    expect(escaped(editor)).toEqual(['S4']);
  });

  it('turning the section into a paragraph keeps the body as its children', () => {
    const editor = mount(page(), false);
    editor.updateBlock('L', { type: 'paragraph' } as never);
    expect(escaped(editor)).not.toEqual([]);
  });
});

describe('lockedSectionGuard: keys around a locked section', () => {
  it('Delete at the end of the block before selects the section; a second Delete removes it whole', () => {
    const editor = mount();
    editor.setTextCursorPosition('P', 'end');
    press(editor, 'Delete');
    expect(escaped(editor)).toEqual([]);
    expect(selectedNodeType(editor)).toBe('lockedSection');
    press(editor, 'Delete');
    expect(allIds(editor)).toEqual(['P', 'N']);
  });

  it('Delete at the end of a block whose first child is a locked section', () => {
    const [p, l, n] = page();
    const editor = mount([{ ...p, children: [l] }, n]);
    editor.setTextCursorPosition('P', 'end');
    press(editor, 'Delete');
    expect(escaped(editor)).toEqual([]);
    expect(selectedNodeType(editor)).toBe('lockedSection');
  });

  it('Delete at the end of a body block before a nested locked section', () => {
    const editor = mount();
    editor.setTextCursorPosition('S4', 'end');
    press(editor, 'Delete');
    expect(escaped(editor)).toEqual([]);
    expect(selectedNodeType(editor)).toBe('lockedSection');
  });

  it('Delete at the end of the last body block (walks out to the block after)', () => {
    const blocks = page();
    (blocks[1] as { children: unknown[] }).children.splice(4, 1); // no inner lock
    const editor = mount(blocks);
    editor.setTextCursorPosition('S4', 'end');
    press(editor, 'Delete');
    expect(escaped(editor)).toEqual([]);
  });

  it('Backspace at the start of the block after does not pull the body out', () => {
    const editor = mount();
    editor.setTextCursorPosition('N', 'start');
    press(editor, 'Backspace');
    expect(escaped(editor)).toEqual([]);
  });

  for (const key of ['Backspace', 'Delete']) {
    it(`${key} on the selected section removes it with its body`, () => {
      const editor = mount();
      selectNode(editor, 'L');
      press(editor, key);
      expect(allIds(editor)).toEqual(['P', 'N']);
    });
  }

  it('Enter on the selected section adds a block after it, body untouched', () => {
    const editor = mount();
    selectNode(editor, 'L');
    press(editor, 'Enter');
    expect(escaped(editor)).toEqual([]);
    const top = (editor.document as AnyBlock[]).map(b => b.type);
    expect(top).toEqual(['paragraph', 'lockedSection', 'paragraph', 'paragraph']);
  });

  it('removing the section (side menu Delete) takes the body with it', () => {
    const editor = mount();
    editor.removeBlocks(['L']);
    expect(allIds(editor)).toEqual(['P', 'N']);
  });
});

describe('lockedSectionGuard: keys inside the body', () => {
  for (const id of ['S1', 'S2', 'S4']) {
    for (const [key, where] of [
      ['Backspace', 'start'],
      ['Enter', 'start'],
      ['Enter', 'end'],
      ['Shift-Tab', 'start'],
      ['Tab', 'start'],
      ['Mod-Shift-ArrowUp', 'start'],
      ['Mod-Shift-ArrowDown', 'start'],
    ] as const) {
      it(`${key} at the ${where} of ${id}`, () => {
        const editor = mount();
        editor.setTextCursorPosition(id, where);
        press(editor, key);
        expect(escaped(editor)).toEqual([]);
      });
    }
  }

  it('Enter on an empty middle line keeps the lines after it inside', () => {
    const editor = mount();
    editor.setTextCursorPosition('S3', 'start');
    press(editor, 'Enter');
    expect(escaped(editor)).toEqual([]);
  });

  it('Enter twice at the end of the body leaves the section with an empty line', () => {
    const blocks = page();
    (blocks[1] as { children: unknown[] }).children.splice(4, 1); // S4 last
    const editor = mount(blocks);
    editor.setTextCursorPosition('S4', 'end');
    press(editor, 'Enter');
    press(editor, 'Enter');
    expect(escaped(editor)).toEqual([]);
    // The way out of a section by keyboard: the new empty line, alone.
    const top = editor.document as AnyBlock[];
    expect(top.map(b => b.type)).toEqual(['paragraph', 'lockedSection', 'paragraph', 'paragraph']);
    expect(top[2].content).toEqual([]);
    expect(top[1].children.map(b => b.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
  });

  it('a nested lock’s body stays in the nested lock (not just in the outer one)', () => {
    const editor = mount();
    editor.setTextCursorPosition('IN-p', 'start');
    press(editor, 'Shift-Tab');
    press(editor, 'Backspace');
    const inner = editor.getBlock('IN') as AnyBlock | undefined;
    expect(inner?.type).toBe('lockedSection');
    expect(inner?.children.map(b => b.id)).toEqual(['IN-p']);
  });

  it('Tab on the block after nests it into the section, not the body out', () => {
    const editor = mount();
    editor.setTextCursorPosition('N', 'start');
    press(editor, 'Tab');
    expect(escaped(editor)).toEqual([]);
  });

  it('Mod-Shift-ArrowUp on the block after, Mod-Shift-ArrowDown on the block before', () => {
    let editor = mount();
    editor.setTextCursorPosition('N', 'start');
    press(editor, 'Mod-Shift-ArrowUp');
    expect(escaped(editor)).toEqual([]);
    editor = mount();
    editor.setTextCursorPosition('P', 'start');
    press(editor, 'Mod-Shift-ArrowDown');
    expect(escaped(editor)).toEqual([]);
  });
});

describe('lockedSectionGuard: changing the block type', () => {
  it('the formatting toolbar’s block type select over a selection spanning the section', () => {
    const editor = mount();
    editor.setSelection('P', 'N');
    const selected = editor.getSelection()?.blocks ?? [];
    expect(selected.map(b => b.id)).toContain('L');
    // What BlockTypeSelect's item does (one transaction, every selected block).
    editor.transact(() => {
      for (const block of selected) {
        editor.updateBlock(block, { type: 'heading', props: { level: 1 } } as never);
      }
    });
    expect(escaped(editor)).toEqual([]);
    // The whole change is refused, the other blocks included.
    expect((editor.document as AnyBlock[]).map(b => b.type)).toEqual([
      'paragraph',
      'lockedSection',
      'paragraph',
    ]);
  });

  it('updateBlock to another type is refused; the title can still change', () => {
    const editor = mount();
    editor.updateBlock('L', { type: 'paragraph' } as never);
    expect(escaped(editor)).toEqual([]);
    expect(editor.getBlock('L')?.type).toBe('lockedSection');
    editor.updateBlock('L', { props: { title: 'Answers' } } as never);
    expect(editor.getBlock('L')?.props).toEqual({ title: 'Answers' });
    expect(escaped(editor)).toEqual([]);
  });

  it('turning the nested section into a paragraph is refused too', () => {
    const editor = mount();
    editor.updateBlock('IN', { type: 'paragraph' } as never);
    expect(escaped(editor)).toEqual([]);
    expect(editor.getBlock('IN')?.type).toBe('lockedSection');
  });
});

describe('lockedSectionGuard: what it lets through', () => {
  /** A transaction that moves S1 (with its text) to the top level, after N. */
  function moveOut(editor: Editor) {
    const view = editor.prosemirrorView!;
    const state = view.state;
    const from = contentPos(editor, 'S1') - 1;
    const node = state.doc.nodeAt(from)!;
    const tr = state.tr.delete(from, from + node.nodeSize);
    return tr.insert(tr.doc.content.size - 1, node);
  }

  it('refuses a local move of a body block out of the section (drag included)', () => {
    const editor = mount();
    const view = editor.prosemirrorView!;
    view.dispatch(moveOut(editor).setMeta('uiEvent', 'drop'));
    expect(escaped(editor)).toEqual([]);
  });

  it('never refuses a change from a collaborator (Yjs) or an undo', () => {
    expect((ySyncPluginKey as unknown as { key: string }).key).toBe('y-sync$');
    const remote = mount();
    remote.prosemirrorView!.dispatch(moveOut(remote).setMeta(ySyncPluginKey, {}));
    expect(escaped(remote)).toEqual(['S1']);

    const undo = mount();
    undo.prosemirrorView!.dispatch(moveOut(undo).setMeta('history$', { redo: false }));
    expect(escaped(undo)).toEqual(['S1']);
  });

  it('lets ordinary typing and moves inside the body through', () => {
    const editor = mount();
    editor.setTextCursorPosition('S2', 'end');
    editor.insertInlineContent(' more');
    expect(editor.getBlock('S2')?.content).toEqual(text('secret two more'));
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, contentPos(editor, 'S1') + 1))
    );
    press(editor, 'Mod-Shift-ArrowDown');
    expect(escaped(editor)).toEqual([]);
  });
});

// ProseMirror's pasteHTML/pasteText build a ClipboardEvent; jsdom has none.
(globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {};

/** The text of a block's inline content. */
function textOf(block: AnyBlock | undefined): string {
  if (!block || !Array.isArray(block.content)) return '';
  return block.content.map((item: { text?: string }) => item.text ?? '').join('');
}

/** Selects from character `fromAt` of block `from` to character `toAt` of block `to`. */
function selectText(editor: Editor, from: string, fromAt: number, to: string, toAt: number) {
  const view = editor.prosemirrorView!;
  const anchor = contentPos(editor, from) + 1 + fromAt;
  const head = contentPos(editor, to) + 1 + toAt;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
}

/**
 * A printable key as a browser sends it. ProseMirror inserts it on keypress
 * when the selection spans blocks; otherwise the browser edits the DOM and
 * ProseMirror dispatches the same insertText, done here directly.
 */
function typeChar(editor: Editor, char: string) {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keypress', {
    key: char,
    charCode: char.charCodeAt(0),
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(event);
  if (!event.defaultPrevented) view.dispatch(view.state.tr.insertText(char));
}

type Clipboard = Record<string, string>;

/** A cut or paste event on the editor's DOM, backed by `clipboard`. */
function clipboardEvent(editor: Editor, type: 'cut' | 'paste', clipboard: Clipboard) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      get types() {
        return Object.keys(clipboard);
      },
      files: [],
      items: [],
      clearData() {
        for (const key of Object.keys(clipboard)) delete clipboard[key];
      },
      setData(format: string, value: string) {
        clipboard[format] = value;
      },
      getData(format: string) {
        return clipboard[format] ?? '';
      },
    },
  });
  editor.prosemirrorView!.dom.dispatchEvent(event);
}

/** Texts containing "secret" that sit outside every locked section (ids change on paste). */
function secretsOutside(editor: Editor): string[] {
  const out: string[] = [];
  const visit = (blocks: AnyBlock[], locked: boolean) => {
    for (const block of blocks) {
      if (!locked && textOf(block).includes('secret')) out.push(textOf(block));
      visit(block.children, locked || block.type === 'lockedSection');
    }
  };
  visit(editor.document as AnyBlock[], false);
  return out;
}

function countLocks(editor: Editor): number {
  let count = 0;
  const visit = (blocks: AnyBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'lockedSection') count++;
      visit(block.children);
    }
  };
  visit(editor.document as AnyBlock[]);
  return count;
}

/** page() without the nested lock: S4 is the last body line. */
function pageWithoutInner() {
  const blocks = page();
  (blocks[1] as { children: unknown[] }).children.splice(4, 1);
  return blocks;
}

/** page() with a body line after the nested lock. */
function pageWithLineAfterInner() {
  const blocks = page();
  (blocks[1] as { children: unknown[] }).children.push(para('S5', 'secret five'));
  return blocks;
}

describe('lockedSectionGuard: selections across a lock’s edge', () => {
  const edits: [string, (editor: Editor) => void][] = [
    ['Delete', editor => press(editor, 'Delete')],
    ['Backspace', editor => press(editor, 'Backspace')],
    ['typing a character', editor => typeChar(editor, 'x')],
    ['pasting text', editor => clipboardEvent(editor, 'paste', { 'text/plain': 'pasted' })],
    ['pasting HTML', editor => clipboardEvent(editor, 'paste', { 'text/html': '<p>pasted</p>' })],
    ['cut', editor => clipboardEvent(editor, 'cut', {})],
  ];
  const crossings: [string, () => unknown[], [string, number, string, number]][] = [
    ['from the block before into the first body line', page, ['P', 2, 'S1', 4]],
    ['from the first body line back to the block before', page, ['S1', 4, 'P', 2]],
    ['from the last body line into the block after', pageWithoutInner, ['S4', 3, 'N', 2]],
    ['from the block after back into the last body line', pageWithoutInner, ['N', 2, 'S4', 3]],
    ['from the outer body into a nested lock’s first line', page, ['S4', 3, 'IN-p', 3]],
    [
      'from a nested lock’s last line into the outer body',
      pageWithLineAfterInner,
      ['IN-p', 3, 'S5', 3],
    ],
    ['from a nested lock’s last line out of both locks', page, ['IN-p', 3, 'N', 2]],
    ['from the block before into a nested lock', page, ['P', 2, 'IN-p', 3]],
  ];
  for (const [where, content, [from, fromAt, to, toAt]] of crossings) {
    for (const [name, edit] of edits) {
      it(`${name} ${where} is refused`, () => {
        const editor = mount(content());
        selectText(editor, from, fromAt, to, toAt);
        const before = JSON.stringify(editor.document);
        edit(editor);
        expect(JSON.stringify(editor.document)).toBe(before);
        expect(escaped(editor)).toEqual([]);
      });
    }
  }

  it('the same edit applies when it comes from a collaborator (Yjs)', () => {
    const editor = mount();
    selectText(editor, 'P', 2, 'S1', 4);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.deleteSelection().setMeta(ySyncPluginKey, {}));
    expect(editor.getBlock('S1')).toBeUndefined();
    expect(textOf(editor.getBlock('P') as AnyBlock)).toBe('inet one');
  });
});

describe('lockedSectionGuard: selections that take whole locks', () => {
  for (const key of ['Delete', 'Backspace']) {
    it(`${key} over a selection from the block before into the block after removes the section`, () => {
      const editor = mount();
      selectText(editor, 'P', 2, 'N', 2);
      press(editor, key);
      expect(allIds(editor)).toEqual(['P']);
      expect(textOf(editor.getBlock('P') as AnyBlock)).toBe('inxt');
    });
  }

  it('typing over a selection from the block before into the block after', () => {
    const editor = mount();
    selectText(editor, 'P', 2, 'N', 2);
    typeChar(editor, 'X');
    expect(allIds(editor)).toEqual(['P']);
    expect(textOf(editor.getBlock('P') as AnyBlock)).toBe('inXxt');
  });

  it('Delete from the block before to the end of the section’s last line', () => {
    const editor = mount();
    selectText(editor, 'P', 2, 'IN-p', 'inner secret'.length);
    press(editor, 'Delete');
    expect(allIds(editor)).toEqual(['P', 'N']);
    expect(textOf(editor.getBlock('P') as AnyBlock)).toBe('in');
  });

  it('Delete from the outer body to the end of a nested lock removes the nested lock only', () => {
    const editor = mount();
    selectText(editor, 'S4', 3, 'IN-p', 'inner secret'.length);
    press(editor, 'Delete');
    expect(allIds(editor)).toEqual(['P', 'L', 'S1', 'S2', 'S3', 'S4', 'N']);
    expect(textOf(editor.getBlock('S4') as AnyBlock)).toBe('sec');
  });

  const lockedPage = () => [
    {
      id: 'L0',
      type: 'lockedSection',
      props: { title: 'First' },
      children: [para('S0', 'secret zero')],
    },
    ...page(),
    {
      id: 'L9',
      type: 'lockedSection',
      props: { title: 'Last' },
      children: [para('S9', 'secret nine')],
    },
  ];
  for (const [name, content] of [
    ['a page', page],
    ['a page that starts and ends with a locked section', lockedPage],
  ] as const) {
    for (const key of ['Delete', 'Backspace']) {
      it(`select all then ${key} empties ${name}`, () => {
        const editor = mount(content());
        editor._tiptapEditor.commands.selectAll();
        press(editor, key);
        const blocks = editor.document as AnyBlock[];
        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe('paragraph');
        expect(blocks[0].content).toEqual([]);
        expect(blocks[0].children).toEqual([]);
      });
    }
  }

  it('cut a whole section, then paste it after a block and into another lock’s body', () => {
    const editor = mount();
    selectText(editor, 'P', 'intro'.length, 'N', 0);
    const clipboard: Clipboard = {};
    clipboardEvent(editor, 'cut', clipboard);
    expect(countLocks(editor)).toBe(0);
    expect(textOf(editor.getBlock('P') as AnyBlock)).toBe('intronext');
    expect(clipboard['blocknote/html']).toContain('secret one');

    editor.setTextCursorPosition('P', 'end');
    clipboardEvent(editor, 'paste', { ...clipboard });
    expect(countLocks(editor)).toBe(2);
    expect(JSON.stringify(editor.document)).toContain('secret one');
    expect(secretsOutside(editor)).toEqual([]);

    const other = mount();
    other.setTextCursorPosition('S2', 'end');
    clipboardEvent(other, 'paste', { ...clipboard });
    expect(countLocks(other)).toBe(4);
    expect(secretsOutside(other)).toEqual([]);
    expect(escaped(other)).toEqual([]);
  });
});

describe('lockedSectionGuard: edits within one side of an edge', () => {
  it('typing over a selection inside a body line', () => {
    const editor = mount();
    selectText(editor, 'S1', 0, 'S1', 6);
    typeChar(editor, 'X');
    expect(textOf(editor.getBlock('S1') as AnyBlock)).toBe('X one');
  });

  it('Delete over a selection across two body lines joins them inside the lock', () => {
    const editor = mount();
    selectText(editor, 'S1', 3, 'S2', 3);
    press(editor, 'Delete');
    expect(editor.getBlock('S2')).toBeUndefined();
    expect(textOf(editor.getBlock('S1') as AnyBlock)).toBe('secret two');
    expect(escaped(editor)).toEqual([]);
  });

  it('pasting over a selection across two body lines', () => {
    const editor = mount();
    selectText(editor, 'S1', 3, 'S2', 3);
    clipboardEvent(editor, 'paste', { 'text/plain': 'pasted' });
    expect(textOf(editor.getBlock('S1') as AnyBlock)).toBe('secpastedret two');
    expect(escaped(editor)).toEqual([]);
  });

  it('Delete over a selection across two blocks outside any lock', () => {
    const editor = mount([para('A', 'alpha'), ...page()]);
    selectText(editor, 'A', 2, 'P', 2);
    press(editor, 'Delete');
    expect(editor.getBlock('P')).toBeUndefined();
    expect(textOf(editor.getBlock('A') as AnyBlock)).toBe('altro');
    expect(countLocks(editor)).toBe(2);
  });

  it('Delete over a selection inside a nested lock’s line', () => {
    const editor = mount();
    selectText(editor, 'IN-p', 0, 'IN-p', 6);
    press(editor, 'Delete');
    expect(textOf(editor.getBlock('IN-p') as AnyBlock)).toBe('secret');
  });

  it('Tab on the block after still nests it into the section', () => {
    const editor = mount();
    editor.setTextCursorPosition('N', 'start');
    press(editor, 'Tab');
    expect((editor.getBlock('L') as AnyBlock).children.map(b => b.id)).toContain('N');
  });

  it('Mod-Shift-ArrowUp on the block after still moves it into the section', () => {
    const editor = mount();
    editor.setTextCursorPosition('N', 'start');
    press(editor, 'Mod-Shift-ArrowUp');
    expect(JSON.stringify(editor.getBlock('L'))).toContain('"id":"N"');
    expect((editor.document as AnyBlock[]).map(b => b.id)).toEqual(['P', 'L']);
  });

  it('Delete at the end of the last body line still pulls the block after in', () => {
    const editor = mount(pageWithoutInner());
    editor.setTextCursorPosition('S4', 'end');
    press(editor, 'Delete');
    expect(editor.getBlock('N')).toBeUndefined();
    expect(textOf(editor.getBlock('S4') as AnyBlock)).toBe('secret fournext');
  });
});
