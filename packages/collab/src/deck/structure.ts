/**
 * Structural edits on a deck Y.Doc — add, move, delete, hide, stack — that
 * never touch another slide's content and never need a slide lock.
 *
 * Two layers:
 *  - Direct helpers (`insertSlide`, `moveSlide`, `deleteSlide`, `setSlideHidden`)
 *    that place a slide relative to a sibling with a fresh fractional key.
 *  - The editor bridge's pair: `planLocalStructure` (pure: what changed between
 *    the last synced structure and the editor DOM) and `applyLocalStructure`
 *    (writes that plan into the doc, id by id, so concurrent remote moves of
 *    OTHER slides survive).
 */
import * as Y from 'yjs';

import { compareKeys, keyBetween } from '../fractionalIndex.ts';
import {
  deckLocks,
  deckSlideList,
  deckSlides,
  writeAttrs,
  type DeckSlideEntry,
} from './convert.ts';
import { F } from './shape.ts';

/** Ordered ids per scope (null = top level) plus which ids are stack containers. */
export interface DeckStructure {
  scopes: Map<string | null, string[]>;
  containers: Set<string>;
}

export function emptyStructure(): DeckStructure {
  return { scopes: new Map([[null, []]]), containers: new Set() };
}

/** The structure the document holds. */
export function structureOfDoc(doc: Y.Doc): DeckStructure {
  return structureOfEntries(deckSlideList(doc));
}

export function structureOfEntries(entries: DeckSlideEntry[]): DeckStructure {
  const out = emptyStructure();
  for (const entry of entries) {
    const list = out.scopes.get(entry.parent) ?? [];
    list.push(entry.id);
    out.scopes.set(entry.parent, list);
    if (entry.container) {
      out.containers.add(entry.id);
      if (!out.scopes.has(entry.id)) out.scopes.set(entry.id, []);
    }
  }
  return out;
}

/** Every id in deck order (each top-level id followed by its children). */
export function structureOrder(structure: DeckStructure): string[] {
  const out: string[] = [];
  for (const id of structure.scopes.get(null) ?? []) {
    out.push(id);
    for (const child of structure.scopes.get(id) ?? []) out.push(child);
  }
  return out;
}

/** parent of each id (null = top level). */
export function parentIndex(structure: DeckStructure): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [scope, ids] of structure.scopes) for (const id of ids) out.set(id, scope);
  return out;
}

export function structuresEqual(a: DeckStructure, b: DeckStructure): boolean {
  const orderA = structureOrder(a);
  const orderB = structureOrder(b);
  if (orderA.length !== orderB.length) return false;
  const parentsA = parentIndex(a);
  const parentsB = parentIndex(b);
  for (let i = 0; i < orderA.length; i++) {
    if (orderA[i] !== orderB[i]) return false;
    if (parentsA.get(orderA[i]) !== parentsB.get(orderB[i])) return false;
    // A stack with no children looks like an empty slide in the editor: only
    // a stack that has children must be one on both sides.
    if (a.containers.has(orderA[i]) !== b.containers.has(orderB[i])) {
      const id = orderA[i];
      if ((a.scopes.get(id)?.length ?? 0) > 0 || (b.scopes.get(id)?.length ?? 0) > 0) return false;
    }
  }
  return true;
}

// ─── Placement ────────────────────────────────────────────────────────────────

/** Ordered sibling entries of a scope, excluding `exclude`. */
function siblings(doc: Y.Doc, parent: string | null, exclude?: string): DeckSlideEntry[] {
  return deckSlideList(doc).filter(entry => entry.parent === parent && entry.id !== exclude);
}

/**
 * An order key placing a slide in `parent` right after the first of `after`
 * that is a sibling there (null / none found = first in the scope).
 */
export function orderKeyAfter(
  doc: Y.Doc,
  parent: string | null,
  after: string | readonly string[] | null,
  exclude?: string
): string {
  const list = siblings(doc, parent, exclude);
  const candidates = after == null ? [] : typeof after === 'string' ? [after] : after;
  let index = -1;
  for (const candidate of candidates) {
    index = list.findIndex(entry => entry.id === candidate);
    if (index !== -1) break;
  }
  const lower = index >= 0 ? list[index].order || null : null;
  // Equal keys (two peers inserted at one spot) sort by id; the new key must be
  // strictly above `lower`, so skip any tied neighbours.
  let upperAt = index + 1;
  while (upperAt < list.length && lower != null && compareKeys(list[upperAt].order, lower) <= 0) {
    upperAt++;
  }
  const upper = upperAt < list.length ? list[upperAt].order || null : null;
  return keyBetween(lower, upper);
}

