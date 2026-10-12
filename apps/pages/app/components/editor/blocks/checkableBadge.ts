import { createPageHeadingBlockSpec } from '@classmoji/page-schema';

/**
 * The author's badge on a checkable heading, in the EDITOR: a small tick-box
 * glyph in the heading's gutter (drawn by page-sections.css) that says the
 * heading is checkable, with an accessible name and a tooltip. It is node-view
 * DOM next to the heading's inline content, outside it, like BlockNote's own
 * toggle button; it is not part of the document.
 *
 * Editor only (`editingSchema.ts`): the viewer draws the reader's tick box
 * instead, and the class site neither.
 */

const LABEL = 'Checkable section';

interface HeadingNodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  ignoreMutation?: (mutation: MutationRecord | { type: 'selection'; target: Node }) => boolean;
  destroy?: () => void;
}

function withCheckableBadge<T extends HeadingNodeView>(view: T): T {
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
 * The shared page heading with its render wrapped: a checkable heading gets
 * the badge. Built from a FRESH spec (see viewerBlocks.tsx's heading for why);
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
        const [block] = args;
        if ((block.props as { checkable?: unknown }).checkable !== true) return view;
        return withCheckableBadge(view as never);
      },
    },
  } as typeof base;
}
