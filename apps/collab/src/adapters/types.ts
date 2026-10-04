/**
 * The contract between the collab server core (auth, persistence, internal
 * HTTP, re-checks — all generic) and one document kind. `page.ts` (slice A)
 * and `deck.ts` (slice D) implement it; `registry.ts` loads them.
 *
 * Ground rules every adapter keeps:
 * - READ FROM A CLONE. Converting a Y.Doc to blocks/deck JSON can delete
 *   elements the schema rejects; on the live doc that reaches every editor.
 *   `cloneDoc` from `@classmoji/page-schema/server` (or `new Y.Doc()` +
 *   `applyUpdate(encodeStateAsUpdate(live))`).
 * - WRITE ID-AWARE, inside `ctx.transact`. Find the element by id and update
 *   just it; insert new elements; delete by index. Never rewrite the whole
 *   fragment/map — a concurrent edit to an untouched block would be lost.
 * - Read the live state you diff against INSIDE the `transact` callback (no
 *   `await` between reading and writing), so nothing lands in between.
 * - Refuse with `CollabHttpError` (status + JSON body); anything else is a 500.
 */
import type * as Y from 'yjs';
import type {
  AgentCursor,
  CollabActor,
  CollabKind,
  CollabMergeResolution,
  PageCoverImage,
  PageCursorPoint,
  SnapshotContent,
} from '@classmoji/collab';

import type { CollabDocRow } from '../store/types.ts';

// ─── Errors ────────────────────────────────────────────────────────────────

/** A refusal the internal HTTP API returns as `status` with `body` as JSON. */
export class CollabHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: { error: string } & Record<string, unknown>) {
    super(body.error);
    this.name = 'CollabHttpError';
    this.status = status;
    this.body = body;
  }
}

// ─── Authorization ─────────────────────────────────────────────────────────

/** Why an adapter refused. Logged; the client only ever sees `forbidden`. */
export type AuthorizeRefusal =
  | 'not-found' // no such doc (or wrong kind, e.g. a slide that is not a DECK)
  | 'forbidden' // role does not allow editing
  | 'classroom-locked' // assertClassroomMutationAllowed refused
  | 'collab-disabled'; // classroom.collab_enabled is false

export type AuthorizeResult =
  | {
      ok: true;
      classroomId: string;
      /** The user's role there (for the audit log). */
      role?: string;
    }
  | {
      ok: false;
      reason: AuthorizeRefusal;
      message?: string;
      /**
       * Set when the user IS a member of the doc's classroom: the refusal is
       * audited as ACCESS_DENIED (non-members cannot be, the audit row needs a
       * classroom role).
       */
      classroomId?: string;
      role?: string;
    };

// ─── Seeding ───────────────────────────────────────────────────────────────

export interface SeedResult {
  /** A NEW Y.Doc holding the content (never a live doc). */
  doc: Y.Doc;
  /** Blob sha of the content file it came from; null for a blank seed. */
  sourceSha: string | null;
  classroomId: string;
}

// ─── Live edits ────────────────────────────────────────────────────────────

/** Where a server-side edit is going. */
export interface DocRef {
  kind: CollabKind;
  docId: string;
  classroomId: string;
  epoch: number;
  /** `roomName(kind, docId, epoch)` */
  room: string;
}

/**
 * A server-side edit on the LIVE doc, through a Hocuspocus direct connection
 * (so it is broadcast, stored and checkpointed like any client edit). The
 * actor shows in awareness as `<name> (agent)` while the edit runs.
 */
export interface LiveEditContext {
  ref: DocRef;
  actor: CollabActor;
  /** The live document. Read it only through a clone, or inside `transact`. */
  document: Y.Doc;
  /** The current `collab_docs` row (null only for a doc never stored). */
  row: CollabDocRow | null;
  /**
   * Run `fn` as ONE Yjs transaction on the live doc, origin
   * `{ source: 'local', context: { actor } }` — the store hook fires and the
   * worker is triggered. Throwing inside `fn` keeps whatever was already
   * written, so validate (on a clone) before the first write.
   */
  transact(fn: (doc: Y.Doc) => void): void;
}

