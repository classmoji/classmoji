/**
 * Toggle list items and toggle headings, opened for good in one viewer.
 *
 * Readers get BlockNote's behaviour (Tim, 2026-11-23): every toggle starts
 * closed and each reader's open/closed state is remembered in their browser
 * (BlockNote's `localStorage` key per block). The MCP's page render is the
 * exception: a screenshot must show the bodies, so there every toggle is drawn
 * OPEN, and nothing is written to the browser's storage.
 *
 * How: BlockNote's toggle wrapper (`createToggleWrapper`) takes a toggled-state
 * store, but its blocks call it with the default one and offer no option to
 * pass another — using it would mean copying BlockNote's toggle list item (and
 * page-schema's heading) render wholesale. Instead the viewer's heading and
 * toggle list item specs wrap BlockNote's own render (viewerBlocks.tsx) and,
 * for an editor marked here, set the wrapper's `data-show-children` to
 * `"true"` on the node view's fresh DOM, before ProseMirror attaches it (so
 * no mutation is observed, and a re-created node view is opened again).
 * Printing opens every toggle on every surface by CSS instead
 * (`styles/page-reader.css`).
 */

const openEditors = new WeakSet<object>();

/** Draw every toggle in this editor open. Call before its view mounts. */
export function openAllToggles(editor: object): void {
  openEditors.add(editor);
}

export function togglesOpenIn(editor: object): boolean {
  return openEditors.has(editor);
}

type NodeViewLike = { dom: Node };

/** The node view with its own toggle (if it has one) open, when its editor is marked. */
export function withOpenToggle<T extends NodeViewLike>(view: T, editor: object): T {
  if (!openEditors.has(editor)) return view;
  const dom = view.dom as Element;
  // The block's OWN wrapper: its children sit in a sibling block group, not
  // inside the block content, so the first match is this block's.
  const wrapper =
    typeof dom.querySelector === 'function' ? dom.querySelector('.bn-toggle-wrapper') : null;
  wrapper?.setAttribute('data-show-children', 'true');
  return view;
}
