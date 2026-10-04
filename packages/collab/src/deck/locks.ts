/**
 * Per-slide locks (`locks` Y.Map, keyed by slide id → SlideLock).
 *
 * Protocol:
 *  - A client takes a slide's lock when its user focuses or edits the slide,
 *    and holds it while editing. It heartbeats `lastActive` at most every
 *    LOCK_HEARTBEAT_MS while active, releases after LOCK_RELEASE_IDLE_MS idle
 *    (or sooner after blur), and on leave.
 *  - Others see the slide read-only. Once the holder has been idle for
 *    LOCK_TAKEOVER_IDLE_MS, or the holder is no longer connected, anyone may
 *    take it over (an explicit button in the editor).
 *  - Idleness is measured by LOCAL receive time of the last change to the
 *    lock entry (`LockActivity`), never by comparing `lastActive` across
 *    machines — clocks differ. The holder's heartbeat is what keeps it fresh.
 *  - The server clears a disconnected client's locks, and expires locks idle
 *    for LOCK_EXPIRE_IDLE_MS (a frozen tab).
 *  - Two clients claiming one free slide at once: the claim with the lowest
 *    Yjs clientID wins, enforced by the server's `installLockArbiter`. Yjs's
 *    own map merge would pick the highest, and silently — the losing write
 *    never shows up as a map change — so the arbiter inspects every claim a
 *    transaction integrated, including the ones the merge discarded.
 *  - A client writes a slide's html only once its claim is confirmed: the
 *    provider has no unsynced changes since the claim and the lock still names
 *    it. A lost race therefore never lands the loser's html.
 */
import * as Y from 'yjs';

import type { SlideLock } from '../api.ts';
import { deckLocks } from './convert.ts';

export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_RELEASE_IDLE_MS = 30_000;
export const LOCK_BLUR_RELEASE_MS = 5_000;
export const LOCK_TAKEOVER_IDLE_MS = 60_000;
export const LOCK_EXPIRE_IDLE_MS = 120_000;

export type LockHolder = Pick<SlideLock, 'userId' | 'name' | 'color' | 'clientId'>;

export function isSlideLock(value: unknown): value is SlideLock {
  const v = value as SlideLock | null;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.userId === 'string' &&
    typeof v.clientId === 'number' &&
    typeof v.since === 'number' &&
    typeof v.lastActive === 'number'
  );
}

export function getLock(doc: Y.Doc, slideId: string): SlideLock | null {
  const value = deckLocks(doc).get(slideId);
  return isSlideLock(value) ? value : null;
}

/** All locks, by slide id. */
export function allLocks(doc: Y.Doc): Map<string, SlideLock> {
  const out = new Map<string, SlideLock>();
  deckLocks(doc).forEach((value, key) => {
    if (isSlideLock(value)) out.set(key, value);
  });
  return out;
}

export interface LockContext {
  now: number;
  /** Yjs clientIDs currently connected (awareness states). Omit = unknown. */
  connected?: ReadonlySet<number>;
  /** ms since the lock entry last changed, measured locally (LockActivity). */
  idleMs?: number;
}

export type LockState =
  /** Nobody holds it. */
  | 'free'
  /** This client holds it. */
  | 'mine'
  /** Someone else holds it and is active. */
  | 'held'
  /** Someone else holds it but is idle ≥ 60 s or gone: may be taken over. */
  | 'stale';

export function lockState(lock: SlideLock | null, clientId: number, ctx: LockContext): LockState {
  if (!lock) return 'free';
  if (lock.clientId === clientId) return 'mine';
  if (ctx.connected && !ctx.connected.has(lock.clientId)) return 'stale';
  const idle = ctx.idleMs ?? Math.max(0, ctx.now - lock.lastActive);
  return idle >= LOCK_TAKEOVER_IDLE_MS ? 'stale' : 'held';
}

/** A lock that blocks others: held by someone else, active, and connected. */
export function isLiveLockOfOther(lock: SlideLock | null, clientId: number, ctx: LockContext) {
  return lockState(lock, clientId, ctx) === 'held';
}

export type AcquireResult =
  | { ok: true; lock: SlideLock; tookOver: boolean }
  | { ok: false; holder: SlideLock };

