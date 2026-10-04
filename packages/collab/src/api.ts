/**
 * Contracts between the collab server, the apps, MCP, hook-station and the
 * git worker. Types only (plus a few constants), so every side can import
 * this without pulling in a runtime.
 */
import type { DeckJson } from '@classmoji/services/slides';

import type { CollabKind } from './rooms.ts';

// ─── Internal HTTP API (`${COLLAB_URL}/internal`, header x-collab-secret) ───

export const COLLAB_SECRET_HEADER = 'x-collab-secret';

/**
 * The `x-collab-secret` every side uses when COLLAB_INTERNAL_SECRET is unset
 * and NODE_ENV !== 'production' (production refuses to start without one).
 */
export const DEV_COLLAB_INTERNAL_SECRET = 'classmoji-collab-dev-secret';
export const COLLAB_INTERNAL_PREFIX = '/internal';

/** Who is making a server-side edit; shown in awareness as `<name> (agent)`. */
export interface CollabActor {
  userId: string;
  name: string;
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
}

/**
 * `POST /internal/:kind/:id/ops`. Page ops use the `pageBlockOpSchema`
 * vocabulary (packages/services pageContent.service.ts); deck ops the
 * `deckOps.ts` vocabulary. Applied id-aware, never as a whole-doc rewrite.
 */
export interface OpsRequest<Op = unknown> {
  ops: Op[];
  actor: CollabActor;
}

export interface OpsResponse {
  version: number;
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

/** `POST /internal/:kind/:id/checkpoint` — "Save version": checkpoint now. */
export interface CheckpointRequest {
  message?: string;
  actor: CollabActor;
}

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

/** Why the server refused a connection (the provider's auth-failure reason). */
export type CollabRejectReason = 'stale-epoch' | 'schema-mismatch' | 'forbidden';

/** WebSocket close code used when a periodic re-check fails. */
export const COLLAB_FORBIDDEN_CLOSE_CODE = 4403;

/** What `onAuthenticate` puts in the connection context. */
export interface CollabConnectionContext {
  userId: string;
  name: string;
  sessionToken: string;
  classroomId: string;
  kind: CollabKind;
  docId: string;
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
 * trailers. Kept IN MEMORY by the collab server (from each change's
 * connection context, agents included under the user they act for) and sent
 * with every trigger — the trailing debounce runs with the last payload, so
 * each payload carries every doc of the classroom with unpushed editors. An
 * editor is dropped once a push covers the version their edit was stored in.
 * A collab restart forgets them: the next commit then has no co-author
 * trailers for edits made before the restart (the content itself is safe in
 * collab_docs).
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
}

/** Commit trailer marking a push as ours (hook-station skips these). */
export const COLLAB_COMMIT_TRAILER = 'Classmoji-Collab';
