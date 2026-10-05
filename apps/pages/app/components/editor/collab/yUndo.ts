/**
 * Keep the live editor's undo history recording across view remounts.
 *
 * In live mode BlockNote swaps ProseMirror's history for y-prosemirror's undo
 * plugin, whose Yjs UndoManager lives in the plugin's state but is DESTROYED
 * by the plugin view's `destroy` (it stops listening to the document). The
 * state outlives the view: BlockNote unmounts and remounts the same editor
 * view whenever its mount ref changes (React's StrictMode double mount in
 * development, any change of `editable`), and the new view never brings the
 * listener back — so after the first remount undo silently does nothing.
 *
 * `reviveUndoManager` re-attaches what `UndoManager.destroy()` detached (the
 * document listener and its own tracked origin). It is idempotent: on an
 * UndoManager that was never destroyed it leaves one listener, as before.
 * Pure over a duck-typed manager: tests/unit/collab-undo.spec.ts.
 */

/** The parts of a Yjs UndoManager this touches. */
export interface UndoManagerLike {
  doc: {
    on(event: 'afterTransaction', handler: (...args: never[]) => void): void;
    off(event: 'afterTransaction', handler: (...args: never[]) => void): void;
  };
  afterTransactionHandler: (...args: never[]) => void;
  trackedOrigins: Set<unknown>;
}

/** Re-attach a (possibly destroyed) UndoManager to its document. */
export function reviveUndoManager(undoManager: UndoManagerLike | null | undefined): boolean {
  if (!undoManager?.doc || typeof undoManager.afterTransactionHandler !== 'function') return false;
  undoManager.doc.off('afterTransaction', undoManager.afterTransactionHandler);
  undoManager.doc.on('afterTransaction', undoManager.afterTransactionHandler);
  undoManager.trackedOrigins.add(undoManager);
  return true;
}

/** The y-prosemirror UndoManager in an editor state, found by plugin key name. */
export function yUndoManagerOf(state: {
  plugins: readonly { key: string; getState(state: never): unknown }[];
}): UndoManagerLike | null {
  const plugin = state.plugins.find(p => p.key.startsWith('y-undo$'));
  const pluginState = plugin?.getState(state as never) as
    | { undoManager?: UndoManagerLike }
    | undefined;
  return pluginState?.undoManager ?? null;
}
