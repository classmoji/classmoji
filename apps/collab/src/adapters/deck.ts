/**
 * The DECK adapter: reveal.js decks (`slides/<slug>/deck.json`, legacy
 * `index.html` through the existing parser).
 *
 * Edit rule: today's `assertSlideAccess` edit semantics — OWNER or TEACHER on
 * any deck, an ASSISTANT on decks they created or decks with
 * `allow_team_edit` (highest role wins) — plus the classroom mutation gate
 * (`canMutateClassroom`) and `classroom.collab_enabled`.
 *
 * Doc shape and conversion: `@classmoji/collab` deck module. Ops: the
 * `deckOps.ts` vocabulary, validated and applied by `applyDeckOps` on the
 * live deck, then written back id-aware (`syncDeckIntoYDoc`: only the slides
 * that changed, order keys only for slides that moved).
 *
 * Locks are arbitrated here, server-side, once the adapter has seen a live
 * document (`attach`): the lowest-clientID rule for simultaneous claims, the
 * locks of a client that disconnected released, and locks idle past
 * LOCK_EXPIRE_IDLE_MS cleared. Those writes skip the store hooks — a lock is
 * presence, not content, and never worth a checkpoint.
 */
import type * as Y from 'yjs';
import type { Role } from '@prisma/client';
import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/services';
import { canMutateClassroom } from '@classmoji/auth/predicates';
import { findClassroomRole } from '@classmoji/auth/classroom-role';
import {
  DeckOpError,
  DeckParseError,
  SlideHtmlError,
  applyDeckOps,
  deckOpsPayloadSchema,
  indexResolutions,
  isDeckSlide,
  PreviewResolutionError,
  loadDeck,
  merge3Units,
  parseDeckHtml,
  slideService,
  type DeckJson,
  type DeckMergeConflict,
  type DeckOp,
  type DeckSlide,
  type MergeChoice,
  type MergeResolution,
} from '@classmoji/services/slides';
import {
  DECK_SCHEMA_VERSION,
  LOCK_EXPIRE_IDLE_MS,
  LockActivity,
  allLocks,
  cloneYDoc,
  deckToYDoc,
  expireLocks,
  installLockArbiter,
  installLockGuard,
  LOCK_DISCONNECT_GRACE_MS,
  markDisconnected,
  markReconnected,
  lockState,
  syncDeckIntoYDoc,
  yDocToDeck,
  type DeckSnapshotContent,
  type SlideLock,
} from '@classmoji/collab';

import { itemHash } from '@classmoji/collab/hash';

import {
  CollabHttpError,
  type ApplyOpsResult,
  type AuthorizeResult,
  type CollabAdapter,
  type ExternalMergeResult,
  type LiveEditContext,
  type SeedResult,
} from './types.ts';

