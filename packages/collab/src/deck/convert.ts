/**
 * Deck JSON ⇄ deck Y.Doc.
 *
 * `deckToYDoc` / `syncDeckIntoYDoc` write; `yDocToDeck` reads. Writes are
 * id-aware and minimal: a slide whose fields did not change is not touched,
 * order keys are only re-minted for slides that actually moved, and notes
 * change by a single character-level splice. That makes the same function safe
 * for seeding, for server-side op application, for external-push merges and
 * for preview accepts while people are typing elsewhere in the deck.
 *
 * Read from a CLONE on the server (spec): `yDocToDeck` itself never writes.
 */
import * as Y from 'yjs';
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';

import { compareKeys, keysBetween } from '../fractionalIndex.ts';
import {
  CANONICAL_DECK_KEYS,
  CANONICAL_SLIDE_KEYS,
  DECK_LOCKS,
  DECK_META,
  DECK_SLIDES,
  F,
  META_FIELDS,
} from './shape.ts';
import { stripEditorBlockState } from './render.ts';
import { setYText } from './text.ts';

// ─── Accessors ────────────────────────────────────────────────────────────────

export function deckMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(DECK_META);
}

export function deckSlides(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(DECK_SLIDES);
}

export function deckLocks<T = unknown>(doc: Y.Doc): Y.Map<T> {
  return doc.getMap(DECK_LOCKS);
}

/** One slide as stored, with the parent it EFFECTIVELY has (see `deckSlideList`). */
export interface DeckSlideEntry {
  id: string;
  map: Y.Map<unknown>;
  order: string;
  /** Effective parent: null for top level (orphans and nested stacks are promoted). */
  parent: string | null;
  /** True for a vertical-stack container (no `html` key). */
  container: boolean;
}

function strArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : null;
}

function isContainerMap(map: Y.Map<unknown>): boolean {
  return !map.has(F.html);
}

function orderOf(map: Y.Map<unknown>): string {
  const order = map.get(F.order);
  return typeof order === 'string' ? order : '';
}

const byOrderThenId = (a: DeckSlideEntry, b: DeckSlideEntry): number =>
  compareKeys(a.order, b.order) || compareKeys(a.id, b.id);

/**
 * Every slide in deck order (each top-level slide followed by its children),
 * with the parent each one effectively has.
 *
 * Concurrent structural edits can leave shapes Reveal cannot show: a slide
 * moved into a stack that someone else deleted, a stack moved into a stack, a
 * child whose container became a regular slide. These are resolved the same
 * way on every peer — the slide is promoted to the top level, keeping its
 * order key — so nothing is ever lost and everyone sees one deck. Ties between
 * equal order keys (two peers inserting at the same spot) break by id.
 */
export function deckSlideList(doc: Y.Doc): DeckSlideEntry[] {
  const slides = deckSlides(doc);
  const raw = new Map<string, Y.Map<unknown>>();
  slides.forEach((map, id) => {
    if (map instanceof Y.Map) raw.set(id, map);
  });

  const rootParentOf = (id: string, map: Y.Map<unknown>): string | null => {
    if (isContainerMap(map)) return null; // stacks only live at the top level
    const parent = map.get(F.parent);
    if (typeof parent !== 'string' || parent === id) return null;
    const parentMap = raw.get(parent);
    if (!parentMap || !isContainerMap(parentMap)) return null;
    return parent;
  };

  const roots: DeckSlideEntry[] = [];
  const children = new Map<string, DeckSlideEntry[]>();
  for (const [id, map] of raw) {
    const entry: DeckSlideEntry = {
      id,
      map,
      order: orderOf(map),
      parent: rootParentOf(id, map),
      container: isContainerMap(map),
    };
    if (entry.parent == null) roots.push(entry);
    else {
      const list = children.get(entry.parent) ?? [];
      list.push(entry);
      children.set(entry.parent, list);
    }
  }
  roots.sort(byOrderThenId);
  const out: DeckSlideEntry[] = [];
  for (const root of roots) {
    out.push(root);
    const kids = children.get(root.id);
    if (kids) out.push(...kids.sort(byOrderThenId));
  }
  return out;
}

/** The ordered child entries of each scope (null = top level). */
export function deckScopes(entries: DeckSlideEntry[]): Map<string | null, DeckSlideEntry[]> {
  const scopes = new Map<string | null, DeckSlideEntry[]>();
  for (const entry of entries) {
    const list = scopes.get(entry.parent) ?? [];
    list.push(entry);
    scopes.set(entry.parent, list);
  }
  return scopes;
}

/** A slide's attributes in their stored order (hint first, then by name). */
export function readSlideAttrs(map: Y.Map<unknown>): Record<string, string> {
  const attrs = map.get(F.attrs);
  if (!(attrs instanceof Y.Map) || attrs.size === 0) return {};
  const present = new Map<string, string>();
  attrs.forEach((value, key) => {
    if (typeof value === 'string') present.set(key, value);
  });
  const out: Record<string, string> = {};
  for (const key of strArray(map.get(F.attrOrder)) ?? []) {
    if (present.has(key) && !(key in out)) out[key] = present.get(key) as string;
  }
  for (const key of [...present.keys()].sort()) {
    if (!(key in out)) out[key] = present.get(key) as string;
  }
  return out;
}

