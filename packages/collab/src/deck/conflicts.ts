/**
 * Notices for slides whose html was kept against an outside push: the deck
 * doc's `conflicts` map, keyed by slide id. Not part of the deck (yDocToDeck
 * never reads it) — it tells the person who was editing that GitHub had a
 * different version, which they can look at and dismiss.
 */
import type * as Y from 'yjs';

export const DECK_CONFLICTS = 'conflicts';

export interface SlideConflictNotice {
  /** ms since epoch. */
  at: number;
  /** The pushed commit. */
  sha: string;
  /** The slide's html in that commit. */
  html: string;
  /** The person whose version was kept. */
  holderUserId: string;
}

function isNotice(value: unknown): value is SlideConflictNotice {
  const v = value as SlideConflictNotice | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.at === 'number' &&
    typeof v.sha === 'string' &&
    typeof v.html === 'string' &&
    typeof v.holderUserId === 'string'
  );
}

export function deckConflicts(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(DECK_CONFLICTS);
}

/** Record a notice (call inside the merge's transaction). */
export function recordSlideConflict(doc: Y.Doc, slideId: string, notice: SlideConflictNotice) {
  deckConflicts(doc).set(slideId, notice);
}

export function readSlideConflicts(doc: Y.Doc): Map<string, SlideConflictNotice> {
  const out = new Map<string, SlideConflictNotice>();
  deckConflicts(doc).forEach((value, key) => {
    if (isNotice(value)) out.set(key, value);
  });
  return out;
}

export function dismissSlideConflict(doc: Y.Doc, slideId: string, origin: unknown = null) {
  const map = deckConflicts(doc);
  if (map.has(slideId)) doc.transact(() => map.delete(slideId), origin);
}