/**
 * Take (or refresh) a slide's lock. Free → claim; mine → refresh lastActive;
 * someone else's → refused, unless `takeover` and the lock is stale.
 */
export function acquireLock(
  doc: Y.Doc,
  slideId: string,
  holder: LockHolder,
  ctx: LockContext & { takeover?: boolean },
  origin: unknown = null
): AcquireResult {
  const current = getLock(doc, slideId);
  const state = lockState(current, holder.clientId, ctx);
  if (state === 'held' || (state === 'stale' && !ctx.takeover)) {
    return { ok: false, holder: current as SlideLock };
  }
  const lock: SlideLock = {
    userId: holder.userId,
    name: holder.name,
    color: holder.color,
    clientId: holder.clientId,
    since: state === 'mine' && current ? current.since : ctx.now,
    lastActive: ctx.now,
  };
  doc.transact(() => deckLocks(doc).set(slideId, lock), origin);
  return { ok: true, lock, tookOver: state === 'stale' };
}

/** Heartbeat: bump lastActive if this client holds the lock. */
export function touchLock(
  doc: Y.Doc,
  slideId: string,
  clientId: number,
  now: number,
  origin: unknown = null
): boolean {
  const current = getLock(doc, slideId);
  if (!current || current.clientId !== clientId) return false;
  doc.transact(() => deckLocks(doc).set(slideId, { ...current, lastActive: now }), origin);
  return true;
}

/** Release a lock this client holds. */
export function releaseLock(doc: Y.Doc, slideId: string, clientId: number, origin: unknown = null) {
  const current = getLock(doc, slideId);
  if (!current || current.clientId !== clientId) return false;
  doc.transact(() => deckLocks(doc).delete(slideId), origin);
  return true;
}

/** Server: drop every lock held by these Yjs clients (they disconnected). */
export function releaseLocksOf(
  doc: Y.Doc,
  clientIds: Iterable<number>,
  origin: unknown = null
): string[] {
  const gone = new Set(clientIds);
  const released: string[] = [];
  for (const [slideId, lock] of allLocks(doc)) {
    if (gone.has(lock.clientId)) released.push(slideId);
  }
  if (released.length > 0) {
    doc.transact(() => {
      for (const slideId of released) deckLocks(doc).delete(slideId);
    }, origin);
  }
  return released;
}

/**
 * Server: drop locks idle ≥ `maxIdleMs` (by local observation when an
 * activity tracker is given, else by `lastActive`) and locks of clients not
 * in `connected`.
 */
export function expireLocks(
  doc: Y.Doc,
  ctx: {
    now: number;
    maxIdleMs?: number;
    activity?: LockActivity;
    connected?: ReadonlySet<number>;
  },
  origin: unknown = null
): string[] {
  const maxIdle = ctx.maxIdleMs ?? LOCK_EXPIRE_IDLE_MS;
  const expired: string[] = [];
  for (const [slideId, lock] of allLocks(doc)) {
    const idle = ctx.activity?.idleMs(slideId, ctx.now) ?? ctx.now - lock.lastActive;
    const gone = ctx.connected ? !ctx.connected.has(lock.clientId) : false;
    if (gone || idle >= maxIdle) expired.push(slideId);
  }
  if (expired.length > 0) {
    doc.transact(() => {
      for (const slideId of expired) deckLocks(doc).delete(slideId);
    }, origin);
  }
  return expired;
}

/**
 * When each lock entry last changed, by THIS machine's clock. Idleness for
 * takeover and expiry is read from here so clock skew between peers never
 * matters: the holder's heartbeat arrives as a change.
 */
export class LockActivity {
  private readonly seen = new Map<string, number>();
  private readonly map: Y.Map<unknown>;
  private readonly clock: () => number;
  private readonly handler: (event: Y.YMapEvent<unknown>) => void;

  constructor(doc: Y.Doc, clock: () => number = Date.now) {
    this.map = deckLocks(doc);
    this.clock = clock;
    const start = clock();
    this.map.forEach((_value, key) => this.seen.set(key, start));
    this.handler = event => {
      const now = this.clock();
      for (const key of event.keysChanged) {
        if (this.map.has(key)) this.seen.set(key, now);
        else this.seen.delete(key);
      }
    };
    this.map.observe(this.handler);
  }