/** `POST /internal/:kind/:id/external`, for a doc that is live or dirty. */
export interface ExternalMergeArgs {
  /** The `sha` from the request: the commit the outside push landed as. */
  sha: string;
  /**
   * The push's `before` commit, when hook-station sends it. The merge base is
   * the content file at `before` when it is readable (so exactly the outside
   * change is diffed), else the blob at the row's `source_sha`. With NO
   * readable base the adapter must not take theirs wholesale: refuse with
   * CollabHttpError(409, { error: 'no-merge-base' }) and keep the live doc.
   */
  before?: string | null;
}

export interface ExternalMergeResult {
  /** The content file's blob sha after the merge (becomes `source_sha`). */
  sourceSha: string | null;
  /** Units the 3-way merge could not decide (theirs was taken provisionally). */
  conflicts: number;
  /**
   * Ids of those units (page: top-level block ids, `__order__` for an order
   * conflict; deck: slide ids). Persisted to collab_docs.last_conflict.
   */
  conflictIds?: string[];
  /**
   * True when theirs is what the live doc already descends from (the file at
   * `sha` IS the blob at source_sha: our own push, a replay, or an older
   * push): nothing was applied.
   */
  noop?: boolean;
}

/** What `applyOps` may report back. */
export interface ApplyOpsResult {
  /** Ids the server minted or kept for inserted items, in op order. */
  insertedIds?: string[];
  /** The last item the ops touched (agent presence: page blockId / deck slide). */
  touchedId?: string;
  /**
   * What the ops inserted or changed and is still there (deletes left out:
   * they have nothing to show), in op order, at most AGENT_TOUCHED_MAX (the
   * last ones). Editors highlight these for a few seconds.
   */
  touchedIds?: string[];
  /** Page: the block whose last text the agent's caret goes to the end of. */
  cursorBlockId?: string;
}

/** `POST /internal/:kind/:id/merge-preview`. */
export interface MergePreviewArgs<K extends CollabKind = CollabKind> {
  /** The content the preview started from (snapshot shape). */
  base: SnapshotContent<K>;
  /** The preview (snapshot shape). */
  theirs: SnapshotContent<K>;
  /** Chooser decisions, `{ id, choose }` per conflict id; absent = none. */
  resolutions?: CollabMergeResolution[] | null;
}

export interface MergePreviewResult {
  /** Conflicts left after `resolutions`; non-empty = NOTHING was applied. */
  conflicts: unknown[];
  autoMerged?: number;
}

// ─── The adapter ───────────────────────────────────────────────────────────

export interface CollabAdapter<K extends CollabKind = CollabKind, Op = unknown> {
  readonly kind: K;

  /**
   * The schema version a client of this kind must send in its provider token
   * (`{ schemaVersion }`); any other is refused with `schema-mismatch`.
   * Page: `SCHEMA_VERSION` from `@classmoji/page-schema`. Deck: the deck
   * doc-shape version slice D defines. Bump it on any change that would make
   * an old client delete or misread content.
   */
  readonly schemaVersion: number;

  /**
   * Today's EDIT rule for this user on this doc, plus the classroom lock
   * (`assertClassroomMutationAllowed`) and `classroom.collab_enabled`.
   * Called on connect and on every 60-s re-check.
   */
  authorize(args: { userId: string; docId: string }): Promise<AuthorizeResult>;

  /** The doc's classroom, with no user check (internal API callers are trusted). */
  locate(docId: string): Promise<{ classroomId: string } | null>;

  /**
   * Build a NEW Y.Doc from git (page: content.json; deck: deck.json, legacy
   * index.html through the existing parser). No collab_docs row exists, or it
   * is a reseed marker; the server inserts the row before the doc is served.
   * Throw `CollabHttpError` with a clear `error` when the source cannot be
   * represented (e.g. a legacy format with no migration path).
   */
  seed(args: { docId: string }): Promise<SeedResult>;

  /** The doc's content in its at-rest JSON shape, read from a clone. */
  snapshot(doc: Y.Doc): SnapshotContent<K>;

