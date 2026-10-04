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
  CollabActor,
  CollabKind,
  PageCoverImage,
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
  | { ok: true; classroomId: string }
  | { ok: false; reason: AuthorizeRefusal; message?: string };

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
}

export interface ExternalMergeResult {
  /** The content file's blob sha after the merge (becomes `source_sha`). */
  sourceSha: string | null;
  /** Units the 3-way merge could not decide (theirs was taken provisionally). */
  conflicts: number;
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
   * Apply ops id-aware through `ctx.transact`. Deck: an op on a slide a human
   * holds throws CollabHttpError(409, { error: 'slide-locked', slideId, holder }).
   */
  applyOps(ctx: LiveEditContext, ops: Op[]): void | Promise<void>;

  /**
   * An outside push changed this doc's content file while the doc is live or
   * dirty: 3-way merge (base = content at the row's source_sha / pushed
   * commit, ours = live, theirs = content at `sha`) and apply the result
   * id-aware through `ctx.transact`. (A doc that is neither live nor dirty is
   * handled by the server: epoch + 1, reseed on next open.)
   */
  mergeExternal(ctx: LiveEditContext, args: ExternalMergeArgs): Promise<ExternalMergeResult>;

  /** Page only: set or clear the cover (`POST /internal/page/:id/cover`). */
  setCover?(ctx: LiveEditContext, coverImage: PageCoverImage | null): void;

  /**
   * Structural repair after a store (page: unwrap a columnList left with
   * fewer than two columns). Write through `transact`; return true if
   * anything changed. Must be idempotent and a no-op on a valid doc.
   */
  repair?(document: Y.Doc, transact: (fn: (doc: Y.Doc) => void) => void): boolean;
}
