/**
 * Undo in the live editor (yUndo.ts): y-prosemirror's UndoManager is
 * destroyed when the editor view unmounts, and BlockNote remounts the same
 * view; reviving it brings the history back without doubling it.
 */

import { test, expect } from '@playwright/test';
import * as Y from 'yjs';

import { reviveUndoManager, yUndoManagerOf } from '../../app/components/editor/collab/yUndo.ts';

const ORIGIN = { key: 'y-sync$' };

function setup() {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([ORIGIN]) });
  const type = (s: string) => doc.transact(() => text.insert(text.length, s), ORIGIN);
  return { doc, text, undoManager, type };
}

test('a destroyed UndoManager records nothing; revived, it records and undoes again', () => {
  const { text, undoManager, type } = setup();
  undoManager.destroy(); // what the plugin view's destroy does on a remount
  type('lost ');
  expect(undoManager.undoStack.length).toBe(0);

  expect(reviveUndoManager(undoManager as never)).toBe(true);
  type('kept');
  expect(undoManager.undoStack.length).toBe(1);
  undoManager.undo();
  expect(text.toString()).toBe('lost ');
});

test('reviving a live UndoManager leaves it as it was', () => {
  const { doc, text, undoManager, type } = setup();
  const listeners = () =>
    (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('afterTransaction')
      ?.size;
  const before = listeners();
  reviveUndoManager(undoManager as never);
  reviveUndoManager(undoManager as never);
  expect(listeners()).toBe(before);
  type('one');
  undoManager.stopCapturing();
  type(' two');
  undoManager.undo();
  expect(text.toString()).toBe('one');
});

test('the UndoManager is found by the undo plugin key; none without the plugin', () => {
  const undoManager = { marker: true };
  const state = {
    plugins: [
      { key: 'y-sync$', getState: () => ({}) },
      { key: 'y-undo$', getState: () => ({ undoManager }) },
    ],
  };
  expect(yUndoManagerOf(state as never)).toBe(undoManager);
  expect(yUndoManagerOf({ plugins: [{ key: 'history$', getState: () => ({}) }] })).toBeNull();
  expect(reviveUndoManager(null)).toBe(false);
});