export interface NewSlideFields {
  /** Absent → a vertical-stack container. */
  html?: string;
  notes?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
}

/** Fill a fresh slide map (inside a transaction, after it is attached). */
function fillNewSlide(map: Y.Map<unknown>, fields: NewSlideFields): void {
  if (fields.html !== undefined) map.set(F.html, fields.html);
  map.set(F.hidden, fields.hidden === true);
  const notes = new Y.Text();
  map.set(F.notes, notes);
  if (fields.notes) notes.insert(0, fields.notes);
  if (fields.notes !== undefined) map.set(F.hasNotes, true);
  const attrs = new Y.Map<unknown>();
  map.set(F.attrs, attrs);
  writeAttrs(map, attrs, fields.attrs ?? {});
}

/** Insert a new slide after a sibling (or first). Returns its id. */
export function insertSlide(
  doc: Y.Doc,
  id: string,
  fields: NewSlideFields,
  place: { parent: string | null; after: string | readonly string[] | null },
  origin: unknown = null
): string {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    deckSlides(doc).set(id, map);
    map.set(F.parent, place.parent);
    map.set(F.order, orderKeyAfter(doc, place.parent, place.after, id));
    fillNewSlide(map, fields);
  }, origin);
  return id;
}

/** Move a slide (structure only) after a sibling in `parent` (or first). */
export function moveSlide(
  doc: Y.Doc,
  id: string,
  place: { parent: string | null; after: string | readonly string[] | null },
  origin: unknown = null
): boolean {
  const map = deckSlides(doc).get(id);
  if (!(map instanceof Y.Map)) return false;
  doc.transact(() => {
    if (map.get(F.parent) !== place.parent) map.set(F.parent, place.parent);
    map.set(F.order, orderKeyAfter(doc, place.parent, place.after, id));
  }, origin);
  return true;
}

/** Delete a slide (a container takes its children) and their locks. */
export function deleteSlide(doc: Y.Doc, id: string, origin: unknown = null): string[] {
  const slides = deckSlides(doc);
  if (!slides.has(id)) return [];
  const doomed = [
    id,
    ...deckSlideList(doc)
      .filter(e => e.parent === id)
      .map(e => e.id),
  ];
  const locks = deckLocks(doc);
  doc.transact(() => {
    for (const slideId of doomed) {
      slides.delete(slideId);
      if (locks.has(slideId)) locks.delete(slideId);
    }
  }, origin);
  return doomed;
}

export function setSlideHidden(doc: Y.Doc, id: string, hidden: boolean, origin: unknown = null) {
  const map = deckSlides(doc).get(id);
  if (!(map instanceof Y.Map) || map.get(F.hidden) === hidden) return false;
  doc.transact(() => map.set(F.hidden, hidden), origin);
  return true;
}

// ─── Editor bridge: local structure diff ──────────────────────────────────────

export interface PlacedSlide {
  id: string;
  parent: string | null;
  /** Preceding siblings in the editor, nearest first (the first that still exists wins). */
  after: string[];
  create: boolean;
  container: boolean;
}

export interface LocalStructurePlan {
  /** Ids gone from the editor (top-most: a deleted container takes its children). */
  deletes: string[];
  /** New and moved slides, in editor document order. */
  places: PlacedSlide[];
}

/** Positions (indices into `seq`) on a longest increasing run of `rank`. */
function stableRun(seq: string[], rank: Map<string, number>): Set<string> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const r = rank.get(seq[i]);
    if (r === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rank.get(seq[tails[mid]]) as number) < r) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<string>();
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (at !== -1) {
    out.add(seq[at]);
    at = prev[at];
  }
  return out;
}

/**
 * What the editor changed in the deck's structure since `baseline` (the
 * structure last synced): deletions, insertions, and moves — a slide counts as
 * moved when its parent changed or it fell out of the longest run of slides
 * that kept their relative order, so a drag of one slide moves one slide.
 */