/** The slide row the adapter needs (with its classroom and git organization). */
export interface DeckRecord {
  id: string;
  title: string;
  kind?: string | null;
  content_path: string;
  classroom_id: string;
  created_by?: string | null;
  allow_team_edit?: boolean | null;
  classroom: {
    id: string;
    status: string;
    collab_enabled: boolean;
    content_repo: string;
    git_organization?: { login: string; [key: string]: unknown } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type LoadedDeck = Awaited<ReturnType<typeof loadDeck>>;

/** I/O the adapter does; swapped out in tests. */
export interface DeckAdapterDeps {
  findSlide(slideId: string): Promise<DeckRecord | null>;
  findRole(userId: string, classroomId: string): Promise<Role | null>;
  /** deck.json (or legacy index.html, parsed) on the default branch, or at `ref`. */
  loadDeck(slide: DeckRecord, options: { ref?: string }): Promise<LoadedDeck>;
  /** A blob's text by sha, null when it does not exist. */
  readBlob(slide: DeckRecord, sha: string): Promise<string | null>;
  now(): number;
}

export const defaultDeckAdapterDeps: DeckAdapterDeps = {
  async findSlide(slideId) {
    return (await getPrisma().slide.findUnique({
      where: { id: slideId },
      include: { classroom: { include: { git_organization: true } } },
    })) as unknown as DeckRecord | null;
  },
  findRole(userId, classroomId) {
    return findClassroomRole({ userId, classroomId });
  },
  loadDeck(slide, { ref }) {
    return loadDeck(slide as never, { skipCache: true, ...(ref ? { ref } : {}) });
  },
  async readBlob(slide, sha) {
    const blob = await ContentService.getBlobContent({
      gitOrganization: slide.classroom.git_organization as never,
      repo: slide.classroom.content_repo,
      sha,
    });
    return blob?.content ?? null;
  },
  now: () => Date.now(),
};

/**
 * `assertSlideAccess`'s edit rule (packages/auth/src/server.ts), for a user id
 * instead of a request: OWNER/TEACHER on any deck; ASSISTANT on decks they
 * created or decks with allow_team_edit.
 */
export function canEditDeck(
  role: Role | null,
  slide: Pick<DeckRecord, 'created_by' | 'allow_team_edit'>,
  userId: string
): boolean {
  if (role === 'OWNER' || role === 'TEACHER') return true;
  if (role === 'ASSISTANT') return slide.created_by === userId || slide.allow_team_edit === true;
  return false;
}

/** Store-skipping origin for the server's own lock bookkeeping. */
export const LOCK_ORIGIN = { source: 'local', skipStoreHooks: true, context: { locks: true } };

/** Origin of the guard's corrections of edits to held slides (stored like any edit). */
export const GUARD_ORIGIN = { source: 'local', context: { lockGuard: true } };

/**
 * The Yjs clientIDs behind a transaction from a browser connection (its
 * awareness clients and whoever inserted structs), or null for the server's
 * own writes (agents, merges, locks), which are checked where they are made.
 */
export function writersOf(document: Y.Doc, tr: Y.Transaction): Set<number> | null {
  const origin = tr.origin as { source?: string; connection?: unknown } | null;
  if (!origin || origin.source !== 'connection') return null;
  const out = new Set<number>();
  const clients = (
    document as Y.Doc & { getClients?: (connection: unknown) => Set<number> }
  ).getClients?.(origin.connection);
  for (const id of clients ?? []) out.add(id);
  for (const [client, clock] of tr.afterState) {
    if (clock > (tr.beforeState.get(client) ?? 0)) out.add(client);
  }
  return out;
}

/** How often the server sweeps a live deck's locks. */
export const LOCK_SWEEP_MS = 15_000;

/** Hocuspocus documents carry their awareness. */
type WithAwareness = Y.Doc & {
  awareness?: {
    getStates(): Map<number, unknown>;
    on(event: 'update', cb: (change: { added?: number[]; removed: number[] }) => void): void;
    off(event: 'update', cb: (change: { added?: number[]; removed: number[] }) => void): void;
  };
};

function connectedClients(doc: Y.Doc): Set<number> | undefined {
  const awareness = (doc as WithAwareness).awareness;
  return awareness ? new Set(awareness.getStates().keys()) : undefined;
}

/** Ids an op writes content of (a delete of a stack takes its children). */
function touchedSlideIds(deck: DeckJson, ops: DeckOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.op === 'update') out.add(op.id);
    if (op.op === 'delete') {
      out.add(op.id);
      const slide = deck.slides.find(s => s.id === op.id);
      for (const child of slide?.children ?? []) out.add(child.id);
    }
  }
  return [...out];
}

/** deck.json text, or legacy index.html text → deck; null when neither parses. */
function parseDeckText(text: string | null): DeckJson | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as DeckJson;
    if (parsed?.version === 1 && Array.isArray(parsed.slides)) return parsed;
  } catch {
    // not JSON — maybe the legacy index.html the doc was seeded from
  }
  try {
    return parseDeckHtml(text).deck;
  } catch {
    return null;
  }
}

