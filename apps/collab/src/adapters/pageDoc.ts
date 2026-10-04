/**
 * Server-side reads and writes of a live page Y.Doc. Pure Yjs: no I/O.
 *
 * Layout BlockNote 0.55 gives the FRAGMENT (checked against the kitchen-sink
 * fixture):
 *
 *   fragment
 *     blockGroup
 *       blockContainer[id]          one per ordinary block
 *         <blockContent>            paragraph | heading | callout | …
 *         blockGroup?               its children (blockContainer[id] …)
 *       columnList[id]              sits directly in a blockGroup
 *         column[id, width]
 *           blockContainer[id] …
 *
 * Writes are ID-AWARE: `reconcileBlocks` walks the live tree and the target
 * blocks side by side by id, updates only what differs (y-prosemirror's
 * `updateYFragment` on one block's content, which diffs text instead of
 * replacing it), inserts new elements and deletes by index. A block whose
 * content nobody touched is never written, so a concurrent edit there
 * survives; a concurrent edit in an updated block merges as CRDT text edits.
 */
import * as Y from 'yjs';
import { blockToNode } from '@blocknote/core';
import { updateYFragment } from 'y-prosemirror';
import { COVER_IMAGE_KEY, FRAGMENT, META_MAP, type PageCoverImage } from '@classmoji/page-schema';
import {
  blocksToYDoc,
  getServerEditor,
  pageContentToYDoc,
  yDocToBlocks,
} from '@classmoji/page-schema/server';

import { CollabHttpError } from './types.ts';

export interface PageBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: PageBlock[];
  [key: string]: unknown;
}

type PmSchema = Parameters<typeof blockToNode>[1];
type PmNode = ReturnType<typeof blockToNode>;

function pmSchema(): PmSchema {
  return (getServerEditor().editor as unknown as { pmSchema: PmSchema }).pmSchema;
}

function freshMeta() {
  return { mapping: new Map(), isOMark: new Map() };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter(k => ao[k] !== undefined);
  const bk = Object.keys(bo).filter(k => bo[k] !== undefined);
  return ak.length === bk.length && ak.every(k => deepEqual(ao[k], bo[k]));
}

/** The Y element name a block lives in. */
function elementNameFor(block: PageBlock): string {
  return block.type === 'columnList' || block.type === 'column' ? block.type : 'blockContainer';
}

function idOf(node: unknown): string | null {
  if (!(node instanceof Y.XmlElement)) return null;
  const id = node.getAttribute('id');
  return typeof id === 'string' && id ? id : null;
}

/** The fragment's top-level blockGroup (created on an empty fragment). */
export function topBlockGroup(doc: Y.Doc): Y.XmlElement {
  const fragment = doc.getXmlFragment(FRAGMENT);
  const first = fragment.length > 0 ? fragment.get(0) : null;
  if (first instanceof Y.XmlElement && first.nodeName === 'blockGroup') return first;
  if (fragment.length === 0) {
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
    return group;
  }
  throw new Error(
    `page fragment starts with ${String((first as Y.XmlElement)?.nodeName)}, not blockGroup`
  );
}

function insertFresh(
  doc: Y.Doc,
  list: Y.XmlElement,
  index: number,
  block: PageBlock,
  schema: PmSchema
) {
  const node = blockToNode(block as never, schema);
  const element = new Y.XmlElement(node.type.name);
  list.insert(index, [element]);
  updateYFragment(doc, element, node, freshMeta());
}

