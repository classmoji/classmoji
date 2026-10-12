import {
  createPageCheckListItemBlockSpec,
  createPageHeadingBlockSpec,
} from '@classmoji/page-schema';

import { registerDoneChipSlot } from './doneChipSlots.ts';

/**
 * The author's badge on a checkable heading, in the EDITOR: a small tick-box
 * glyph in the heading's gutter (drawn by page-sections.css) that says the
 * heading is checkable, with an accessible name and a tooltip. It is node-view
 * DOM next to the heading's inline content, outside it, like BlockNote's own
 * toggle button; it is not part of the document.
 *
 * The node view (not the "dom" render BlockNote serializes for the clipboard)
 * also gets an empty slot at the end of the heading row, where `DoneChips`
 * portals the staff's "Done by X of Y" chip. The slot is outside the inline
 * content, not editable, and ProseMirror neither watches its DOM nor handles
 * its events, so the chip is never part of the document, the selection or
 * what is copied.
 *
 * Editor only (`editingSchema.ts`): the viewer draws the reader's tick box
 * instead, and the class site neither.
 */

const LABEL = 'Checkable section';

interface HeadingNodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  ignoreMutation?: (mutation: MutationRecord | { type: 'selection'; target: Node }) => boolean;
  stopEvent?: (event: Event) => boolean;
  destroy?: () => void;
}

/** The chip slot's owner: the editor whose `DoneChips` fills it, and the block. */
interface ChipSlotOwner {
  editor: object;
  blockId: string;
}

function withCheckableBadge<T extends HeadingNodeView>(
  view: T,
  slotOwner: ChipSlotOwner | null
): T {
  const badge = document.createElement('span');
  badge.className = 'pg-checkable-badge';
  badge.contentEditable = 'false';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', LABEL);
  badge.title = LABEL;

  // `dom` is the block's content element (the shared heading's render is
  // already wrapped in BlockNote's block structure), outside the heading's
  // inline content: ProseMirror would remove anything it did not draw there.
  view.dom.appendChild(badge);

  let slot: HTMLElement | null = null;
  let unregister: (() => void) | null = null;
  if (slotOwner) {
    slot = document.createElement('span');
    slot.className = 'pg-done-chip-slot';
    slot.setAttribute('contenteditable', 'false');
    slot.dataset.blockId = slotOwner.blockId;
    view.dom.appendChild(slot);
    unregister = registerDoneChipSlot(slotOwner.editor, slotOwner.blockId, slot);
  }

  const inSlot = (target: Node | null) => Boolean(target && slot?.contains(target));

  const ignoreMutation = view.ignoreMutation;
  const stopEvent = view.stopEvent;
  const destroy = view.destroy;
  return {
    ...view,
    // React drawing the chip must not make ProseMirror redraw the heading.
    ignoreMutation: mutation =>
      badge.contains(mutation.target as Node) ||
      inSlot(mutation.target as Node) ||
      (ignoreMutation ? ignoreMutation(mutation) : false),
    // Clicks and keys on the chip are the chip's, not the editor's. A block
    // dragged onto the chip still lands in the editor.
    stopEvent: (event: Event) =>
      (inSlot(event.target as Node | null) &&
        !event.type.startsWith('drag') &&
        event.type !== 'drop') ||
      (stopEvent ? stopEvent(event) : false),
    destroy: () => {
      unregister?.();
      badge.remove();
      slot?.remove();
      destroy?.();
    },
  };
}

/**
 * The shared page heading with its render wrapped: a checkable heading gets
 * the badge (and, as a node view, the chip slot). Built from a FRESH spec (see viewerBlocks.tsx's heading for why);
 * config, parse rules, toggle wrapper, input rules and shortcuts are the
 * shared heading's.
 */
export function createEditorHeadingSpec() {
  const base = createPageHeadingBlockSpec();
  const render = base.implementation.render;
  return {
    ...base,
    implementation: {
      ...base.implementation,
      render(this: unknown, ...args: Parameters<typeof render>) {
        const view = render.apply(this as never, args);
        const [block, editor] = args;
        if ((block.props as { checkable?: unknown }).checkable !== true) return view;
        // Only a live node view gets the chip slot (and a `destroy` to drop it).
        const nodeView = (this as { renderType?: unknown } | undefined)?.renderType === 'nodeView';
        const slotOwner =
          nodeView && editor && typeof block.id === 'string'
            ? { editor: editor as object, blockId: block.id }
            : null;
        return withCheckableBadge(view as never, slotOwner);
      },
    },
  } as typeof base;
}

/** The student check list badge's accessible name and tooltip. */
export const PERSONAL_LIST_LABEL = 'Students tick their own';

/**
 * The author's badge on a student check list item (`personal: true`), in the
 * EDITOR: a small person glyph in the item's gutter (page-sections.css), named
 * and with a tooltip. Node-view DOM outside the item's inline content, like
 * the checkable heading's badge; not part of the document.
 */
function withPersonalBadge<T extends HeadingNodeView>(view: T): T {
  const badge = document.createElement('span');
  badge.className = 'pg-personal-badge';
  badge.contentEditable = 'false';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', PERSONAL_LIST_LABEL);
  badge.title = PERSONAL_LIST_LABEL;
  view.dom.appendChild(badge);

  const ignoreMutation = view.ignoreMutation;
  const destroy = view.destroy;
  return {
    ...view,
    ignoreMutation: mutation =>
      badge.contains(mutation.target as Node) ||
      (ignoreMutation ? ignoreMutation(mutation) : false),
    destroy: () => {
      badge.remove();
      destroy?.();
    },
  };
}

/**
 * The shared page check list item with its render wrapped: a personal item
 * gets the badge. Built from a FRESH spec (see viewerBlocks.tsx's heading for
 * why); everything else is the shared item's (BlockNote's, with `personal`
 * kept on Enter).
 */
export function createEditorCheckListItemSpec() {
  const base = createPageCheckListItemBlockSpec();
  const render = base.implementation.render;
  return {
    ...base,
    implementation: {
      ...base.implementation,
      render(this: unknown, ...args: Parameters<typeof render>) {
        const view = render.apply(this as never, args);
        const [block] = args;
        if ((block.props as { personal?: unknown }).personal !== true) return view;
        return withPersonalBadge(view as never);
      },
    },
  } as typeof base;
}
