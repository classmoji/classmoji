/**
 * The staleness check for live edits: the agent's pin is
 * `live:<epoch>.<version>`, and what it pins is the snapshot the agent READ.
 *
 * A live document's version bumps on every store, so while a person types,
 * any version an agent read is out of date within seconds. Refusing every
 * such apply would keep agents out of any page someone has open. Instead the
 * MCP remembers the snapshot each live read returned, and the agent's view
 * after each live apply (process memory, keyed by caller + kind + doc + epoch
 * + version, ~15 min, small LRU; between two reads the FIRST is kept, so a
 * later read can never weaken an earlier pin, but a read always replaces a
 * view an apply left, so re-reading clears a refusal that view caused; one
 * agent's view never stands in for another's read),
 * and an apply compares ONLY what its ops depend on — the blocks/slides they
 * update, delete or move, that their position anchors still exist, the slide
 * order for a reorder, the theme for set_theme, the whole document for
 * replace_all — between that snapshot and the document now, whether or not
 * the versions differ. Untouched → the ops apply (the collab server applies
 * them id-aware, so typing elsewhere is safe); touched → BLOCK_CHANGED naming
 * the ids. A pin the MCP no longer remembers (restart, expiry, another
 * instance), or the older version-only form, falls back to the strict check
 * (same version or CONTENT_CONFLICT reason 'unknown-pin'); a pin from another
 * epoch (the document was reloaded from git) is always refused (reason
 * 'reloaded').
 *
 * Pages are compared after a round trip through the page schema on both
 * sides (the live server's snapshots already are; what the MCP caches after
 * its own apply is normalized here), so a human's formatting change or
 * re-nesting is a change.
 */

import type { CollabKind, PageSnapshotContent } from '@classmoji/collab';
import { itemHash } from '@classmoji/collab/hash';
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';
import {
  blockChangedError,
  liveEpochConflict,
  livePinUnknown,
  notALiveVersion,
  parseLiveVersion,
  pinRequired,
} from './client.ts';

// ─── Snapshot cache ──────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;

/** `read`: what a read returned; `apply`: the agent's view after its own apply. */
export type SnapshotOrigin = 'read' | 'apply';

const cache = new Map<string, { content: unknown; at: number; origin: SnapshotOrigin }>();

const keyOf = (viewer: string, kind: CollabKind, id: string, epoch: number, version: number) =>
  `${viewer}:${kind}:${id}:${epoch}.${version}`;

/**
 * Remember what `kind/id` held at `epoch.version` as `viewer` (the MCP
 * caller's user id) was shown it, by a read or as its own apply left it.
 * An unexpired entry is kept, with one exception: a read replaces a view an
 * apply left (that view is the agent's read plus its ops and can lack an edit
 * someone stored into the same version; the read is what the agent now
 * holds). If two reads at one version saw different content (edits not
 * stored yet), the older one stays — comparing against it can only refuse
 * more, never less.
 */
