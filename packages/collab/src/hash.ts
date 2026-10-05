/**
 * `@classmoji/collab/hash` — NODE ONLY (node:crypto): the hash a guarded
 * `/ops` call sends in `expect` for each block (page) or slide (deck) it read
 * from `/snapshot`, and that the collab server recomputes inside the live
 * transaction; and the per-block VIEWS behind the `expect_since` check (an
 * agent's live pin judged on the collab server against what that agent was
 * shown). Not exported from the package root (browser bundles).
 */
import { createHash } from 'node:crypto';

/**
 * Stable JSON: object keys sorted at every level; `undefined` members are
 * dropped (and become `null` inside arrays), exactly as JSON.stringify does,
 * so `{ a: 1, b: undefined }` and `{ a: 1 }` hash alike.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return stableJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined || typeof v === 'function' ? 'null' : stableJson(v))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined && typeof record[key] !== 'function')
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** sha1 hex of the item's stable JSON. */
export function itemHash(item: unknown): string {
  return createHash('sha1').update(stableJson(item)).digest('hex');
}

// ─── Views: what an agent was shown, as hashes ──────────────────────────────

/**
 * A document as hashes, for judging a live pin (`expect_since`) on the collab
 * server: `items` = `itemHash` of every block (page, nested ones included;
 * a block's hash covers its children) or slide (deck: each top-level entry
 * as `/snapshot` returns it, a stack with its children, and each stack
 * child); `order` = the top-level ids in order; `meta` = the deck's theme
 * tuple (pages: none). Built from the `/snapshot` shape, so a view recorded
 * from what `/snapshot` returned and one computed from the live doc inside
 * the `/ops` transaction compare alike.
 */
export interface ItemView {
  items: Map<string, string>;
  order: string[];
  meta?: string;
}

interface IdNode {
  id?: unknown;
  children?: unknown;
}

const nodes = (value: unknown): IdNode[] =>
  Array.isArray(value) ? (value as IdNode[]).filter(n => n && typeof n === 'object') : [];

/** A page's view from its `/snapshot` content (`{ blocks, coverImage }`). */
export function pageView(content: { blocks?: unknown } | null | undefined): ItemView {
  const items = new Map<string, string>();
  const walk = (blocks: unknown) => {
    for (const block of nodes(blocks)) {
      if (typeof block.id === 'string') items.set(block.id, itemHash(block));
      walk(block.children);
    }
  };
  const top = nodes(content?.blocks);
  walk(top);
  return { items, order: top.flatMap(b => (typeof b.id === 'string' ? [b.id] : [])) };
}

/** The deck fields a `set_theme` op depends on. */
const DECK_META_KEYS = ['theme', 'codeTheme', 'themeDark', 'codeThemeDark'] as const;

/** A deck's view from its `/snapshot` content (the deck JSON). */
export function deckView(deck: Record<string, unknown> | null | undefined): ItemView {
  const items = new Map<string, string>();
  const top = nodes(deck?.slides);
  for (const slide of top) {
    if (typeof slide.id === 'string') items.set(slide.id, itemHash(slide));
    for (const child of nodes(slide.children)) {
      if (typeof child.id === 'string') items.set(child.id, itemHash(child));
    }
  }
  return {
    items,
    order: top.flatMap(s => (typeof s.id === 'string' ? [s.id] : [])),
    meta: itemHash(DECK_META_KEYS.map(key => deck?.[key] ?? null)),
  };
}

/** `pageView` or `deckView` by kind. */
export function viewOf(kind: 'page' | 'deck', content: unknown): ItemView {
  return kind === 'page'
    ? pageView(content as { blocks?: unknown })
    : deckView(content as Record<string, unknown>);
}

/** Rough heap bytes a view holds (for byte-capped stores). */
export function viewBytes(view: ItemView): number {
  let bytes = 200 + (view.meta?.length ?? 0) * 2;
  for (const [id, hash] of view.items) bytes += 2 * (id.length + hash.length) + 80;
  for (const id of view.order) bytes += 2 * id.length + 16;
  return bytes;
}

// ─── What ops depend on ──────────────────────────────────────────────────────

