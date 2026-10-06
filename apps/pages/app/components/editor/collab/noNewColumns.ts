/**
 * Live pages take no NEW column layouts.
 *
 * Two people each deleting a different column of one layout while offline
 * merge into a layout with one column, which the schema forbids
 * (`column column+`): y-prosemirror drops it — and the remaining column's
 * content with it — on every client before the collab server's repair can
 * run. So in live mode the editor keeps the layouts a page already has (they
 * render, stay editable and can be deleted) and offers no way to make another:
 *
 * - no "Two / Three Columns" slash items (PageEditor);
 * - no drop beside a block: xl-multi-column turns an edge drop into a
 *   `columnList` in `MULTI_COLUMN_DROP_HANDLER`, an extension its `column`
 *   block spec registers, so it is disabled by key rather than left out;
 * - content pasted, dropped in from outside, or dragged as a selection cut
 *   through a layout has its layouts unwrapped, and a drag never copies
 *   (`transformLiveSlice`).
 *
 * The schema keeps `columnList` and `column`: an editor without them would
 * make y-prosemirror delete the page's existing layouts from the shared doc.
 * The collab server refuses a new layout from an agent the same way.
 */
import { createExtension } from '@blocknote/core';
import { Fragment, Slice, type Node as PmNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';

/** xl-multi-column's drop handler (`multiColumnHandleDropPlugin.ts`), by key. */
export const MULTI_COLUMN_DROP_HANDLER = 'multiColumnDropHandler';

const WRAPPERS = new Set(['columnList', 'column']);

/** `fragment` with every columnList / column replaced by its blocks, at any depth. */
function unwrap(fragment: Fragment): Fragment {
  let changed = false;
  const out: PmNode[] = [];
  fragment.forEach(node => {
    if (WRAPPERS.has(node.type.name)) {
      changed = true;
      unwrap(node.content).forEach(child => out.push(child));
      return;
    }
    const content = unwrap(node.content);
    if (content === node.content) {
      out.push(node);
    } else {
      changed = true;
      out.push(node.copy(content));
    }
  });
  return changed ? Fragment.from(out) : fragment;
}

/** How many wrappers sit among the `open` levels along one edge of a slice. */
function openWrappers(fragment: Fragment, open: number, edge: 'start' | 'end'): number {
  let count = 0;
  let node = edge === 'start' ? fragment.firstChild : fragment.lastChild;
  for (let level = 0; level < open && node; level++) {
    if (WRAPPERS.has(node.type.name)) count++;
    node = edge === 'start' ? node.firstChild : node.lastChild;
  }
  return count;
}

/**
 * A pasted slice with its column layouts unwrapped: each column's blocks take
 * the layout's place, in order. A slice cut from inside a layout is open
 * through it, so each wrapper removed from an open edge closes that edge one
 * level less. A slice with no layout comes back as is.
 */
export function unwrapColumnsInSlice(slice: Slice): Slice {
  const content = unwrap(slice.content);
  if (content === slice.content) return slice;
  return new Slice(
    content,
    slice.openStart - openWrappers(slice.content, slice.openStart, 'start'),
    slice.openEnd - openWrappers(slice.content, slice.openEnd, 'end')
  );
}

/**
 * What the live editor does with a pasted or dropped slice. Pasted content,
 * and content dropped in from outside, has its layouts unwrapped. A drag
 * within the page is always a move (`dragCopies` below), so a whole layout
 * dragged elsewhere keeps its id and stays a layout — unless the slice is cut
 * through a layout (a text selection across two columns is open through the
 * `columnList`), which would build a second one where it lands.
 */
export function transformLiveSlice(slice: Slice, dragging: boolean): Slice {
  const cutThroughLayout =
    openWrappers(slice.content, slice.openStart, 'start') > 0 ||
    openWrappers(slice.content, slice.openEnd, 'end') > 0;
  return dragging && !cutThroughLayout ? slice : unwrapColumnsInSlice(slice);
}

export const LiveNoNewColumns = createExtension(() => ({
  key: 'liveNoNewColumns',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('liveNoNewColumns'),
      props: {
        transformPasted: (slice, view) => transformLiveSlice(slice, Boolean(view.dragging)),
        // ProseMirror copies instead of moving when a modifier is held at the
        // drop; a copied layout would be a new one.
        dragCopies: () => false,
      },
    }),
  ],
}));
