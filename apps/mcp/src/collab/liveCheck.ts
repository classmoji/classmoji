/**
 * The staleness check for live edits: the agent's pin is
 * `live:<epoch>.<version>`, and what it pins is the snapshot the agent READ.
 *
 * A live document's version bumps on every store, so while a person types,
 * any version an agent read is out of date within seconds. Refusing every
 * such apply would keep agents out of any page someone has open. Instead the
 * MCP remembers the snapshot each live read returned (process memory, keyed
 * by kind + doc + epoch + version, ~15 min, small LRU; the FIRST snapshot
 * seen for a key is kept, so a later read can never weaken an earlier pin),
 * and an apply compares ONLY what its ops depend on — the blocks/slides they
 * update, delete or move, that their position anchors still exist, the slide
 * order for a reorder, the theme for set_theme, the whole document for
 * replace_all — between that snapshot and the document now, whether or not
 * the versions differ. Untouched → the ops apply (the collab server applies
 * them id-aware, so typing elsewhere is safe); touched → BLOCK_CHANGED naming
 * the ids. A pin the MCP no longer remembers (restart, expiry), or the older
 * version-only form, falls back to the strict check (same version or
 * refused); a pin from another epoch (the document was reloaded from git) is
 * always refused.
 *
 * Pages are compared after a round trip through the page schema on both
 * sides (the live server's snapshots already are; what the MCP caches after
 * its own apply is normalized here), so a human's formatting change or
 * re-nesting is a change.
 */

import type { CollabKind, PageSnapshotContent } from '@classmoji/collab';
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';
import { ToolError } from '../mcp/errors.ts';
import {
  liveEpochConflict,
  liveVersionConflict,
  notALiveVersion,
  parseLiveVersion,
  pinRequired,
} from './client.ts';

// ─── Snapshot cache ──────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;

const cache = new Map<string, { content: unknown; at: number }>();

const keyOf = (kind: CollabKind, id: string, epoch: number, version: number) =>
  `${kind}:${id}:${epoch}.${version}`;

/**
 * Remember what `kind/id` held at `epoch.version` as an agent was shown it.
 * An unexpired entry is never replaced: if two reads at one version saw
 * different content (edits not stored yet), the older one stays — comparing
 * against it can only refuse more, never less.
 */
export function rememberSnapshot(
  kind: CollabKind,
  id: string,
  epoch: number,
  version: number,
  content: unknown,
  now = Date.now()
): void {
  const key = keyOf(kind, id, epoch, version);
  const existing = cache.get(key);
  if (existing && now - existing.at <= TTL_MS) return;
  cache.delete(key);
  cache.set(key, { content, at: now });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The snapshot remembered for `kind/id` at `epoch.version`, if any. */
export function recallSnapshot<T>(
  kind: CollabKind,
  id: string,
  epoch: number,
  version: number,
  now = Date.now()
): T | null {
  const key = keyOf(kind, id, epoch, version);
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

/** Ids the ops depend on that changed between `then` and `now` (`'__document__'` for replace_all). */
export function changedPageTargets(
  then: PageSnapshotContent,
  now: PageSnapshotContent,
  ops: AnyOp[]
): string[] {
  const targets = collectTargets(ops);
  if (targets.whole && !same(then.blocks, now.blocks)) return ['__document__'];
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

/** The refusal when something an apply depends on changed since the agent's read. */
export function blockChangedError(kind: 'page' | 'deck', ids: string[]): ToolError {
  const what = kind === 'page' ? 'block' : 'slide';
  const read = kind === 'page' ? 'page_content_get' : 'deck_get';
  const named = ids.map(id => `'${id}'`).join(', ');
  return new ToolError(
    'invalid_params',
    `Someone changed what these ops touch since you read it (${what}s: ${named}), so nothing ` +
      `was applied. Re-read with ${read} and retry, or use mode: 'preview'.`,
    'BLOCK_CHANGED',
    { changed_ids: ids }
  );
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
 * snapshot the agent read when the MCP has it (the base for what it caches
 * after the apply). Call `assertLivePin` first.
 */
export function checkLivePin(
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
    if (pin.version !== fresh.version) throw liveVersionConflict(expectedSha, fresh, kind);
    return { agentView: null };
  };
  if (pin.epoch === null) return strict();
  if (pin.epoch !== fresh.epoch) throw liveEpochConflict(kind);
  const then = recallSnapshot<unknown>(kind, id, pin.epoch, pin.version);
  if (then === null) return strict();
  const changed =
    kind === 'page'
      ? changedPageTargets(then as PageSnapshotContent, fresh.content as PageSnapshotContent, ops)
      : changedDeckTargets(then as DeckJson, fresh.content as DeckJson, ops);
  if (changed.includes('__document__')) throw liveVersionConflict(expectedSha, fresh, kind);
  if (changed.length > 0) throw blockChangedError(kind, changed);
  return { agentView: then };
}
