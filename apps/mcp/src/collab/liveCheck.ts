/**
 * The per-block staleness check for live edits.
 *
 * A live document's version bumps on every store, so while a person types,
 * any version an agent read is out of date within seconds. Refusing every
 * such apply would keep agents out of any page someone has open. Instead the
 * MCP remembers what each live read returned (in process memory, keyed by
 * kind + doc + version, ~15 min, small LRU), and a later apply against that
 * version compares ONLY what its ops touch — the blocks/slides they update,
 * delete or move, and that their position anchors still exist — between the
 * remembered version and the document now. Untouched → the ops apply (the
 * collab server applies them id-aware, so typing elsewhere is safe); touched
 * → BLOCK_CHANGED naming the ids. A version the MCP no longer remembers
 * (restart, expiry) falls back to the strict whole-document check.
 */

import type { CollabKind, PageSnapshotContent } from '@classmoji/collab';
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';
import { ToolError } from '../mcp/errors.ts';
import { liveVersionConflict, notALiveVersion, parseLiveVersion } from './client.ts';

// ─── Snapshot cache ──────────────────────────────────────────────────────────

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;

const cache = new Map<string, { content: unknown; at: number }>();

const keyOf = (kind: CollabKind, id: string, version: number) => `${kind}:${id}:${version}`;

/** Remember what the live document `kind/id` held at `version`. */
export function rememberSnapshot(
  kind: CollabKind,
  id: string,
  version: number,
  content: unknown,
  now = Date.now()
): void {
  const key = keyOf(kind, id, version);
  cache.delete(key);
  cache.set(key, { content, at: now });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** What `kind/id` held at `version`, if still remembered. */
export function recallSnapshot<T>(
  kind: CollabKind,
  id: string,
  version: number,
  now = Date.now()
): T | null {
  const key = keyOf(kind, id, version);
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (LRU).
  cache.delete(key);
  cache.set(key, entry);
  return entry.content as T;
}

/** Tests only. */
export function clearSnapshotCache(): void {
  cache.clear();
}

// ─── Comparison ──────────────────────────────────────────────────────────────

/**
 * Whether `now` still says everything `then` said. Extra keys in `now` are
 * fine: the live document fills in BlockNote's default props on a block an
 * agent wrote without them, and that is not a change anyone made. Arrays
 * (text runs, children, table rows) must match element for element.
 */
function covers(then: unknown, now: unknown): boolean {
  if (then === now) return true;
  if (then === null || now === null || typeof then !== 'object' || typeof now !== 'object') {
    return false;
  }
  if (Array.isArray(then) || Array.isArray(now)) {
    if (!Array.isArray(then) || !Array.isArray(now) || then.length !== now.length) return false;
    return then.every((item, i) => covers(item, now[i]));
  }
  const nowRecord = now as Record<string, unknown>;
  return Object.entries(then as Record<string, unknown>).every(
    ([key, value]) => value === undefined || covers(value, nowRecord[key])
  );
}

/** Deep equality that ignores key order (and keys set to undefined). */
const same = (a: unknown, b: unknown) => covers(a, b) && covers(b, a);

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

/** What a set of ops depends on: ids whose content matters, ids that must exist. */
interface Targets {
  content: Set<string>;
  anchors: Set<string>;
  /** An op that depends on the whole document (replace_all): strict check. */
  whole: boolean;
  /** Deck: top-level order (reorder) and theme (set_theme). */
  order: boolean;
  meta: boolean;
}

function emptyTargets(): Targets {
  return { content: new Set(), anchors: new Set(), whole: false, order: false, meta: false };
}

type AnyOp = { op: string; id?: string; position?: { after: string } | { at: string } };

function collectTargets(ops: AnyOp[]): Targets {
  const targets = emptyTargets();
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

/**
 * Ids the ops depend on that changed between `then` and `now` (`'__order__'`
 * for the slide order, `'__meta__'` for the theme), or `'whole'` when an op
 * depends on the whole document.
 */
export function changedPageTargets(
  then: PageSnapshotContent,
  now: PageSnapshotContent,
  ops: AnyOp[]
): string[] | 'whole' {
  const targets = collectTargets(ops);
  if (targets.whole) return 'whole';
  const changed: string[] = [];
  for (const id of targets.content) {
    const before = findBlock(then.blocks, id);
    const after = findBlock(now.blocks, id);
    if (before === null && after === null) continue; // never existed: the op reports it
    if (before === null || after === null || !covers(before, after)) changed.push(id);
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

/** The refusal when something an apply touches changed since the agent's read. */
export function blockChangedError(kind: 'page' | 'deck', ids: string[]): ToolError {
  const what = kind === 'page' ? 'block' : 'slide';
  const read = kind === 'page' ? 'page_content_get' : 'deck_get';
  return new ToolError(
    'invalid_params',
    `Someone changed ${ids.length === 1 ? `the ${what}` : `${what}s`} these ops touch since ` +
      `you read it (${ids.map(id => `'${id}'`).join(', ')}), so nothing was applied. Re-read ` +
      `with ${read} and retry, or use mode: 'preview'.`,
    'BLOCK_CHANGED',
    { changed_ids: ids }
  );
}

// ─── The check ───────────────────────────────────────────────────────────────

/** Refuse, before any request, an expected_sha that is not a live version. */
export function assertLiveVersionArg(kind: 'page' | 'deck', expectedSha: string | undefined): void {
  if (expectedSha !== undefined && parseLiveVersion(expectedSha) === null) {
    throw notALiveVersion(kind);
  }
}

/**
 * Decide whether a live apply may go ahead. `expectedSha` omitted → yes (the
 * caller chose not to pin a read). Same version → yes. Older version the MCP
 * remembers → yes unless something the ops touch changed since (BLOCK_CHANGED).
 * Older version it does not remember, or an op on the whole document → the
 * strict check: refused as stale.
 */
export function checkLiveVersion(
  kind: 'page' | 'deck',
  id: string,
  expectedSha: string | undefined,
  fresh: { version: number; content: unknown },
  ops: AnyOp[]
): void {
  if (expectedSha === undefined) return;
  const expected = parseLiveVersion(expectedSha);
  if (expected === null) throw notALiveVersion(kind);
  if (fresh.version === expected) return;
  const then = recallSnapshot<unknown>(kind, id, expected);
  if (then === null) throw liveVersionConflict(expectedSha, fresh.version, kind);
  const changed =
    kind === 'page'
      ? changedPageTargets(then as PageSnapshotContent, fresh.content as PageSnapshotContent, ops)
      : changedDeckTargets(then as DeckJson, fresh.content as DeckJson, ops);
  if (changed === 'whole') throw liveVersionConflict(expectedSha, fresh.version, kind);
  if (changed.length > 0) throw blockChangedError(kind, changed);
}
