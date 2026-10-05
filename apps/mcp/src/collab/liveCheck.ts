/**
 * The staleness check for live edits: the agent's pin is
 * `live:<epoch>.<version>`, and what it pins is what the agent was SHOWN.
 *
 * A live document's version bumps on every store, so while a person types,
 * any version an agent read is out of date within seconds. Refusing every
 * such apply would keep agents out of any page someone has open. Instead an
 * apply is judged only on what its ops depend on — the blocks/slides they
 * update, delete or move (a deck block op: the slide holding the block), that
 * their position anchors still exist, the slide order for a reorder, the
 * theme for set_theme, the whole document for replace_all — between what the
 * agent was shown at the pinned version and the document now.
 *
 * That judgement is made by the COLLAB SERVER (`/ops` `expect_since`), not
 * here: it remembers, per agent (user + Mcp-Session-Id), the hashes of what
 * each agent read (`/snapshot?viewer=…`) and of the view each of its writes
 * left, so it does not matter which MCP machine served the read and which
 * the apply. This MCP keeps no per-pin state. Answers: untouched → applied;
 * touched → 409 block-changed (BLOCK_CHANGED naming the ids); a pin the
 * server does not hold for this agent (never read by it, expired after
 * 30 min, collab restarted) → 409 unknown-version (CONTENT_CONFLICT
 * 'unknown-pin', re-read); another epoch (reloaded from git) → 409
 * stale-epoch (CONTENT_CONFLICT 'reloaded', also checked here first).
 * Renders read with no viewer, so a render never counts as a read.
 */

import { needsPin, type TargetOp } from '@classmoji/collab/hash';
import { liveEpochConflict, notALiveVersion, parseLiveVersion, pinRequired } from './client.ts';

export { needsPin };

/** Refuse, before any request, a missing or malformed pin. */
export function assertLivePin(
  kind: 'page' | 'deck',
  expectedSha: string | undefined,
  ops: TargetOp[]
): void {
  if (expectedSha === undefined) {
    if (needsPin(ops)) throw pinRequired(kind);
    return;
  }
  if (parseLiveVersion(expectedSha) === null) throw notALiveVersion(kind);
}

/**
 * The `expect_since` the apply sends for `expectedSha` (null: a pure insert
 * with no pin). The older version-only form (`live:12`) is read in the
 * current epoch. A pin from another epoch is refused here, before any write
 * (the server refuses it too). Call `assertLivePin` first.
 */
export function expectSinceFor(
  kind: 'page' | 'deck',
  expectedSha: string | undefined,
  current: { epoch: number }
): { epoch: number; version: number } | null {
  if (expectedSha === undefined) return null;
  const pin = parseLiveVersion(expectedSha);
  if (pin === null) throw notALiveVersion(kind);
  const epoch = pin.epoch ?? current.epoch;
  if (epoch !== current.epoch) throw liveEpochConflict(kind);
  return { epoch, version: pin.version };
}

// ─── Inserted ids ────────────────────────────────────────────────────────────

type InsertOp = TargetOp & { blocks?: unknown[]; slides?: unknown[] };

/**
 * How many ids the server reports for each op's inserts (0 for non-inserts):
 * a page insert's top-level blocks; a deck insert's slides, each followed by
 * a new stack's children.
 */
function insertCounts(ops: InsertOp[]): number[] {
  return ops.map(op => {
    if (op.op !== 'insert') return 0;
    const { blocks, slides } = op;
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
 * reports them flat).
 */
export function splitInsertedIds(ops: InsertOp[], insertedIds: unknown): string[][] | null {
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