/** Longest increasing subsequence; returns the indexes (into `seq`) kept. */
function lisIndexes(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

/**
 * Make the children of `list` (a blockGroup, columnList or column element)
 * match `next`, given that they currently hold `current`. By id: elements
 * whose id is gone are deleted; the longest run already in the right order
 * stays put; the rest are re-created at their new position (a move); kept
 * elements are reconciled in place.
 */
function reconcileList(
  doc: Y.Doc,
  list: Y.XmlElement,
  current: PageBlock[],
  next: PageBlock[],
  schema: PmSchema
): void {
  const currentById = new Map<string, PageBlock>();
  for (const block of current) if (block?.id) currentById.set(block.id, block);
  const nextIndex = new Map<string, number>();
  next.forEach((block, index) => {
    if (block?.id) nextIndex.set(block.id, index);
  });

  // 1. Drop elements that are not in the target (or carry no / a repeated id).
  const seen = new Set<string>();
  const survivors: { index: number; id: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const id = idOf(list.get(i));
    if (id && nextIndex.has(id) && !seen.has(id)) {
      seen.add(id);
      survivors.push({ index: i, id });
    }
  }
  const keepOrder = lisIndexes(survivors.map(s => nextIndex.get(s.id)!));
  const keepPositions = new Set(survivors.filter((_, i) => keepOrder.has(i)).map(s => s.index));
  for (let i = list.length - 1; i >= 0; i--) {
    if (!keepPositions.has(i)) list.delete(i, 1);
  }

  // 2. Walk the target: reconcile what stayed, create what is missing.
  for (let i = 0; i < next.length; i++) {
    const target = next[i];
    const existing = i < list.length ? list.get(i) : null;
    if (existing instanceof Y.XmlElement && idOf(existing) === target.id) {
      reconcileItem(doc, list, i, existing, currentById.get(target.id!), target, schema);
    } else {
      insertFresh(doc, list, i, target, schema);
    }
  }
  if (list.length > next.length) list.delete(next.length, list.length - next.length);
}

function ownPart(block: PageBlock | undefined) {
  if (!block) return undefined;
  const { children: _children, ...own } = block;
  return own;
}

function reconcileItem(
  doc: Y.Doc,
  list: Y.XmlElement,
  index: number,
  element: Y.XmlElement,
  current: PageBlock | undefined,
  target: PageBlock,
  schema: PmSchema
): void {
  if (current && deepEqual(current, target)) return;

  const name = elementNameFor(target);
  if (!current || element.nodeName !== name) {
    list.delete(index, 1);
    insertFresh(doc, list, index, target, schema);
    return;
  }

  if (name === 'columnList' || name === 'column') {
    if (!deepEqual(ownPart(current), ownPart(target))) {
      // Only attributes (id, and props such as a column's width) live on
      // these elements — the same mapping BlockNote uses (props → attrs).
      const attrs: Record<string, unknown> = { ...(target.props ?? {}), id: target.id };
      for (const key of Object.keys(element.getAttributes())) {
        if (!(key in attrs)) element.removeAttribute(key);
      }
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) element.removeAttribute(key);
        else if (element.getAttribute(key) !== value) element.setAttribute(key, value as string);
      }
    }
    reconcileList(doc, element, current.children ?? [], target.children ?? [], schema);
    return;
  }

  // blockContainer: [blockContent, blockGroup?]
  if (!deepEqual(ownPart(current), ownPart(target))) {
    const node: PmNode = blockToNode({ ...target, children: [] } as never, schema);
    const contentNode = node.child(0);
    const yContent = element.length > 0 ? element.get(0) : null;
    if (yContent instanceof Y.XmlElement && yContent.nodeName === contentNode.type.name) {
      updateYFragment(doc, yContent, contentNode, freshMeta());
    } else {
      if (yContent) element.delete(0, 1);
      const fresh = new Y.XmlElement(contentNode.type.name);
      element.insert(0, [fresh]);
      updateYFragment(doc, fresh, contentNode, freshMeta());
    }
  }

  const currentKids = current.children ?? [];
  const targetKids = target.children ?? [];
  if (deepEqual(currentKids, targetKids)) return;
  const group = element.length > 1 ? element.get(1) : null;
  if (targetKids.length === 0) {
    if (element.length > 1) element.delete(1, element.length - 1);
    return;
  }
  if (group instanceof Y.XmlElement && group.nodeName === 'blockGroup') {
    reconcileList(doc, group, currentKids, targetKids, schema);
  } else {
    if (element.length > 1) element.delete(1, element.length - 1);
    const fresh = new Y.XmlElement('blockGroup');
    element.insert(1, [fresh]);
    reconcileList(doc, fresh, [], targetKids, schema);
  }
}

/**
 * Bring the live doc's blocks from `current` (what `yDocToBlocks` read from
 * it, in this same transaction) to `next`, id-aware. Call inside a
 * transaction; every block in `next` must have an id (`ensureBlockIds`).
 */
export function reconcileBlocks(doc: Y.Doc, current: PageBlock[], next: PageBlock[]): void {
  const schema = pmSchema();
  doc.transact(() => {
    reconcileList(doc, topBlockGroup(doc), current, next, schema);
  });
}

// ─── Cover ─────────────────────────────────────────────────────────────────

export function readCover(doc: Y.Doc): PageCoverImage | null {
  return (doc.getMap(META_MAP).get(COVER_IMAGE_KEY) as PageCoverImage | undefined) ?? null;
}

export function writeCover(doc: Y.Doc, cover: PageCoverImage | null): void {
  const meta = doc.getMap(META_MAP);
  if (cover == null) {
    if (meta.has(COVER_IMAGE_KEY)) meta.delete(COVER_IMAGE_KEY);
  } else if (!deepEqual(meta.get(COVER_IMAGE_KEY), cover)) {
    meta.set(COVER_IMAGE_KEY, { url: cover.url, position: cover.position });
  }
}

// ─── Column repair ─────────────────────────────────────────────────────────

