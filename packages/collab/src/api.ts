/**
 * Contracts between the collab server, the apps, MCP, hook-station and the
 * git worker. Types only (plus a few constants), so every side can import
 * this without pulling in a runtime.
 */
import type { DeckJson } from '@classmoji/services/slides';

import type { CollabKind } from './rooms.ts';

// ─── Internal HTTP API (`${COLLAB_URL}/internal`, header x-collab-secret) ───

export const COLLAB_SECRET_HEADER = 'x-collab-secret';
// The dev secret and env resolution are server-only: `@classmoji/collab/env`.
export const COLLAB_INTERNAL_PREFIX = '/internal';

/** Who is making a server-side edit; shown in awareness as `<name> (agent)`. */
export interface CollabActor {
  userId: string;
  name: string;
  /**
   * The agent session making it (MCP: the client's `Mcp-Session-Id`). Each
   * session of a user is its own presence, colour and label; without one, all
   * of a user's sessions share one. A key only (`normalizeAgentSession`).
   */
  agentSession?: string;
}

export interface PageCoverImage {
  url: string;
  position: number;
}

/** Page content as content.json holds it. */
export interface PageSnapshotContent {
  blocks: unknown[];
  coverImage: PageCoverImage | null;
}

export type DeckSnapshotContent = DeckJson;

export type SnapshotContent<K extends CollabKind> = K extends 'page'
  ? PageSnapshotContent
  : DeckSnapshotContent;

/** `GET /internal/:kind/:id/snapshot` — read from a clone; loads from DB/git if not live. */
export interface SnapshotResponse<K extends CollabKind = CollabKind> {
  epoch: number;
  version: number;
  live: boolean;
  content: SnapshotContent<K>;
  /** ISO time of the last checkpoint run covering this doc (null: none yet). */
  lastCheckpointAt: string | null;
  /** Failure of that run (null when it succeeded). */
  lastCheckpointError: string | null;
}

/**
 * `POST /internal/:kind/:id/ops`. Page ops use the `pageBlockOpSchema`
 * vocabulary (packages/services pageContent.service.ts); deck ops the
 * `deckOps.ts` vocabulary. Applied id-aware, never as a whole-doc rewrite.
 */
export interface OpsRequest<Op = unknown> {
  ops: Op[];
  actor: CollabActor;
  /**
   * Guard: `{ [id]: itemHash(item) }` for the blocks/slides the ops were
   * planned from (as `/snapshot` returned them). Any mismatch → 409
   * `{ error: 'block-changed', changedIds }`, nothing applied.
   */
  expect?: Record<string, string>;
}

export interface OpsResponse {
  epoch: number;
  version: number;
  /** Ids minted/kept for inserted items, in op order. */
  insertedIds?: string[];
}

/** A point in a page: a block, then a character offset or its start/end. */
export interface PageCursorPoint {
  blockId: string;
  /** Characters into the block's own text (clamped); wins over `at`. */
  offset?: number;
  /** Default `end`. */
  at?: 'start' | 'end';
}

/**
 * `POST /internal/:kind/:id/cursor` — place an agent's presence without
 * changing content. Page: `page` (a caret, or a selection to `selectTo`);
 * deck: `slide` (the slide id it points at), and optionally where on it its
 * pointer arrow sits — `x`, `y` in slide coordinates (DECK_SLIDE_SIZE,
 * clamped; the centre when absent). `{ shown: false }` when nobody has the
 * doc open (there is no one to show it to); 404 `not-found` for an unknown
 * block or slide.
 */
export interface CursorRequest {
  actor: CollabActor;
  page?: PageCursorPoint & { selectTo?: Partial<PageCursorPoint> };
  slide?: string;
  x?: number;
  y?: number;
}

export interface CursorResponse {
  shown: boolean;
}

/** 409 from a guarded `/ops`. */
export interface BlockChangedError {
  error: 'block-changed';
  changedIds: string[];
}

/**
 * Stateless messages collab broadcasts to a room (`provider.on('stateless')`,
 * payload is this JSON):
 * - `checkpoint`: the worker finished a run that covered this doc
 *   (`POST /internal/checkpoint-result`);
 * - `page-meta` / `deck-meta`: title (and page width) changed outside the
 *   document (`POST /internal/:kind/:id/meta-changed`);
 * - `preview-changed`: a preview of this doc was created, updated or
 *   discarded (`POST /internal/:kind/:id/preview-changed`) — refresh the banner.
 */
