/**
 * Server-side enforcement of slide locks against peers that skip the client
 * checks. A transaction written by client X that changes a slide's html,
 * deletes it, or moves it into another stack, while the slide's lock (as it
 * was BEFORE that transaction, confirmed by the arbiter) belongs to someone
 * else, is undone in the same tick: the previous html is put back, a deleted
 * slide is re-created from the snapshot kept for it, a moved slide goes back.
 *
 * Attributes, visibility, notes and plain reordering are not lock-protected
 * (they never were in the editor either) and are left alone.
 */
import * as Y from 'yjs';

import { deckLocks, deckSlides, readSlideAttrs, readSlideHtml, writeAttrs } from './convert.ts';
import { isSlideLock, type StampedLock } from './locks.ts';
import { F } from './shape.ts';

interface SlideSnapshot {
  html: string | undefined;
  hidden: boolean;
  attrs: Record<string, string>;
  notes: string;
  hasNotes: boolean;
  parent: string | null;
  order: string;
  keyOrder: unknown;
}

function snapshotOf(map: Y.Map<unknown>): SlideSnapshot {
  const notes = map.get(F.notes);
  const parent = map.get(F.parent);
  const order = map.get(F.order);
  return {
    html: readSlideHtml(map),
    hidden: map.get(F.hidden) === true,
    attrs: readSlideAttrs(map),
    notes: notes instanceof Y.Text ? notes.toString() : '',
    hasNotes: map.get(F.hasNotes) === true,
    parent: typeof parent === 'string' ? parent : null,
    order: typeof order === 'string' ? order : '',
    keyOrder: map.get(F.keyOrder),
  };
}

function recreate(slides: Y.Map<Y.Map<unknown>>, id: string, snap: SlideSnapshot): void {
  const map = new Y.Map<unknown>();
  slides.set(id, map);
  map.set(F.parent, snap.parent);
  map.set(F.order, snap.order);
  map.set(F.hidden, snap.hidden);
  if (snap.html !== undefined) map.set(F.html, snap.html);
  const notes = new Y.Text();
  map.set(F.notes, notes);
  if (snap.notes) notes.insert(0, snap.notes);
  if (snap.hasNotes) map.set(F.hasNotes, true);
  const attrs = new Y.Map<unknown>();
  map.set(F.attrs, attrs);
  writeAttrs(map, attrs, snap.attrs);
  if (snap.keyOrder !== undefined) map.set(F.keyOrder, snap.keyOrder);
}

export interface LockGuardOptions {
  /**
   * The Yjs clientIDs that wrote a transaction, or null for the server's own
   * writes (agents, merges, repairs), which are checked elsewhere.
   */
  writersOf(transaction: Y.Transaction): ReadonlySet<number> | null;
  /** Origin of the guard's own corrections. */
  origin: unknown;
  /** Called with the slide ids whose change was undone. */
  onRevert?(slideIds: string[], writers: ReadonlySet<number>): void;
}

/** The slide id a changed type belongs to (a slide map or something inside one). */
function slideIdOf(type: Y.AbstractType<unknown>, slides: Y.Map<unknown>): string | null {
  let current: Y.AbstractType<unknown> | null = type;
  while (current && current._item) {
    const parent = current._item.parent as Y.AbstractType<unknown> | null;
    if (parent === slides) return current._item.parentSub;
    current = parent;
  }
  return null;
}

export function installLockGuard(doc: Y.Doc, opts: LockGuardOptions): () => void {
  const slides = deckSlides(doc);
  const locks = deckLocks(doc);
  const snapshots = new Map<string, SlideSnapshot>();
  let lockBefore = new Map<string, StampedLock>();

  const readLocks = () => {
    const out = new Map<string, StampedLock>();
    locks.forEach((value, key) => {
      if (isSlideLock(value)) out.set(key, value as StampedLock);
    });
    return out;
  };
  const refreshAll = () => {
    snapshots.clear();
    slides.forEach((map, id) => {
      if (map instanceof Y.Map) snapshots.set(id, snapshotOf(map));
    });
  };
  refreshAll();
  lockBefore = readLocks();

  const handler = (transaction: Y.Transaction): void => {
    // Slides this transaction touched.
    const touched = new Set<string>();
    for (const [type, keys] of transaction.changed) {
      if (type === (slides as unknown)) {
        for (const key of keys) if (key) touched.add(key);
        continue;
      }
      const id = slideIdOf(type as Y.AbstractType<unknown>, slides as Y.Map<unknown>);
      if (id) touched.add(id);
    }

    const writers = transaction.origin === opts.origin ? null : opts.writersOf(transaction);
    let lockKeys: Set<string | null> | undefined;
    for (const [type, keys] of transaction.changed) {
      if (type === (locks as unknown)) lockKeys = keys;
    }
    if (writers && writers.size > 0 && (touched.size > 0 || lockKeys)) {
      const reverts: Array<() => void> = [];
      const reverted: string[] = [];
      // Someone else's confirmed lock deleted by this writer: put it back.
      for (const key of lockKeys ?? []) {
        if (!key || locks.has(key)) continue;
        const lock = lockBefore.get(key);
        if (!lock || typeof lock.confirmed !== 'number' || writers.has(lock.clientId)) continue;
        reverts.push(() => locks.set(key, lock));
      }
      for (const id of touched) {
        const lock = lockBefore.get(id);
        if (!lock || typeof lock.confirmed !== 'number' || writers.has(lock.clientId)) continue;
        const snap = snapshots.get(id);
        if (!snap) continue;
        const map = slides.get(id);
        if (!(map instanceof Y.Map)) {
          reverts.push(() => recreate(slides, id, snap));
          reverted.push(id);
          continue;
        }
        let changed = false;
        if (readSlideHtml(map) !== snap.html) {
          reverts.push(() => {
            if (snap.html === undefined) map.delete(F.html);
            else map.set(F.html, snap.html);
          });
          changed = true;
        }
        const parent = map.get(F.parent);
        if ((typeof parent === 'string' ? parent : null) !== snap.parent) {
          reverts.push(() => {
            map.set(F.parent, snap.parent);
            map.set(F.order, snap.order);
          });
          changed = true;
        }
        if (changed) reverted.push(id);
      }
      if (reverts.length > 0) {
        doc.transact(() => {
          for (const revert of reverts) revert();
        }, opts.origin);
        opts.onRevert?.(reverted, writers);
      }
    }

    for (const id of touched) {
      const map = slides.get(id);
      if (map instanceof Y.Map) snapshots.set(id, snapshotOf(map));
      else snapshots.delete(id);
    }
    lockBefore = readLocks();
  };
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}
