/**
 * A live page takes no new column layouts (noNewColumns.ts): what is pasted
 * into one has its layouts unwrapped. Slices are cut from a real page document
 * under the server's page schema — a whole layout, a range across two
 * columns, a range running into a layout, and with every parent kept (the
 * shape the clipboard re-wraps a slice in) — then pasted into a page with no
 * layout, which must come out valid, with every block's text and no layout.
 * A drag within the page moves: a whole layout keeps going, a selection cut
 * through one is unwrapped, and a drag never copies.
 */
import { test, expect } from '@playwright/test';
import type { Node as PmNode, Slice } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { getServerEditor } from '@classmoji/page-schema/server';

import {
  LiveNoNewColumns,
  transformLiveSlice,
  unwrapColumnsInSlice,
} from '~/components/editor/collab/noNewColumns.ts';

const para = (id: string, text: string) => ({
  id,
  type: 'paragraph' as const,
  content: [{ type: 'text' as const, text, styles: {} }],
});

function pmDoc(blocks: unknown[]): PmNode {
  return getServerEditor()._blocksToProsemirrorNode(blocks as never) as unknown as PmNode;
}

const SOURCE = pmDoc([
  para('before', 'Before'),
  {
    id: 'cols',
    type: 'columnList',
    children: [
      { id: 'c1', type: 'column', children: [para('l1', 'Left one'), para('l2', 'Left two')] },
      { id: 'c2', type: 'column', children: [para('r', 'Right')] },
    ],
  },
  para('after', 'After'),
]);

/** The position `offset` characters into the text node holding `text`. */
function at(doc: PmNode, text: string, offset: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text === text) found = pos + offset;
    return found === -1;
  });
  if (found === -1) throw new Error(`no text "${text}"`);
  return found;
}

function layouts(node: PmNode | Slice): string[] {
  const names: string[] = [];
  const content = 'content' in node ? node.content : node;
  content.descendants(child => {
    if (child.type.name === 'columnList' || child.type.name === 'column') {
      names.push(child.type.name);
    }
  });
  return names;
}

/** Paste `slice` at the end of the only paragraph of a page without columns. */
function pasteIntoPlainPage(slice: Slice): PmNode {
  const target = pmDoc([para('t', 'Target')]);
  const state = EditorState.create({ doc: target });
  const tr = state.tr.setSelection(TextSelection.create(target, at(target, 'Target', 6)));
  tr.replaceSelection(slice);
  tr.doc.check();
  return tr.doc;
}

const cases: [string, () => Slice][] = [
  [
    'a whole layout',
    () => {
      let from = -1;
      SOURCE.descendants((node, pos) => {
        if (node.type.name === 'columnList') from = pos;
        return from === -1;
      });
      return SOURCE.slice(from, from + SOURCE.nodeAt(from)!.nodeSize);
    },
  ],
  [
    'a range across two columns',
    () => SOURCE.slice(at(SOURCE, 'Left two', 5), at(SOURCE, 'Right', 2)),
  ],
  [
    'a range running into a layout',
    () => SOURCE.slice(at(SOURCE, 'Before', 3), at(SOURCE, 'Right', 2)),
  ],
  [
    'a range across two columns, with every parent kept',
    () => SOURCE.slice(at(SOURCE, 'Left one', 2), at(SOURCE, 'Right', 3), true),
  ],
  [
    'a range out of a layout, with every parent kept',
    () => SOURCE.slice(at(SOURCE, 'Left two', 0), at(SOURCE, 'After', 3), true),
  ],
];

for (const [label, cut] of cases) {
  test(`${label}: pasted without a layout, nothing lost`, () => {
    const slice = cut();
    expect(layouts(slice).length).toBeGreaterThan(0);

    const unwrapped = unwrapColumnsInSlice(slice);
    expect(layouts(unwrapped)).toEqual([]);

    const pasted = pasteIntoPlainPage(unwrapped);
    expect(layouts(pasted)).toEqual([]);
    // Every bit of text the slice held is in the page.
    const text = (node: PmNode | Slice) => {
      const parts: string[] = [];
      ('content' in node ? node.content : node).descendants(child => {
        if (child.isText) parts.push(child.text!);
      });
      return parts.join('|');
    };
    for (const part of text(slice).split('|')) expect(text(pasted)).toContain(part);
  });
}

test('without the unwrap, a pasted layout lands in the page (what is being guarded)', () => {
  const [, cut] = cases[0];
  expect(layouts(pasteIntoPlainPage(cut()))).toContain('columnList');
});

test('a slice with no layout comes back as is', () => {
  const slice = SOURCE.slice(at(SOURCE, 'Before', 1), at(SOURCE, 'Before', 4));
  expect(unwrapColumnsInSlice(slice)).toBe(slice);
});

// ─── Drags within the page ──────────────────────────────────────────────────

/** Where the layout starts in SOURCE. */
function layoutPos(): number {
  let from = -1;
  SOURCE.descendants((node, pos) => {
    if (node.type.name === 'columnList') from = pos;
    return from === -1;
  });
  return from;
}

/** What a drag of this selection carries: `Selection.content()`, parents kept. */
const dragOfText = () =>
  TextSelection.create(SOURCE, at(SOURCE, 'Left two', 2), at(SOURCE, 'Right', 3)).content();

test('a dragged text selection across two columns is unwrapped where it lands', () => {
  const slice = dragOfText();
  expect(slice.openStart).toBeGreaterThan(0);
  // Left as it is, the drop would build a second layout.
  expect(layouts(pasteIntoPlainPage(slice))).toContain('columnList');

  const dropped = transformLiveSlice(slice, true);
  expect(layouts(dropped)).toEqual([]);
  expect(layouts(pasteIntoPlainPage(dropped))).toEqual([]);
});

test('a whole layout dragged within the page is moved as it is', () => {
  const selected = NodeSelection.create(SOURCE, layoutPos()).content();
  expect(transformLiveSlice(selected, true)).toBe(selected);
  // The side menu's drag: the block parsed back as a closed slice.
  const closed = SOURCE.slice(layoutPos(), layoutPos() + SOURCE.nodeAt(layoutPos())!.nodeSize);
  expect(transformLiveSlice(closed, true)).toBe(closed);
  // The same layout pasted is a new one, and is unwrapped.
  expect(layouts(transformLiveSlice(closed, false))).toEqual([]);
});

test('the live plugin unwraps a cut-through drag, keeps a whole one, and never copies', () => {
  const extension = (
    LiveNoNewColumns() as unknown as (ctx: { editor: unknown }) => {
      prosemirrorPlugins: { props: Record<string, (...args: unknown[]) => unknown> }[];
    }
  )({ editor: null });
  const [plugin] = extension.prosemirrorPlugins;
  const dragging = { dragging: { slice: null, move: true } };

  expect(plugin.props.dragCopies({ altKey: true, ctrlKey: true })).toBe(false);
  expect(layouts(plugin.props.transformPasted(dragOfText(), dragging, false) as Slice)).toEqual([]);
  const whole = NodeSelection.create(SOURCE, layoutPos()).content();
  expect(plugin.props.transformPasted(whole, dragging, false)).toBe(whole);
  expect(layouts(plugin.props.transformPasted(whole, { dragging: null }, false) as Slice)).toEqual(
    []
  );
});