/** The loose shape of a page or deck op, as far as targets go. */
export interface TargetOp {
  op: string;
  id?: string;
  /** Deck block ops: the slide holding the block. */
  slide?: string;
  position?: { after: string } | { at: string };
}

export interface OpTargets {
  /** Items updated, deleted or moved (deck block ops: their slide). */
  content: Set<string>;
  /** `position.after` anchors that must still exist. */
  anchors: Set<string>;
  /** Page replace_all: every top-level block and their order. */
  whole: boolean;
  /** Deck reorder: the top-level slide order. */
  order: boolean;
  /** Deck set_theme: the theme tuple. */
  meta: boolean;
}

const BLOCK_OPS = new Set(['block_add', 'block_update', 'block_delete']);

/** What a batch of page or deck ops depends on. */
export function opTargets(ops: readonly TargetOp[]): OpTargets {
  const targets: OpTargets = {
    content: new Set(),
    anchors: new Set(),
    whole: false,
    order: false,
    meta: false,
  };
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'replace_all') targets.whole = true;
    if (op.op === 'reorder') targets.order = true;
    if (op.op === 'set_theme') targets.meta = true;
    if ((op.op === 'update' || op.op === 'delete' || op.op === 'move') && op.id) {
      targets.content.add(op.id);
    }
    if (BLOCK_OPS.has(op.op) && op.slide) targets.content.add(op.slide);
    const position = op.position as { after?: unknown } | undefined;
    if (
      (op.op === 'insert' || op.op === 'move') &&
      position &&
      typeof position === 'object' &&
      typeof position.after === 'string'
    ) {
      targets.anchors.add(position.after);
    }
  }
  return targets;
}

/** Ops that change or remove existing content (only pure inserts may go unpinned). */
export function needsPin(ops: readonly TargetOp[]): boolean {
  return ops.some(op => op?.op !== 'insert');
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The ids the ops depend on that changed between `then` (what the agent was
 * shown) and `now` (the live doc): updated/deleted/moved items that differ
 * or appeared/vanished, anchors that vanished, `'__order__'` (a reorder,
 * when the top-level order moved) and `'__meta__'` (set_theme, when the
 * theme did). replace_all: every top-level item that differs, or
 * `'__order__'` when only their order moved. Empty = the ops may apply.
 */
export function changedTargets(then: ItemView, now: ItemView, targets: OpTargets): string[] {
  if (targets.whole) {
    const ids = [...new Set([...then.order, ...now.order])];
    const changed = ids.filter(id => then.items.get(id) !== now.items.get(id));
    if (changed.length > 0) return changed;
    if (!sameList(then.order, now.order)) return ['__order__'];
  }
  const changed: string[] = [];
  for (const id of targets.content) {
    const before = then.items.get(id);
    const after = now.items.get(id);
    if (before === undefined && after === undefined) continue; // never existed: the op says so
    if (before !== after) changed.push(id);
  }
  for (const id of targets.anchors) {
    if (targets.content.has(id)) continue;
    if (then.items.has(id) && !now.items.has(id)) changed.push(id);
  }
  if (targets.order && !sameList(then.order, now.order)) changed.push('__order__');
  if (targets.meta && then.meta !== now.meta) changed.push('__meta__');
  return changed;
}

/**
 * The agent's view after its write: `base` is what it was shown (or `pre`
 * when it pinned nothing), `pre`/`post` the live doc right before and after
 * its ops, in one transaction. An item the write created, or one the agent
 * saw as it was, takes its new hash; one someone else changed since the
 * agent's view keeps the agent's (stale) hash, or stays out when the agent
 * never saw it — so a later op on it is refused until the agent re-reads.
 * Order and theme follow the same rule.
 */
export function viewAfterWrite(base: ItemView, pre: ItemView, post: ItemView): ItemView {
  const items = new Map<string, string>();
  for (const [id, hash] of post.items) {
    const before = pre.items.get(id);
    if (before === undefined || before === base.items.get(id)) {
      items.set(id, hash);
    } else {
      const seen = base.items.get(id);
      if (seen !== undefined) items.set(id, seen);
    }
  }
  const view: ItemView = {
    items,
    order: sameList(pre.order, base.order) ? post.order : base.order,
  };
  const meta = pre.meta === base.meta ? post.meta : base.meta;
  if (meta !== undefined) view.meta = meta;
  return view;
}