export function planLocalStructure(
  baseline: DeckStructure,
  editor: DeckStructure
): LocalStructurePlan {
  const baseParents = parentIndex(baseline);
  const editorParents = parentIndex(editor);

  const deletes: string[] = [];
  for (const id of structureOrder(baseline)) {
    if (editorParents.has(id)) continue;
    const parent = baseParents.get(id);
    // A child whose container is also gone goes with it.
    if (parent != null && !editorParents.has(parent)) continue;
    deletes.push(id);
  }

  const places: PlacedSlide[] = [];
  const visit = (scope: string | null): void => {
    const seq = editor.scopes.get(scope) ?? [];
    const baseSeq = baseline.scopes.get(scope) ?? [];
    const rank = new Map<string, number>();
    baseSeq.forEach((id, i) => rank.set(id, i));
    const sameScope = seq.filter(id => baseParents.get(id) === scope);
    const stay = stableRun(sameScope, rank);
    const before: string[] = [];
    for (const id of seq) {
      const create = !baseParents.has(id);
      if (create || !stay.has(id)) {
        places.push({
          id,
          parent: scope,
          after: [...before].reverse(),
          create,
          container: editor.containers.has(id),
        });
      }
      before.push(id);
      if (scope === null && editor.containers.has(id)) visit(id);
    }
  };
  visit(null);
  return { deletes, places };
}

export interface ApplyLocalStructureOptions {
  origin?: unknown;
  /** Fields for a slide the editor created. */
  newSlide: (id: string, container: boolean) => NewSlideFields;
  /** Refuse a delete (e.g. someone else holds the slide). */
  canDelete?: (id: string) => boolean;
}

/**
 * Write a local structure plan into the doc. Places first, in editor order (so
 * each slide's predecessor is already where it belongs, and a child dragged
 * out of a stack has left it before the stack is deleted), then deletes.
 * Returns the deletes that were refused; the caller restores them in the view.
 */
export function applyLocalStructure(
  doc: Y.Doc,
  plan: LocalStructurePlan,
  opts: ApplyLocalStructureOptions
): { refused: string[] } {
  const refused: string[] = [];
  const slides = deckSlides(doc);
  doc.transact(() => {
    for (const place of plan.places) {
      if (place.create) {
        if (slides.has(place.id)) continue; // already there (replayed plan)
        insertSlide(doc, place.id, opts.newSlide(place.id, place.container), place);
      } else if (slides.has(place.id)) {
        moveSlide(doc, place.id, place);
      }
    }
    for (const id of plan.deletes) {
      const doomed = [
        id,
        ...deckSlideList(doc)
          .filter(e => e.parent === id)
          .map(e => e.id),
      ];
      if (opts.canDelete && doomed.some(slideId => !opts.canDelete?.(slideId))) {
        refused.push(id);
        continue;
      }
      deleteSlide(doc, id);
    }
  }, opts.origin ?? null);
  return { refused };
}

/**
 * Which ids of `current` to move so it becomes `target` with the fewest moves,
 * never moving `pinned` (the slide holding the caret) when it can stay.
 * Ids only in `target` are inserts; ids only in `current` are removals.
 */
export function planReorder(
  current: string[],
  target: string[],
  pinned?: string | null
): { move: Set<string> } {
  const rank = new Map<string, number>();
  target.forEach((id, i) => rank.set(id, i));
  const common = current.filter(id => rank.has(id));
  const stay = stableRun(common, rank);
  if (pinned && rank.has(pinned) && !stay.has(pinned) && common.includes(pinned)) {
    // Keep the pinned slide still: re-run with everything that conflicts with
    // it removed, so the others move around it.
    const pinRank = rank.get(pinned) as number;
    const pinAt = common.indexOf(pinned);
    const compatible = common.filter((id, i) => {
      if (id === pinned) return true;
      const r = rank.get(id) as number;
      return i < pinAt ? r < pinRank : r > pinRank;
    });
    const stayPinned = stableRun(compatible, rank);
    return { move: new Set(target.filter(id => !stayPinned.has(id))) };
  }
  return { move: new Set(target.filter(id => !stay.has(id))) };
}