/** A slide's notes, or undefined when it has none (empty but present → ''). */
export function readSlideNotes(map: Y.Map<unknown>): string | undefined {
  const notes = map.get(F.notes);
  const text = notes instanceof Y.Text ? notes.toString() : '';
  if (text.length > 0) return text;
  return map.get(F.hasNotes) === true ? '' : undefined;
}

export function readSlideHtml(map: Y.Map<unknown>): string | undefined {
  const html = map.get(F.html);
  return typeof html === 'string' ? html : undefined;
}

// ─── Y.Doc → Deck ─────────────────────────────────────────────────────────────

function orderedKeys(present: Set<string>, hint: string[] | null, canonical: readonly string[]) {
  const out: string[] = [];
  for (const key of hint ?? []) if (present.has(key) && !out.includes(key)) out.push(key);
  for (const key of canonical) if (present.has(key) && !out.includes(key)) out.push(key);
  return out;
}

function slideToJson(entry: DeckSlideEntry, kids: DeckSlideEntry[] | undefined): DeckSlide {
  const { map } = entry;
  const values: Record<string, unknown> = { id: entry.id };
  if (entry.container) {
    values.children = (kids ?? []).map(kid => slideToJson(kid, undefined));
  } else {
    // Editor state that slipped into a slide (an open block editor) is never content.
    values.html = stripEditorBlockState(readSlideHtml(map) ?? '');
  }
  const notes = readSlideNotes(map);
  if (notes !== undefined) values.notes = notes;
  if (map.get(F.hidden) === true) values.hidden = true;
  const attrs = readSlideAttrs(map);
  if (Object.keys(attrs).length > 0) values.attrs = attrs;

  const keys = orderedKeys(
    new Set(Object.keys(values)),
    strArray(map.get(F.keyOrder)),
    CANONICAL_SLIDE_KEYS
  );
  const slide: Record<string, unknown> = {};
  for (const key of keys) slide[key] = values[key];
  return slide as unknown as DeckSlide;
}

/** The deck the document holds, as deck.json would store it. Never writes. */
export function yDocToDeck(doc: Y.Doc): DeckJson {
  const meta = deckMeta(doc);
  const entries = deckSlideList(doc);
  const scopes = deckScopes(entries);
  const slides = (scopes.get(null) ?? []).map(root => slideToJson(root, scopes.get(root.id)));

  const values: Record<string, unknown> = { version: 1, slides };
  const theme = meta.get('theme');
  const codeTheme = meta.get('codeTheme');
  values.theme = typeof theme === 'string' ? theme : 'white';
  values.codeTheme = typeof codeTheme === 'string' ? codeTheme : 'github';
  for (const field of META_FIELDS) {
    if (field === 'theme' || field === 'codeTheme') continue;
    const value = meta.get(field);
    if (value !== undefined && value !== null) values[field] = structuredCloneJson(value);
  }

  const keys = orderedKeys(
    new Set(Object.keys(values)),
    strArray(meta.get(F.keyOrder)),
    CANONICAL_DECK_KEYS
  );
  const deck: Record<string, unknown> = {};
  for (const key of keys) deck[key] = values[key];
  return deck as unknown as DeckJson;
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─── Deck → Y.Doc ─────────────────────────────────────────────────────────────

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function setIfChanged(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  if (!map.has(key) || !jsonEq(map.get(key), value)) map.set(key, value);
}

interface TargetSlide {
  slide: DeckSlide;
  parent: string | null;
  container: boolean;
}

function flattenTarget(deck: DeckJson): {
  byId: Map<string, TargetSlide>;
  scopes: Map<string | null, string[]>;
} {
  const byId = new Map<string, TargetSlide>();
  const scopes = new Map<string | null, string[]>([[null, []]]);
  const add = (slide: DeckSlide, parent: string | null): void => {
    if (!slide || typeof slide.id !== 'string' || !slide.id) {
      throw new Error('deck slide without an id');
    }
    if (byId.has(slide.id)) throw new Error(`duplicate slide id '${slide.id}' in deck`);
    const container = slide.children !== undefined || slide.html === undefined;
    if (container && parent !== null) {
      throw new Error(`slide '${slide.id}' is a stack inside a stack (one level only)`);
    }
    byId.set(slide.id, { slide, parent, container });
    (scopes.get(parent) as string[]).push(slide.id);
    if (container) {
      scopes.set(slide.id, []);
      for (const child of slide.children ?? []) add(child, slide.id);
    }
  };
  for (const slide of deck.slides ?? []) add(slide, null);
  return { byId, scopes };
}

/**
 * Longest strictly increasing subsequence of `keys` (by index), as a set of
 * positions. Items in it keep their order keys; everything else is re-keyed.
 */
function lisPositions(keys: Array<string | null>): Set<number> {
  const tails: number[] = []; // positions
  const prev = new Array<number>(keys.length).fill(-1);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key == null) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareKeys(keys[tails[mid]] as string, key) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (at !== -1) {
    out.add(at);
    at = prev[at];
  }
  return out;
}