/** Every columnList element with fewer than two column children. */
export function brokenColumnLists(doc: Y.Doc): Y.XmlElement[] {
  const found: Y.XmlElement[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      walk(child); // deepest first
      if (child.nodeName === 'columnList') {
        const columns = child
          .toArray()
          .filter(c => c instanceof Y.XmlElement && c.nodeName === 'column');
        if (columns.length < 2) found.push(child);
      }
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return found;
}

/**
 * Unwrap every columnList left with fewer than two columns (two people
 * deleting different columns at once can do that): its columns' blocks take
 * its place, in order, and the list is deleted — what the editor itself does
 * when you delete the second-to-last column. Walks the raw Y tree: on a doc
 * this broken, converting to blocks is the thing that fails. Returns true if
 * anything changed. Call inside a transaction.
 */
export function unwrapBrokenColumnLists(doc: Y.Doc): boolean {
  let changed = false;
  // Deepest first, so an outer list sees its inner lists already repaired.
  for (const list of brokenColumnLists(doc)) {
    const parent = list.parent as Y.XmlElement | Y.XmlFragment | null;
    if (!parent) continue;
    const index = parent.toArray().indexOf(list);
    if (index < 0) continue;
    const lifted: Y.XmlElement[] = [];
    for (const column of list.toArray()) {
      if (!(column instanceof Y.XmlElement)) continue;
      if (column.nodeName === 'column') {
        for (const block of column.toArray()) {
          if (block instanceof Y.XmlElement) lifted.push(block.clone());
        }
      } else {
        lifted.push(column.clone());
      }
    }
    if (lifted.length > 0) parent.insert(index + 1, lifted);
    parent.delete(index, 1);
    // A blockGroup may not be empty: keep one blank paragraph.
    if (parent.length === 0 && parent instanceof Y.XmlElement && parent.nodeName === 'blockGroup') {
      insertFresh(doc, parent, 0, blankParagraph(), pmSchema());
    }
    changed = true;
  }
  return changed;
}

// ─── Guards before a server write ──────────────────────────────────────────

/** A blank paragraph with a fresh id (a page always keeps at least one block). */
export function blankParagraph(): PageBlock {
  return {
    id: `b${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    type: 'paragraph',
    props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
    content: [],
    children: [],
  };
}

/** `blocks`, or one blank paragraph when it is empty. */
export function nonEmpty(blocks: PageBlock[]): PageBlock[] {
  return blocks.length > 0 ? blocks : [blankParagraph()];
}

/** Every block id in a block tree. */
export function blockIds(blocks: PageBlock[], out = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (block?.id) out.add(block.id);
    if (Array.isArray(block?.children)) blockIds(block.children, out);
  }
  return out;
}

/** Every block id in the raw live Y tree (blockContainer / columnList / column). */
export function liveBlockIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const id = idOf(child);
      if (
        id &&
        (child.nodeName === 'blockContainer' ||
          child.nodeName === 'columnList' ||
          child.nodeName === 'column')
      ) {
        ids.add(id);
      }
      walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return ids;
}

/**
 * Refuse to write when the clone read dropped something the live doc holds
 * (an element the schema rejects): reconciling against that read would
 * delete it for everyone. 409 `unreadable-live-doc`, nothing written.
 */
export function assertReadable(doc: Y.Doc, current: PageBlock[]): void {
  const read = blockIds(current);
  const missing = [...liveBlockIds(doc)].filter(id => !read.has(id));
  if (missing.length > 0) {
    throw new CollabHttpError(409, {
      error: 'unreadable-live-doc',
      message: 'The live page holds blocks the server cannot read; nothing was changed',
      ids: missing.slice(0, 20),
    });
  }
}

/**
 * Prove `blocks` convert under the page schema BEFORE any live write (a
 * conversion failing half-way through a reconcile would leave a partial
 * write). 422 `invalid-block`.
 */
export function assertConvertible(blocks: PageBlock[], what = 'blocks'): void {
  try {
    blocksToYDoc(blocks).destroy();
  } catch (err) {
    throw new CollabHttpError(422, {
      error: 'invalid-block',
      message: `${what} do not fit the page schema: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Content from outside the live doc (a merge base, an outside push, a
 * preview) in the exact shape the live doc reads back as: through the schema
 * (defaults filled, the same normalisation), so a 3-way merge sees no
 * phantom differences. 422 `invalid-block` when it does not convert.
 */
export function throughSchema(
  blocks: unknown[],
  normalize: (blocks: unknown[]) => unknown[],
  what: string
): PageBlock[] {
  const prepared = normalize(blocks) as PageBlock[];
  try {
    const doc = pageContentToYDoc({ blocks: prepared });
    const out = yDocToBlocks(doc) as PageBlock[];
    doc.destroy();
    return out;
  } catch (err) {
    throw new CollabHttpError(422, {
      error: 'invalid-block',
      message: `${what} do not fit the page schema: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