  /** Validate an ops payload (`OpsRequest.ops`); throw CollabHttpError(400). */
  parseOps(raw: unknown): Op[];

  /**
   * Guarded ops (`expect`): the ids whose CURRENT item differs from the
   * expected `itemHash` (`@classmoji/collab/hash`) — a missing item counts as
   * changed. The server calls it INSIDE the transaction the ops then run in
   * (first thing in the adapter's first `ctx.transact`), so a non-empty answer
   * means 409 `block-changed` with nothing applied. Hash the same normalized
   * form `/snapshot` returns (page: a yDocToBlocks block; deck: the slide
   * entry). An adapter without it refuses guarded ops (501).
   */
  checkExpect?(doc: Y.Doc, expect: Record<string, string>): string[];

  /**
   * Apply ops id-aware through `ctx.transact`. Deck: an op on a slide a human
   * holds throws CollabHttpError(409, { error: 'slide-locked', slideId, holder }).
   */
  applyOps(ctx: LiveEditContext, ops: Op[]): void | ApplyOpsResult | Promise<void | ApplyOpsResult>;

  /**
   * An outside push changed this doc's content file while the doc is live or
   * dirty: 3-way merge (base = content at the row's source_sha / pushed
   * commit, ours = live, theirs = content at `sha`) and apply the result
   * id-aware through `ctx.transact`. (A doc that is neither live nor dirty is
   * handled by the server: epoch + 1, reseed on next open.)
   */
  mergeExternal(ctx: LiveEditContext, args: ExternalMergeArgs): Promise<ExternalMergeResult>;

  /**
   * Merge a preview into the live doc: base/theirs as sent, ours = the live
   * doc read INSIDE `ctx.transact`. Conflicts (after resolutions) → return
   * them and write nothing; otherwise apply live → merged id-aware in that
   * one transaction. No op cap (the cap is for external requests). The route
   * answers 501 when an adapter has no `mergePreview`.
   */
  mergePreview?(
    ctx: LiveEditContext,
    args: MergePreviewArgs<K>
  ): MergePreviewResult | Promise<MergePreviewResult>;

  /**
   * The blob sha of the doc's content file in git now (null = no file). When
   * present, opening a CLEAN row whose source_sha differs reseeds it (epoch +
   * 1, refusal `stale-epoch`) instead of serving content git has moved past.
   * A failed read is logged and the row is served.
   */
  currentSourceSha?(docId: string): Promise<string | null>;

  /**
   * Called once each time a document is loaded into memory (afterLoadDocument),
   * before anyone edits it: start per-document machinery (deck: lock
   * arbitration and disconnect cleanup, so a restarted server drops stale locks).
   */
  attach?(document: Y.Doc): void;

  /**
   * Root shared types (by name) whose changes are EPHEMERAL: a transaction
   * that touches only these (deck: `locks` claims and heartbeats) is not an
   * edit — no version bump, no worker trigger, no co-author. Default: none
   * for pages, `['locks']` for decks.
   */
  readonly ephemeralRoots?: readonly string[];

  /**
   * Page only: an agent caret in the live doc (`cursor` as y-prosemirror's
   * cursor plugin reads it), or null when the block is gone. `scope:
   * 'subtree'` measures the block with its children (the end of what an op
   * wrote); `'own'` only the block's own text (what an agent points at).
   */
  cursorAt?(
    doc: Y.Doc,
    point: PageCursorPoint,
    selectTo?: Partial<PageCursorPoint> | null,
    scope?: 'own' | 'subtree'
  ): AgentCursor | null;

  /** Whether the live doc has this block / slide (anywhere in the tree). */
  hasItem?(doc: Y.Doc, id: string): boolean;

  /** Page only: set or clear the cover (`POST /internal/page/:id/cover`). */
  setCover?(ctx: LiveEditContext, coverImage: PageCoverImage | null): void;

  /**
   * Structural repair after a store (page: unwrap a columnList left with
   * fewer than two columns). Write through `transact`; return true if
   * anything changed. Must be idempotent and a no-op on a valid doc.
   */
  repair?(document: Y.Doc, transact: (fn: (doc: Y.Doc) => void) => void): boolean;
}
