import type { ToggledState } from '@classmoji/page-schema';

/**
 * Toggle list items and toggle headings, opened for good in one viewer.
 *
 * Readers get BlockNote's behaviour (Tim, 2026-11-23): every toggle starts
 * closed and each reader's open/closed state is remembered in their browser
 * (BlockNote's `localStorage` key per block). The MCP's page render is the
 * exception: a screenshot must show the bodies, so there every toggle is drawn
 * OPEN, and nothing is written to the browser's storage.
 *
 * How: BlockNote draws a toggle's chevron in the block's frame
 * (`createToggleFrame`, the `renderFrame` of its toggle list item and of
 * page-schema's heading), which reads and writes the open state through a
 * store. The viewer's heading and toggle list item (viewerBlocks.tsx) pass
 * `toggledStateFor(editor)`: for an editor marked here, a store that is
 * always open and writes nothing; otherwise `undefined`, BlockNote's own.
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

/** Every toggle open; nothing stored. */
const ALWAYS_OPEN: ToggledState = {
  get: () => true,
  set: () => {},
};

/** The toggle store for `editor`'s frames: always open when marked, else BlockNote's. */
export function toggledStateFor(editor: object): ToggledState | undefined {
  return openEditors.has(editor) ? ALWAYS_OPEN : undefined;
}
