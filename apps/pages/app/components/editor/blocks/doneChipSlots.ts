/**
 * Where the "Done by X of Y" chips go: one empty element per checkable heading
 * on screen, made by the heading's node view (`checkableBadge.ts`) and filled
 * by `DoneChips`, which portals a React chip into each.
 *
 * Kept per editor (a page can mount more than one) and outside React: node
 * views are built and destroyed by ProseMirror, mid-transaction, where no
 * React state can be set. Listeners hear about changes on a microtask, once
 * per batch, after ProseMirror has finished.
 */

export interface DoneChipSlot {
  /** Unique per slot: one block can briefly have two (old and new node view). */
  key: number;
  blockId: string;
  element: HTMLElement;
}

interface SlotStore {
  slots: readonly DoneChipSlot[];
  listeners: Set<() => void>;
  scheduled: boolean;
}

const stores = new WeakMap<object, SlotStore>();
const NO_SLOTS: readonly DoneChipSlot[] = Object.freeze([]);
let nextKey = 0;

function storeFor(editor: object): SlotStore {
  let store = stores.get(editor);
  if (!store) {
    store = { slots: NO_SLOTS, listeners: new Set(), scheduled: false };
    stores.set(editor, store);
  }
  return store;
}

function notify(store: SlotStore) {
  if (store.scheduled) return;
  store.scheduled = true;
  queueMicrotask(() => {
    store.scheduled = false;
    for (const listener of [...store.listeners]) listener();
  });
}

/** Add a slot for this editor; the returned function takes it away again. */
export function registerDoneChipSlot(
  editor: object,
  blockId: string,
  element: HTMLElement
): () => void {
  const store = storeFor(editor);
  const slot: DoneChipSlot = { key: ++nextKey, blockId, element };
  store.slots = [...store.slots, slot];
  notify(store);
  return () => {
    if (!store.slots.includes(slot)) return;
    store.slots = store.slots.filter(entry => entry !== slot);
    notify(store);
  };
}

/** This editor's slots (the same array until one is added or removed). */
export function doneChipSlots(editor: object): readonly DoneChipSlot[] {
  return stores.get(editor)?.slots ?? NO_SLOTS;
}

export function subscribeDoneChipSlots(editor: object, listener: () => void): () => void {
  const store = storeFor(editor);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** For the server render: no slots. */
export function noDoneChipSlots(): readonly DoneChipSlot[] {
  return NO_SLOTS;
}