export type CollabStatelessMessage =
  | {
      type: 'checkpoint';
      commit?: string;
      at: string;
      error?: string;
      /**
       * The Save-version requests (`CheckpointRequest.requestId`) this run
       * consumed for this doc. Only the run that consumed a request lists
       * it; routine debounced runs never carry any.
       */
      requestIds?: string[];
      /** With `requestIds`: the run found nothing to push for this doc. */
      alreadySaved?: true;
      /**
       * The buffer still holds edits this run did not push (typed while it
       * committed, or the doc was not saved). Absent = false.
       */
      editsSince?: boolean;
    }
  | { type: 'page-meta'; title?: string; width?: number }
  | { type: 'deck-meta'; title?: string }
  | { type: 'preview-changed' };

/** `POST /internal/checkpoint-result` (from the worker; best effort). */
export interface CheckpointResultRequest {
  classroomId: string;
  docs: {
    kind: CollabKind;
    id: string;
    commit?: string;
    at: string;
    error?: string;
    /** Save-version requests this run consumed for this doc. */
    requestIds?: string[];
    alreadySaved?: true;
    editsSince?: boolean;
  }[];
}

/** `POST /internal/:kind/:id/meta-changed`. */
export interface MetaChangedRequest {
  title?: string;
  /** Pages only (`Page.width`). */
  width?: number;
}

/** 409 from a deck op on a slide a human holds. */
export interface SlideLockedError {
  error: 'slide-locked';
  slideId: string;
  holder: SlideLock;
}

/** `POST /internal/page/:id/cover`. */
export interface CoverRequest {
  coverImage: PageCoverImage | null;
  actor: CollabActor;
}

/** `POST /internal/:kind/:id/external` — a push made outside classmoji landed. */
export interface ExternalRequest {
  sha: string;
}

/** One chooser decision: keep `ours` (live) or `theirs` (the preview) for a conflict id. */
export interface CollabMergeResolution {
  id: string;
  choose: 'ours' | 'theirs';
}

/**
 * `POST /internal/:kind/:id/merge-preview`: base/theirs in the snapshot shape.
 * 200 `{ applied: true, version }`; conflicts left after `resolutions` → 409
 * `{ error: 'conflicts', conflicts, autoMerged? }` with nothing applied.
 */
export interface MergePreviewRequest<K extends CollabKind = CollabKind> {
  base: SnapshotContent<K>;
  theirs: SnapshotContent<K>;
  resolutions?: CollabMergeResolution[];
  actor: CollabActor;
}

export interface MergePreviewResponse {
  applied: true;
  version: number;
}

/**
 * `POST /internal/classroom/:id/flag` `{ enabled }`: the classroom's
 * collab_enabled flipped. Every open room closes (4409) and every clean row
 * is reseeded (epoch + 1); with `enabled: false` a final checkpoint runs.
 */
export interface FlagRequest {
  enabled: boolean;
}

/** `POST /internal/:kind/:id/checkpoint` — "Save version": checkpoint now. */
export interface CheckpointRequest {
  message?: string;
  actor: CollabActor;
  /**
   * Client-generated id (`CHECKPOINT_REQUEST_ID`), echoed in the reply and in
   * the `checkpoint` broadcast of the run that consumed it. Absent: collab
   * mints one.
   */
  requestId?: string;
  /**
   * A checkpoint asked for only to push what is buffered (e.g. before
   * presenting): the requester is NOT added as a co-author. People who
   * edited are still credited.
   */
  flushOnly?: boolean;
}

/** A Save-version request id: 8–64 of `[A-Za-z0-9_-]`. */
export const CHECKPOINT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The `/checkpoint` reply. `alreadySaved`: the doc had nothing unpushed —
 * nothing was triggered and no broadcast follows. Otherwise the answer is
 * the `checkpoint` broadcast whose `requestIds` holds `requestId`.
 */
export interface CheckpointResponse {
  version: number;
  requestId: string;
  alreadySaved?: true;
}

/** A Save-version request riding a checkpoint payload. */
export interface CheckpointRequestRef {
  id: string;
  kind: CollabKind;
  docId: string;
}

/** `POST /internal/:kind/:id/reset` — drop the live room and reseed from git. */
export interface ResetRequest {
  actor: CollabActor;
  /** Required when the doc holds unpushed edits: they are discarded. */
  discard?: boolean;
}

/** Audit `resource_type` of a doc kind (the same as the MCP tools write). */
export const COLLAB_AUDIT_RESOURCE: Record<CollabKind, 'PAGES' | 'SLIDES'> = {
  page: 'PAGES',
  deck: 'SLIDES',
};

/** `POST /internal/:kind/:id/close` — checkpoint now, then close every connection. */
export interface CloseRequest {
  reason: 'flag-off' | 'deleted' | (string & {});
}

export interface InternalErrorResponse {
  error: string;
}

// ─── Provider auth ──────────────────────────────────────────────────────────

/** The provider `token` (JSON). Not a secret: auth is the session cookie. */
export interface CollabTokenPayload {
  schemaVersion: number;
}