export function rememberSnapshot(
  viewer: string,
  kind: CollabKind,
  id: string,
  epoch: number,
  version: number,
  content: unknown,
  origin: SnapshotOrigin,
  now = Date.now()
): void {
  const key = keyOf(viewer, kind, id, epoch, version);
  const existing = cache.get(key);
  const replaces = existing?.origin === 'apply' && origin === 'read';
  if (existing && now - existing.at <= TTL_MS && !replaces) return;
  cache.delete(key);
  cache.set(key, { content, at: now, origin });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The snapshot `viewer` was shown of `kind/id` at `epoch.version`, if any. */
export function recallSnapshot<T>(
  viewer: string,
  kind: CollabKind,
  id: string,
  epoch: number,
  version: number,
  now = Date.now()
): T | null {
  const key = keyOf(viewer, kind, id, epoch, version);
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (LRU) without touching `at`: the TTL counts from the read.
  cache.delete(key);
  cache.set(key, entry);
  return entry.content as T;
}

/** Tests only. */
export function clearSnapshotCache(): void {
  cache.clear();
}

// ─── Comparison ──────────────────────────────────────────────────────────────

/** Deep equality that ignores key order and keys set to undefined. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => same(item, b[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) {
    if (x[key] === undefined && y[key] === undefined) continue;
    if (!same(x[key], y[key])) return false;
  }
  return true;
}

interface PageBlock {
  id?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

function findBlock(blocks: unknown, id: string): PageBlock | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as PageBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.id === id) return block;
    const nested = findBlock(block.children, id);
    if (nested) return nested;
  }
  return null;
}

type AnyOp = { op: string; id?: string; position?: { after: string } | { at: string } };

/** Ops that change or remove existing content: these need a pin. */
export function needsPin(ops: AnyOp[]): boolean {
  return ops.some(op => op.op !== 'insert');
}

interface Targets {
  content: Set<string>;
  anchors: Set<string>;
  whole: boolean;
  order: boolean;
  meta: boolean;
}

function collectTargets(ops: AnyOp[]): Targets {
  const targets: Targets = {
    content: new Set(),
    anchors: new Set(),
    whole: false,
    order: false,
    meta: false,
  };
  for (const op of ops) {
    if (op.op === 'replace_all') targets.whole = true;
    if (op.op === 'reorder') targets.order = true;
    if (op.op === 'set_theme') targets.meta = true;
    if ((op.op === 'update' || op.op === 'delete' || op.op === 'move') && op.id) {
      targets.content.add(op.id);
    }
    if ((op.op === 'insert' || op.op === 'move') && op.position && 'after' in op.position) {
      targets.anchors.add(op.position.after);
    }
  }
  return targets;
}

/** Top-level blocks added, removed or changed; `'__order__'` when only their order moved. */
function changedTopLevel(then: unknown, now: unknown): string[] {
  const list = (blocks: unknown) =>
    (Array.isArray(blocks) ? (blocks as PageBlock[]) : []).filter(
      b => b && typeof b.id === 'string'
    );
  const before = new Map(list(then).map(b => [b.id as string, b]));
  const after = new Map(list(now).map(b => [b.id as string, b]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    id => !before.has(id) || !after.has(id) || !same(before.get(id), after.get(id))
  );
  return changed.length > 0 ? changed : ['__order__'];
}

/** Ids the ops depend on that changed between `then` and `now` (replace_all: every top-level block that did). */
export function changedPageTargets(
  then: PageSnapshotContent,
  now: PageSnapshotContent,
  ops: AnyOp[]
): string[] {
  const targets = collectTargets(ops);
  if (targets.whole && !same(then.blocks, now.blocks)) {
    return changedTopLevel(then.blocks, now.blocks);
  }
  const changed: string[] = [];
  for (const id of targets.content) {
    const before = findBlock(then.blocks, id);
    const after = findBlock(now.blocks, id);
    if (before === null && after === null) continue; // never existed: the op reports it
    if (before === null || after === null || !same(before, after)) changed.push(id);
  }
  for (const id of targets.anchors) {
    if (targets.content.has(id)) continue;
    if (findBlock(then.blocks, id) && !findBlock(now.blocks, id)) changed.push(id);
  }
  return changed;
}

function findSlide(slides: DeckSlide[], id: string): DeckSlide | null {
  for (const slide of slides) {
    if (slide.id === id) return slide;
    for (const child of slide.children ?? []) if (child.id === id) return child;
  }
  return null;
}

/** Ids the ops depend on that changed (`'__order__'` slide order, `'__meta__'` theme). */
export function changedDeckTargets(then: DeckJson, now: DeckJson, ops: AnyOp[]): string[] {
  const targets = collectTargets(ops);
  const changed: string[] = [];
  for (const id of targets.content) {
    const before = findSlide(then.slides, id);
    const after = findSlide(now.slides, id);
    if (before === null && after === null) continue;
    if (before === null || after === null || !same(before, after)) changed.push(id);
  }
  for (const id of targets.anchors) {
    if (targets.content.has(id)) continue;
    if (findSlide(then.slides, id) && !findSlide(now.slides, id)) changed.push(id);
  }
  if (
    targets.order &&
    !same(
      then.slides.map(s => s.id),
      now.slides.map(s => s.id)
    )
  ) {
    changed.push('__order__');
  }
  if (
    targets.meta &&
    !same(
      [then.theme, then.codeTheme, then.themeDark, then.codeThemeDark],
      [now.theme, now.codeTheme, now.themeDark, now.codeThemeDark]
    )
  ) {
    changed.push('__meta__');
  }
  return changed;
}

// ─── The check ───────────────────────────────────────────────────────────────

/** Refuse, before any request, a missing or malformed pin. */
export function assertLivePin(
  kind: 'page' | 'deck',
  expectedSha: string | undefined,
  ops: AnyOp[]
): void {
  if (expectedSha === undefined) {
    if (needsPin(ops)) throw pinRequired(kind);
    return;
  }
  if (parseLiveVersion(expectedSha) === null) throw notALiveVersion(kind);
}

/**
 * Decide whether a live apply may go ahead against `fresh`, and return the
 * snapshot the agent read when the MCP has it. The base for what the caller
 * caches after the apply is `agentView ?? fresh.content`: with no remembered
 * read (a pure insert without a pin, or a strict-check pass) the agent's view
 * is the document as its apply found it — exactly what the strict check
 * accepts at an equal version — so a follow-up pinned to `new_sha` is still
 * checked per block instead of failing on any keystroke. Call
 * `assertLivePin` first.
 */
export function checkLivePin(
  viewer: string,
  kind: 'page' | 'deck',
  id: string,
  expectedSha: string | undefined,
  fresh: { epoch: number; version: number; content: unknown },
  ops: AnyOp[]
): { agentView: unknown | null } {
  if (expectedSha === undefined) return { agentView: null }; // pure inserts
  const pin = parseLiveVersion(expectedSha);
  if (pin === null) throw notALiveVersion(kind);
  const strict = () => {
    if (pin.version !== fresh.version) throw livePinUnknown(expectedSha, fresh, kind);
    return { agentView: null };
  };
  if (pin.epoch === null) return strict();
  if (pin.epoch !== fresh.epoch) throw liveEpochConflict(kind);
  const then = recallSnapshot<unknown>(viewer, kind, id, pin.epoch, pin.version);
  if (then === null) return strict();
  const changed =
    kind === 'page'
      ? changedPageTargets(then as PageSnapshotContent, fresh.content as PageSnapshotContent, ops)
      : changedDeckTargets(then as DeckJson, fresh.content as DeckJson, ops);
  if (changed.length > 0) throw blockChangedError(kind, changed);
  return { agentView: then };
}

// ─── Server-side guard (`expect`) and inserted ids ──────────────────────────

/**
 * The `expect` map for a guarded `/ops` call: `itemHash` of every block/slide
 * the ops update, delete or move — and, for replace_all, every top-level
 * block — as it was in `base` (the snapshot the agent read, or the fresh one
 * when the MCP no longer has the read). The collab server recomputes these
 * inside the live transaction and refuses with block-changed on a mismatch,
 * which also closes the gap between this process's check and the apply.
 * Anchors are not listed: an insert after a paragraph someone is typing in
 * is fine, and an anchor that is gone fails the op on its own.
 */
export function expectFor(
  kind: 'page' | 'deck',
  base: unknown,
  ops: AnyOp[]
): Record<string, string> {
  if (!base) return {};
  const targets = collectTargets(ops);
  const expect: Record<string, string> = {};
  if (kind === 'page') {
    const blocks = (base as PageSnapshotContent).blocks;
    if (targets.whole && Array.isArray(blocks)) {
      for (const block of blocks as PageBlock[]) {
        if (block && typeof block.id === 'string') expect[block.id] = itemHash(block);
      }
    }
    for (const id of targets.content) {
      const block = findBlock(blocks, id);
      if (block) expect[id] = itemHash(block);
    }
  } else {
    const slides = (base as DeckJson).slides ?? [];
    for (const id of targets.content) {
      const slide = findSlide(slides, id);
      if (slide) expect[id] = itemHash(slide);
    }
  }
  return expect;
}

/**
 * How many ids the server reports for each op's inserts (0 for non-inserts):
 * a page insert's top-level blocks; a deck insert's slides, each followed by
 * a new stack's children.
 */
function insertCounts(ops: AnyOp[]): number[] {
  return ops.map(op => {
    if (op.op !== 'insert') return 0;
    const { blocks, slides } = op as { blocks?: unknown[]; slides?: unknown[] };
    if (Array.isArray(blocks)) return blocks.length;
    if (!Array.isArray(slides)) return 0;
    return slides.reduce<number>((n, spec) => {
      const children = (spec as { children?: unknown[] } | null)?.children;
      return n + 1 + (Array.isArray(children) ? children.length : 0);
    }, 0);
  });
}

/**
 * The server's `insertedIds` (flat, op order) split per op, or null when they
 * do not line up with the ops' inserted items one to one (then the caller
 * reports them flat and does not cache a view built on guessed ids).
 */
export function splitInsertedIds(ops: AnyOp[], insertedIds: unknown): string[][] | null {
  if (!Array.isArray(insertedIds) || !insertedIds.every(id => typeof id === 'string')) {
    return null;
  }
  const counts = insertCounts(ops);
  if (counts.reduce((a, b) => a + b, 0) !== insertedIds.length) return null;
  const out: string[][] = [];
  let at = 0;
  for (const count of counts) {
    out.push((insertedIds as string[]).slice(at, at + count));
    at += count;
  }
  return out;
}