function flattenSlides(deck: DeckJson): Map<string, DeckSlide> {
  const out = new Map<string, DeckSlide>();
  for (const slide of deck.slides) {
    out.set(slide.id, slide);
    for (const child of slide.children ?? []) out.set(child.id, child);
  }
  return out;
}

/** What a lock protects: the slide's html (moves and attributes are free). */
function contentKey(slide: DeckSlide): string {
  return JSON.stringify(slide.html ?? null);
}

/**
 * In `merged`, give every slide a person holds its live (`ours`) html back.
 * Returns how many slides that kept.
 */
function keepHeldHtml(ours: DeckJson, merged: DeckJson, locks: Map<string, unknown>): number {
  const live = flattenSlides(ours);
  const next = flattenSlides(merged);
  let kept = 0;
  for (const slideId of locks.keys()) {
    const mine = live.get(slideId);
    const theirs = next.get(slideId);
    if (!mine || !theirs || mine.children || theirs.children) continue;
    if ((theirs.html ?? '') !== (mine.html ?? '')) {
      theirs.html = mine.html;
      kept++;
    }
  }
  return kept;
}

/**
 * From applyDeckOps' report: the ids minted for inserts, in op order (a new
 * stack followed by its children), and the last slide the ops touched (the
 * agent's presence shows there).
 */
export function opsOutcome(applied: Array<Record<string, unknown>>): ApplyOpsResult {
  const insertedIds: string[] = [];
  let touchedId: string | undefined;
  for (const entry of applied) {
    if (entry.op === 'insert' && Array.isArray(entry.ids)) {
      const children = (entry.children ?? {}) as Record<string, string[]>;
      for (const id of entry.ids as string[]) {
        insertedIds.push(id);
        for (const child of children[id] ?? []) insertedIds.push(child);
        touchedId = id;
      }
    } else if (typeof entry.id === 'string') {
      touchedId = entry.id;
    }
  }
  return { ...(insertedIds.length ? { insertedIds } : {}), ...(touchedId ? { touchedId } : {}) };
}

function asHttpError(err: unknown): never {
  if (err instanceof DeckOpError || err instanceof SlideHtmlError) {
    throw new CollabHttpError(422, { error: 'invalid-op', message: err.message });
  }
  throw err;
}

export class DeckAdapter implements CollabAdapter<'deck', DeckOp> {
  readonly kind = 'deck' as const;
  readonly schemaVersion = DECK_SCHEMA_VERSION;
  private readonly deps: DeckAdapterDeps;
  private readonly attached = new WeakMap<Y.Doc, { activity: LockActivity }>();

  constructor(deps: DeckAdapterDeps = defaultDeckAdapterDeps) {
    this.deps = deps;
  }

  private async mustFindSlide(slideId: string): Promise<DeckRecord> {
    const slide = await this.deps.findSlide(slideId);
    if (!slide || !isDeckSlide(slide)) throw new CollabHttpError(404, { error: 'not-found' });
    return slide;
  }

  async authorize({ userId, docId }: { userId: string; docId: string }): Promise<AuthorizeResult> {
    const slide = await this.deps.findSlide(docId);
    if (!slide || !isDeckSlide(slide)) return { ok: false, reason: 'not-found' };
    const role = await this.deps.findRole(userId, slide.classroom_id);
    // A member's refusal is audited (ACCESS_DENIED needs their role).
    const member = role ? { classroomId: slide.classroom_id, role } : {};
    if (!slide.classroom?.collab_enabled) {
      return { ok: false, reason: 'collab-disabled', ...member };
    }
    if (!canEditDeck(role, slide, userId)) return { ok: false, reason: 'forbidden', ...member };
    if (!canMutateClassroom({ status: slide.classroom.status as never, role: role as Role })) {
      return { ok: false, reason: 'classroom-locked', ...member };
    }
    return { ok: true, classroomId: slide.classroom_id, role: role as string };
  }