/**
 * Why the server refused a connection (the provider's auth-failure reason):
 * - `stale-epoch`: the room was reseeded — reload the route.
 * - `schema-mismatch`: the editor bundle is out of date — reload to update.
 * - `forbidden`: no edit access (signed out, role, classroom lock, flag off).
 * - `legacy-html`: the page is still legacy HTML; it cannot be edited live.
 * - `unavailable`: an unexpected server error (DB blip, git read failed) —
 *   "try again" + Reload, never a permanent read-only state.
 */
export type CollabRejectReason =
  | 'stale-epoch'
  | 'schema-mismatch'
  | 'forbidden'
  | 'legacy-html'
  | 'unavailable';

export const COLLAB_REJECT_REASONS: readonly CollabRejectReason[] = [
  'stale-epoch',
  'schema-mismatch',
  'forbidden',
  'legacy-html',
  'unavailable',
];

export function isCollabRejectReason(value: unknown): value is CollabRejectReason {
  return COLLAB_REJECT_REASONS.includes(value as CollabRejectReason);
}

/** Socket close: access revoked by the 60-s re-check → read-only + Reload. */
export const COLLAB_CLOSE_FORBIDDEN = 4403;

/**
 * Socket close: the room is gone or moved (`/close` on flag off / delete, a
 * reseed, a store refused for a bumped epoch) → reload the route. The close
 * reason string is `reload` or the refusal reason (`stale-epoch`).
 */
export const COLLAB_CLOSE_RELOAD = 4409;

/** Older names for the same codes. */
export const COLLAB_FORBIDDEN_CLOSE_CODE = COLLAB_CLOSE_FORBIDDEN;
export const COLLAB_RELOAD_CLOSE_CODE = COLLAB_CLOSE_RELOAD;

/** What `onAuthenticate` puts in the connection context. */
export interface CollabConnectionContext {
  userId: string;
  name: string;
  sessionToken: string;
  classroomId: string;
  kind: CollabKind;
  docId: string;
  /** The user's classroom role (audit rows). */
  role?: string;
}

// ─── Loader data for a collab-enabled editor ────────────────────────────────

export interface CollabUser {
  id: string;
  name: string;
  color: string;
}

export interface CollabLoaderData {
  wsUrl: string;
  room: string;
  epoch: number;
  schemaVersion: number;
  user: CollabUser;
}

// ─── Deck locks (Y.Map `locks`, keyed by slide id) ──────────────────────────

export interface SlideLock {
  userId: string;
  name: string;
  color: string;
  /** Yjs clientID of the holder's doc. */
  clientId: number;
  /** ms since epoch the lock was taken. */
  since: number;
  /** ms since epoch of the holder's last edit/keepalive. */
  lastActive: number;
}

// ─── Git worker (Trigger.dev task) ──────────────────────────────────────────

export const CONTENT_CHECKPOINT_TASK = 'content-checkpoint';
export const CONTENT_CHECKPOINT_QUEUE = 'content-checkpoint';

export type CheckpointReason = 'store' | 'save-version' | 'last-leave' | 'flag-off';

/**
 * Who edited one doc since its last push, for the commit's `Co-authored-by:`
 * trailers. Collected by the collab server from each change's connection
 * context (agents included under the user they act for), persisted with each
 * store in `collab_docs.editors` (every entry stamped with the version its
 * edit was stored in), and sent with every trigger — the trailing debounce
 * runs with the last payload, so each payload carries every doc of the
 * classroom with unpushed editors. The worker reads the row's list first;
 * this payload is the fallback. An editor is dropped once a push covers the
 * version of their latest edit, so an edit stored while a push is in flight
 * is credited on the next commit.
 */
export interface CheckpointDocEditors {
  kind: CollabKind;
  docId: string;
  editors: CollabActor[];
}

export interface ContentCheckpointPayload {
  classroomId: string;
  reason?: CheckpointReason;
  /** Optional; see CheckpointDocEditors. Absent = no co-author trailers. */
  editors?: CheckpointDocEditors[];
  /** "Save version" message from `POST /internal/:kind/:id/checkpoint`, if any. */
  message?: string;
  /**
   * Save-version requests this run answers (checkpoint-now payloads only):
   * the run reports each on its doc's checkpoint-result entry.
   */
  requests?: CheckpointRequestRef[];
  /**
   * A warm-up run: no git, no rows. It loads what a checkpoint needs and
   * returns, so the worker's machine and process are ready when a real
   * checkpoint (Present, Save version) follows. Sent by collab, at most once
   * a minute per classroom, while someone has a live doc of it open.
   */
  warm?: true;
}

/** Commit trailer marking a push as ours (hook-station skips these). */
export const COLLAB_COMMIT_TRAILER = 'Classmoji-Collab';