/**
 * Order keys for one scope: slides already in this scope keep their keys
 * where the order allows (longest increasing run), the rest get keys between
 * their kept neighbours.
 */
export function planScopeOrder(
  targetIds: string[],
  current: (id: string) => string | null
): Map<string, string> {
  const keys = targetIds.map(current);
  const kept = lisPositions(keys);
  const out = new Map<string, string>();
  let i = 0;
  let lower: string | null = null;
  while (i < targetIds.length) {
    if (kept.has(i)) {
      lower = keys[i] as string;
      out.set(targetIds[i], lower);
      i++;
      continue;
    }
    let j = i;
    while (j < targetIds.length && !kept.has(j)) j++;
    const upper = j < targetIds.length ? (keys[j] as string) : null;
    const minted = keysBetween(lower, upper, j - i);
    for (let k = i; k < j; k++) out.set(targetIds[k], minted[k - i]);
    i = j;
  }
  return out;
}

function writeSlideFields(map: Y.Map<unknown>, target: TargetSlide): void {
  const { slide, container, parent } = target;
  setIfChanged(map, F.parent, parent);
  setIfChanged(map, F.hidden, slide.hidden === true);

  if (container) {
    if (map.has(F.html)) map.delete(F.html);
  } else {
    const html = slide.html ?? '';
    if (map.get(F.html) !== html) map.set(F.html, html);
  }

  let notes = map.get(F.notes);
  if (!(notes instanceof Y.Text)) {
    notes = new Y.Text();
    map.set(F.notes, notes);
  }
  setYText(notes as Y.Text, slide.notes ?? '');
  setIfChanged(map, F.hasNotes, slide.notes !== undefined ? true : undefined);

  let attrs = map.get(F.attrs);
  if (!(attrs instanceof Y.Map)) {
    attrs = new Y.Map<string>();
    map.set(F.attrs, attrs);
  }
  writeAttrs(map, attrs as Y.Map<unknown>, slide.attrs ?? {});

  setIfChanged(map, F.keyOrder, Object.keys(slide));
}

/** Replace a slide's attributes per key (concurrent edits of other keys survive). */
export function writeAttrs(
  slideMap: Y.Map<unknown>,
  attrs: Y.Map<unknown>,
  next: Record<string, string>
): void {
  for (const key of [...attrs.keys()]) {
    if (!(key in next)) attrs.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (attrs.get(key) !== value) attrs.set(key, value);
  }
  const order = Object.keys(next);
  setIfChanged(slideMap, F.attrOrder, order.length > 0 ? order : undefined);
}

export interface SyncDeckOptions {
  /** Transaction origin (lets observers tell server writes from peers). */
  origin?: unknown;
  /** Also drop locks of slides that no longer exist (default true). */
  dropLocksOfDeleted?: boolean;
}

/**
 * Make the document hold `deck`, touching only what differs. Slides missing
 * from `deck` are deleted, new ids are created, moved slides get new order
 * keys, everything else keeps its Yjs identity.
 *
 * @throws when `deck` has duplicate ids or a stack inside a stack.
 */
export function syncDeckIntoYDoc(doc: Y.Doc, deck: DeckJson, opts: SyncDeckOptions = {}): void {
  const { byId, scopes } = flattenTarget(deck);
  const meta = deckMeta(doc);
  const slides = deckSlides(doc);
  const locks = deckLocks(doc);

  // Order plan from the PRE-sync state (parents and keys as they are now).
  const before = new Map(deckSlideList(doc).map(entry => [entry.id, entry]));
  const orderPlan = new Map<string, string>();
  for (const [scope, ids] of scopes) {
    const plan = planScopeOrder(ids, id => {
      const entry = before.get(id);
      return entry && entry.parent === scope && entry.order ? entry.order : null;
    });
    for (const [id, key] of plan) orderPlan.set(id, key);
  }

  doc.transact(() => {
    for (const field of META_FIELDS) {
      const value = (deck as unknown as Record<string, unknown>)[field];
      setIfChanged(meta, field, value === undefined ? undefined : structuredCloneJson(value));
    }
    setIfChanged(meta, F.keyOrder, Object.keys(deck));

    for (const id of [...slides.keys()]) {
      if (!byId.has(id)) {
        slides.delete(id);
        if (opts.dropLocksOfDeleted !== false && locks.has(id)) locks.delete(id);
      }
    }

    for (const [id, target] of byId) {
      let map = slides.get(id);
      if (!(map instanceof Y.Map)) {
        map = new Y.Map<unknown>();
        slides.set(id, map);
      }
      writeSlideFields(map, target);
      setIfChanged(map, F.order, orderPlan.get(id));
    }
  }, opts.origin ?? null);
}

/** A new document holding `deck` (or seed `doc`, which should be empty). */
export function deckToYDoc(deck: DeckJson, doc: Y.Doc = new Y.Doc(), opts: SyncDeckOptions = {}) {
  syncDeckIntoYDoc(doc, deck, opts);
  return doc;
}

/** A detached copy of a document (server reads always go through one). */
export function cloneYDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}