  /** ms since the lock entry last changed here (0 when there is none). */
  idleMs(slideId: string, now: number = this.clock()): number {
    const at = this.seen.get(slideId);
    return at === undefined ? 0 : Math.max(0, now - at);
  }

  destroy(): void {
    this.map.unobserve(this.handler);
  }
}

// ─── Server arbiter: lowest clientID wins a simultaneous claim ────────────────

type ItemLike = {
  id: { client: number; clock: number };
  origin: { client: number; clock: number } | null;
  left: ItemLike | null;
  parentSub: string | null;
  deleted: boolean;
  content: { getContent?: () => unknown[] };
};

function sameId(a: ItemLike['origin'], b: ItemLike['origin']): boolean {
  if (a === b) return true;
  return !!a && !!b && a.client === b.client && a.clock === b.clock;
}

function lockOf(item: ItemLike): SlideLock | null {
  const value = item.content?.getContent?.()[0];
  return isSlideLock(value) ? value : null;
}

/**
 * The corrections a transaction needs so that, among claims made concurrently
 * on one slide (sibling items with the same left origin — none of them saw the
 * others), the claim with the lowest clientId holds the lock. A takeover (an
 * item whose origin is the previous lock) is never second-guessed.
 *
 * Considers every value item for a touched key that this transaction inserted
 * or deleted: the merge discards a losing concurrent claim without any visible
 * map change, but its item (and content) is still there until GC runs after
 * the transaction. Reads Yjs internals (`_map`, item `left`/`origin`) — kept to
 * this one function and pinned by tests.
 */
export function lockArbitration(
  doc: Y.Doc,
  transaction: Y.Transaction
): Array<{ slideId: string; lock: SlideLock }> {
  const locks = deckLocks(doc);
  const lockMap = (locks as unknown as { _map: Map<string, ItemLike> })._map;
  const touched = new Set<string>();
  for (const [type, keys] of transaction.changed) {
    if (type !== (locks as unknown)) continue;
    for (const key of keys) if (key) touched.add(key);
  }
  // A losing claim leaves no visible change; find its key via the inserts.
  for (const [client, afterClock] of transaction.afterState) {
    const beforeClock = transaction.beforeState.get(client) ?? 0;
    if (afterClock <= beforeClock) continue;
    const store = (
      doc as unknown as {
        store: { clients: Map<number, Array<ItemLike & { length: number; parent: unknown }>> };
      }
    ).store;
    for (const struct of store.clients.get(client) ?? []) {
      if (struct.id.clock + struct.length <= beforeClock) continue;
      if (struct.parent === locks && typeof struct.parentSub === 'string') {
        touched.add(struct.parentSub);
      }
    }
  }

  const fresh = (item: ItemLike): boolean => {
    const before = transaction.beforeState.get(item.id.client) ?? 0;
    return item.id.clock >= before || Y.isDeleted(transaction.deleteSet, item.id as Y.ID);
  };

  const fixes: Array<{ slideId: string; lock: SlideLock }> = [];
  for (const slideId of touched) {
    const current = lockMap.get(slideId);
    if (!current || current.deleted) continue; // released
    const currentLock = lockOf(current);
    if (!currentLock) continue;
    let best = currentLock;
    for (let item = current.left; item; item = item.left) {
      if (!fresh(item) || !sameId(item.origin, current.origin)) continue;
      const rival = lockOf(item);
      if (rival && rival.clientId < best.clientId) best = rival;
    }
    if (best.clientId !== currentLock.clientId) fixes.push({ slideId, lock: best });
  }
  return fixes;
}

/**
 * Server: enforce `lockArbitration` after every transaction. Returns an
 * uninstall function.
 */
export function installLockArbiter(doc: Y.Doc, origin: unknown = 'lock-arbiter'): () => void {
  let applying = false;
  const handler = (transaction: Y.Transaction): void => {
    if (applying || transaction.origin === origin) return;
    const fixes = lockArbitration(doc, transaction);
    if (fixes.length === 0) return;
    applying = true;
    try {
      doc.transact(() => {
        for (const fix of fixes) deckLocks(doc).set(fix.slideId, fix.lock);
      }, origin);
    } finally {
      applying = false;
    }
  };
  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}