  async locate(docId: string) {
    const slide = await this.deps.findSlide(docId);
    return slide && isDeckSlide(slide) ? { classroomId: slide.classroom_id } : null;
  }

  async seed({ docId }: { docId: string }): Promise<SeedResult> {
    const slide = await this.mustFindSlide(docId);
    let loaded: LoadedDeck;
    try {
      loaded = await this.deps.loadDeck(slide, {});
    } catch (err) {
      if (err instanceof DeckParseError) {
        throw new CollabHttpError(422, {
          error: 'unparseable-deck',
          message: `deck ${docId} cannot be read: ${err.message}`,
        });
      }
      if (err instanceof Error && err.message.startsWith('Slide content not found')) {
        throw new CollabHttpError(409, { error: 'content-missing', message: err.message });
      }
      throw err;
    }
    return {
      doc: deckToYDoc(loaded.deck),
      sourceSha: loaded.sha,
      classroomId: slide.classroom_id,
    };
  }

  snapshot(doc: Y.Doc): DeckSnapshotContent {
    return yDocToDeck(cloneYDoc(doc));
  }

  parseOps(raw: unknown): DeckOp[] {
    const parsed = deckOpsPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CollabHttpError(400, { error: 'invalid-ops', issues: parsed.error.issues });
    }
    return parsed.data;
  }

  /** The live slide locks that block a server-side write. */
  liveLocks(doc: Y.Doc): Map<string, SlideLock> {
    const connected = connectedClients(doc);
    const activity = this.attached.get(doc)?.activity;
    const now = this.deps.now();
    const out = new Map<string, SlideLock>();
    for (const [slideId, lock] of allLocks(doc)) {
      const state = lockState(lock, -1, {
        now,
        connected,
        idleMs: activity?.idleMs(slideId, now),
      });
      if (state === 'held') out.set(slideId, lock);
    }
    return out;
  }

  /**
   * Guarded ops: the slide ids whose current entry (as `/snapshot` returns it,
   * a stack with its children) no longer hashes to what the caller read.
   */
  checkExpect(doc: Y.Doc, expect: Record<string, string>): string[] {
    const slides = flattenSlides(yDocToDeck(doc));
    return Object.entries(expect)
      .filter(([id, hash]) => {
        const slide = slides.get(id);
        return !slide || itemHash(slide) !== hash;
      })
      .map(([id]) => id);
  }

  applyOps(ctx: LiveEditContext, ops: DeckOp[]): ApplyOpsResult {
    this.attach(ctx.document);
    const result: ApplyOpsResult = {};
    ctx.transact(doc => {
      const current = yDocToDeck(doc);
      const locks = this.liveLocks(doc);
      for (const slideId of touchedSlideIds(current, ops)) {
        const holder = locks.get(slideId);
        if (holder) {
          throw new CollabHttpError(409, { error: 'slide-locked', slideId, holder });
        }
      }
      let applied: ReturnType<typeof applyDeckOps>;
      try {
        applied = applyDeckOps(current, ops, {
          starterCustomCss: slideService.STARTER_CUSTOM_CSS,
        });
      } catch (err) {
        asHttpError(err);
      }
      syncDeckIntoYDoc(doc, applied.deck);
      Object.assign(result, opsOutcome(applied.applied));
    });
    return result;
  }

  async mergeExternal(
    ctx: LiveEditContext,
    { sha, before }: { sha: string; before?: string | null }
  ): Promise<ExternalMergeResult> {
    this.attach(ctx.document);
    const slide = await this.mustFindSlide(ctx.ref.docId);

    // theirs: the deck at the pushed commit.
    let theirsLoaded: LoadedDeck;
    try {
      theirsLoaded = await this.deps.loadDeck(slide, { ref: sha });
    } catch (err) {
      if (err instanceof DeckParseError) {
        throw new CollabHttpError(422, { error: 'unparseable-deck', message: err.message });
      }
      throw err;
    }
    // What the live doc already descends from (our own push, a replay, an
    // older push): nothing to merge.
    if (ctx.row?.source_sha && theirsLoaded.sha === ctx.row.source_sha) {
      return { sourceSha: ctx.row.source_sha, conflicts: 0, noop: true };
    }

    // base: the deck at the push's `before` (exactly the outside change),
    // else what the live doc descends from (seeded from, or last pushed).
    let base: DeckJson | null = null;
    if (before) {
      try {
        base = (await this.deps.loadDeck(slide, { ref: before })).deck;
      } catch {
        base = null;
      }
    }
    if (!base && ctx.row?.source_sha) {
      base = parseDeckText(await this.deps.readBlob(slide, ctx.row.source_sha));
    }
    if (!base && ctx.row?.pushed_commit) {
      try {
        base = (await this.deps.loadDeck(slide, { ref: ctx.row.pushed_commit })).deck;
      } catch {
        base = null;
      }
    }
    if (!base) {
      // Merging against a made-up base would read every live-only change as
      // "the push deleted it". Refuse and keep the live doc.
      throw new CollabHttpError(409, {
        error: 'no-merge-base',
        message: `deck ${ctx.ref.docId}: no readable base for the outside push`,
      });
    }
    const mergeBase = base;
    let conflicts = 0;
    ctx.transact(doc => {
      const ours = yDocToDeck(doc);
      const locks = this.liveLocks(doc);
      const first = merge3Units(mergeBase, ours, theirsLoaded.deck);
      conflicts = first.conflicts.length;
      let merged = first.merged;
      if (conflicts > 0) {
        // Conflicted slides someone is editing keep the live side; the rest
        // take the push (provisional theirs).
        const resolutions: Record<string, MergeChoice> = {};
        for (const conflict of first.conflicts) {
          resolutions[conflict.id] = locks.has(conflict.id) ? 'ours' : 'theirs';
        }
        merged = merge3Units(mergeBase, ours, theirsLoaded.deck, { resolutions }).merged;
      }
      // A slide a person holds keeps its live html even when only the push
      // changed it: their next keystroke would otherwise overwrite the push
      // anyway, or worse, the push would replace what they see mid-edit.
      if (locks.size > 0) {
        conflicts += keepHeldHtml(ours, merged, locks);
      }
      syncDeckIntoYDoc(doc, merged);
    });
    return { sourceSha: theirsLoaded.sha, conflicts };
  }

  async currentSourceSha(docId: string): Promise<string | null> {
    const slide = await this.mustFindSlide(docId);
    try {
      return (await this.deps.loadDeck(slide, {})).sha;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Slide content not found')) return null;
      throw err;
    }
  }

  /**
   * `POST /internal/deck/:id/merge-preview`: 3-way merge INSIDE the live
   * transaction — base = where the preview branched, ours = the live deck,
   * theirs = the preview — so nothing typed between a read and the write is
   * lost. Conflicts left after `resolutions` (the chooser's `{id, choose}`
   * list) are returned and nothing is applied; otherwise the merged deck is
   * written id-aware. A slide whose content the merge would change while a
   * person holds it is refused with 409 slide-locked, like an op.
   */
  mergePreview(
    ctx: LiveEditContext,
    {
      base,
      theirs,
      resolutions,
    }: { base: DeckJson; theirs: DeckJson; resolutions?: MergeResolution[] | null }
  ): { conflicts: DeckMergeConflict[] } {
    this.attach(ctx.document);
    let chosen: Record<string, MergeChoice> = {};
    if (resolutions && resolutions.length > 0) {
      try {
        chosen = indexResolutions(resolutions);
      } catch (err) {
        if (err instanceof PreviewResolutionError) {
          throw new CollabHttpError(400, { error: 'invalid-resolutions', message: err.message });
        }
        throw err;
      }
    }
    let conflicts: DeckMergeConflict[] = [];
    ctx.transact(doc => {
      const ours = yDocToDeck(doc);
      const merge = merge3Units(base, ours, theirs, { resolutions: chosen });
      if (merge.conflicts.length > 0) {
        conflicts = merge.conflicts;
        return;
      }
      const locks = this.liveLocks(doc);
      if (locks.size > 0) {
        const before = flattenSlides(ours);
        const after = flattenSlides(merge.merged);
        for (const [slideId, holder] of locks) {
          const prev = before.get(slideId);
          if (!prev) continue;
          const next = after.get(slideId);
          if (!next || contentKey(prev) !== contentKey(next)) {
            throw new CollabHttpError(409, { error: 'slide-locked', slideId, holder });
          }
        }
      }
      syncDeckIntoYDoc(doc, merge.merged);
    });
    return { conflicts };
  }

  /**
   * Nothing structural to repair in a deck; used as the "a live document
   * exists" signal to start lock arbitration on it.
   */
  repair(document: Y.Doc): boolean {
    this.attach(document);
    return false;
  }

  /**
   * Start lock bookkeeping on a live document (idempotent): the arbiter, the
   * release of a disconnected client's locks, and a periodic sweep that also
   * clears locks left in a stored state by clients long gone. Stops when the
   * document is destroyed (Hocuspocus unloads it).
   */
  attach(document: Y.Doc): void {
    if (this.attached.has(document)) return;
    const activity = new LockActivity(document, this.deps.now);
    this.attached.set(document, { activity });
    const uninstall = installLockArbiter(document, LOCK_ORIGIN);
    // Peers that skip the client checks: an edit to a slide someone else holds
    // is undone here, in the same tick.
    const uninstallGuard = installLockGuard(document, {
      origin: GUARD_ORIGIN,
      writersOf: tr => writersOf(document, tr),
      onRevert: (ids, writers) =>
        console.warn(
          `[collab] undid a change to held slide(s) ${ids.join(', ')} by client(s) ${[...writers].join(', ')}`
        ),
    });

    const awareness = (document as WithAwareness).awareness;
    const graceTimers = new Set<ReturnType<typeof setTimeout>>();
    const onAwareness = ({ added, removed }: { added?: number[]; removed: number[] }) => {
      // Back within the grace: the lock is theirs again.
      if (added && added.length > 0) markReconnected(document, added, LOCK_ORIGIN);
      if (removed.length > 0) {
        // Gone: keep their slide for the grace period, then sweep it.
        markDisconnected(document, removed, this.deps.now(), LOCK_ORIGIN);
        const timer = setTimeout(() => {
          graceTimers.delete(timer);
          sweep();
        }, LOCK_DISCONNECT_GRACE_MS + 250);
        (timer as { unref?: () => void }).unref?.();
        graceTimers.add(timer);
      }
    };
    awareness?.on('update', onAwareness);

    const sweep = () =>
      expireLocks(
        document,
        {
          now: this.deps.now(),
          activity,
          maxIdleMs: LOCK_EXPIRE_IDLE_MS,
          connected: connectedClients(document),
        },
        LOCK_ORIGIN
      );
    sweep();
    const timer = setInterval(sweep, LOCK_SWEEP_MS);
    (timer as { unref?: () => void }).unref?.();

    document.once('destroy', () => {
      clearInterval(timer);
      for (const grace of graceTimers) clearTimeout(grace);
      uninstall();
      uninstallGuard();
      awareness?.off('update', onAwareness);
      activity.destroy();
      this.attached.delete(document);
    });
  }
}

export function createDeckAdapter(deps: DeckAdapterDeps = defaultDeckAdapterDeps): DeckAdapter {
  return new DeckAdapter(deps);
}
