/**
 * The MCP side of live collaborative editing: when a classroom edits pages
 * and decks live (`Classroom.collab_enabled`), the content tools read and
 * write the LIVE document through the collab server's internal HTTP API
 * (`${COLLAB_URL}/internal`, header `x-collab-secret`) instead of git main —
 * main is only the last checkpoint there. Unflagged classrooms never reach
 * this module: `liveStateFor` checks the flag before anything else.
 *
 * Versions: a live document has no blob sha. Reads report its epoch and
 * `collab_docs.version` as `live:<epoch>.<version>` in the `sha` field, and
 * writes take it back as `expected_sha` (see liveCheck.ts for the check).
 */

import {
  COLLAB_INTERNAL_PREFIX,
  COLLAB_SECRET_HEADER,
  type CollabActor,
  type CollabKind,
  type CursorRequest,
  type CursorResponse,
  type OpsResponse,
  type PageCoverImage,
  type SlideLock,
  type SnapshotResponse,
} from '@classmoji/collab';
import { resolveCollabEnv, type CollabEnv } from '@classmoji/collab/env';
import { ClassmojiService } from '@classmoji/services';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext } from '../mcp/registry.ts';

export type { CollabEnv };

/** The classroom flag, read defensively (absent on an older row = off). */
export function classroomCollabEnabled(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}

let warnedMissingEnv = false;

/**
 * Whether this classroom edits live, and how to reach the collab server:
 * `null` = not a live classroom (the flag is read FIRST, so an unflagged
 * classroom never resolves the env and never talks to collab); `{ env }` =
 * live, where `env` is null when the collab env is not configured (production
 * with COLLAB_URL or COLLAB_INTERNAL_SECRET unset). Then reads fall back to
 * git, labelled, and writes are refused (LIVE_UNAVAILABLE) — git main is only
 * the live document's checkpoint, so writing it would be lost or fought over.
 */
export function liveStateFor(classroom: unknown): { env: CollabEnv | null } | null {
  if (!classroomCollabEnabled(classroom)) return null;
  const env = resolveCollabEnv();
  if (!env && !warnedMissingEnv) {
    warnedMissingEnv = true;
    console.error(
      '[mcp] Live editing is on for a classroom but COLLAB_URL / COLLAB_INTERNAL_SECRET are unset.'
    );
  }
  return { env };
}

/** The collab env for a live WRITE, or LIVE_UNAVAILABLE when unconfigured. */
export function requireLiveEnv(state: { env: CollabEnv | null }): CollabEnv {
  if (state.env) return state.env;
  throw new ToolError(
    'internal',
    'This classroom edits content live, but the live editing service is not configured here, ' +
      "so nothing was changed. mode: 'preview' still works.",
    'LIVE_UNAVAILABLE'
  );
}

// ─── Versions ────────────────────────────────────────────────────────────────

const LIVE_PREFIX = 'live:';

/**
 * The `sha` a read reports for a live document: `live:<epoch>.<version>`.
 * The epoch changes when the document is reseeded from git, so a version
 * from before a reseed never matches one after it.
 */
export function liveSha(epoch: number, version: number): string {
  return `${LIVE_PREFIX}${epoch}.${version}`;
}

export interface LivePin {
  /** null for the older version-only form (`live:12`, `12`). */
  epoch: number | null;
  version: number;
}

/** `live:3.12` → {3, 12}; `live:12` or `12` → {null, 12}; a git sha → null. */
export function parseLiveVersion(value: string | undefined | null): LivePin | null {
  if (!value) return null;
  const raw = value.startsWith(LIVE_PREFIX) ? value.slice(LIVE_PREFIX.length) : value;
  const both = /^(\d{1,15})\.(\d{1,15})$/.exec(raw);
  if (both) return { epoch: Number(both[1]), version: Number(both[2]) };
  if (/^\d{1,15}$/.test(raw)) return { epoch: null, version: Number(raw) };
  return null;
}

// ─── Version errors ───

const readTool = (kind: 'page' | 'deck') =>
  kind === 'page' ? 'page_content_get/outline' : 'deck_get/deck_outline';

/**
 * CONTENT_CONFLICT for a pin the live service holds no read of for this
 * agent (never read by it, expired, or the service restarted): it cannot
 * tell which items changed since, so the agent re-reads.
 */
export function livePinUnknown(
  expected: string | null,
  current: { epoch: number; version: number } | null,
  kind: 'page' | 'deck'
): ToolError {
  const now = current ? liveSha(current.epoch, current.version) : null;
  return new ToolError(
    'invalid_params',
    `${expected ? `'${expected}'` : 'That version'} is not a version the live service still ` +
      `holds your read of${now ? ` (it is now '${now}')` : ''}, so it cannot tell which ` +
      `${kind === 'page' ? 'blocks' : 'slides'} changed since; nothing was applied. Re-read ` +
      `with ${readTool(kind)} and retry with its sha.`,
    'CONTENT_CONFLICT',
    { reason: 'unknown-pin', ...(now ? { current_sha: now } : {}) }
  );
}

/** CONTENT_CONFLICT for a pin from before the document was reloaded from git. */
export function liveEpochConflict(kind: 'page' | 'deck'): ToolError {
  return new ToolError(
    'invalid_params',
    `The ${kind} was reloaded from git since you read it, so that version no longer applies — ` +
      `re-read with ${readTool(kind)} and retry.`,
    'CONTENT_CONFLICT',
    { reason: 'reloaded' }
  );
}

/** expected_sha that is not a live version, in live mode. */
export function notALiveVersion(kind: 'page' | 'deck'): ToolError {
  return new ToolError(
    'invalid_params',
    `This ${kind} is edited live: expected_sha must be the live version a read returned ` +
      `(like 'live:1.12'), not a git sha — call ${readTool(kind)} for it.`,
    'CONTENT_CONFLICT',
    { reason: 'not-live-version' }
  );
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

/** Live ops that change or remove existing content, sent without a pin. */
export function pinRequired(kind: 'page' | 'deck'): ToolError {
  const what = kind === 'page' ? 'blocks' : 'slides';
  return new ToolError(
    'invalid_params',
    `In live mode expected_sha is required for ops that change, move or remove existing ${what} ` +
      `(only pure inserts may omit it) — pass the version from ${readTool(kind)}, so edits ` +
      'people made since your read are not overwritten.',
    'EXPECTED_SHA_REQUIRED'
  );
}

// ─── Checkpoint status ───

/**
 * When the live document last reached GitHub, for read results:
 * `saved_to_github_at` (ISO) and `save_error` when that save failed. Absent
 * fields (an older collab server) are simply left out.
 */
export function checkpointFields(snapshot: {
  lastCheckpointAt?: string | null;
  lastCheckpointError?: string | null;
}): { saved_to_github_at: string | null; save_error?: string } {
  return {
    saved_to_github_at: snapshot.lastCheckpointAt ?? null,
    ...(snapshot.lastCheckpointError ? { save_error: snapshot.lastCheckpointError } : {}),
  };
}

// ─── Internal API ────────────────────────────────────────────────────────────

/** A non-2xx answer from the collab server, or none at all (status 0). */
export class CollabRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'CollabRequestError';
    this.status = status;
    this.body = body;
  }

  /** The server's `error` code, when it sent one. */
  get code(): string | null {
    const body = this.body as { error?: unknown } | null;
    return body && typeof body === 'object' && typeof body.error === 'string' ? body.error : null;
  }

  /** The server's human message, when it sent one. */
  get detail(): string | null {
    const body = this.body as { message?: unknown } | null;
    return body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message
      : null;
  }

  /** Unreachable, timed out, or a server fault: reads may fall back to git. */
  get unavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function collabRequest<T>(
  env: CollabEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        [COLLAB_SECRET_HEADER]: env.secret,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CollabRequestError(
      `Live editing service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      0
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const code =
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${response.status}`;
    throw new CollabRequestError(`Live editing service refused: ${code}`, response.status, parsed);
  }
  return parsed as T;
}

const docPath = (kind: CollabKind, id: string, action: string) =>
  `/${kind}/${encodeURIComponent(id)}/${action}`;

/** Whose read a snapshot is: the MCP caller and its agent session. */
export interface SnapshotViewer {
  userId: string;
  agentSession?: string | null;
}

/**
 * The live document (from a clone on the server), with its version. With
 * `viewer` the server remembers what this agent was shown, so its pin can
 * be judged per block later (an AGENT'S read: outline/get). Without one
 * nothing is remembered — renders and the apply's own pre-read pass none.
 */
export function fetchSnapshot<K extends CollabKind>(
  env: CollabEnv,
  kind: K,
  id: string,
  viewer: SnapshotViewer | null = null
): Promise<SnapshotResponse<K>> {
  const query = viewer
    ? `?viewer=${encodeURIComponent(viewer.userId)}` +
      (viewer.agentSession ? `&session=${encodeURIComponent(viewer.agentSession)}` : '')
    : '';
  return collabRequest<SnapshotResponse<K>>(env, 'GET', docPath(kind, id, 'snapshot') + query);
}

/**
 * Apply id-aware ops to the live document as `actor`. `since` is the
 * agent's pin: the server judges the ops against what this agent was shown
 * at that version, inside the live transaction (409 block-changed /
 * unknown-version / stale-epoch, nothing applied). Either way the server
 * remembers the agent's view of the version the write leaves, so the
 * returned version is a pin too.
 */
export function postOps(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  ops: unknown[],
  actor: CollabActor,
  since: { epoch: number; version: number } | null
): Promise<OpsResponse> {
  return collabRequest<OpsResponse>(env, 'POST', docPath(kind, id, 'ops'), {
    ops,
    actor,
    ...(since ? { expect_since: since } : { remember: true }),
  });
}

/** Set (or clear, with null) a live page's cover. */
export function postCover(
  env: CollabEnv,
  pageId: string,
  coverImage: PageCoverImage | null,
  actor: CollabActor
): Promise<OpsResponse> {
  return collabRequest<OpsResponse>(env, 'POST', docPath('page', pageId, 'cover'), {
    coverImage,
    actor,
    // The agent's view of the new version: its pin is judged per block.
    remember: true,
  });
}

/**
 * `POST /internal/:kind/:id/merge-preview` (spec, added after review): the
 * collab server runs the 3-way merge (base, LIVE, theirs) inside the live
 * transaction, so nothing typed between a read and the apply is reverted.
 * `base`/`theirs` are in the snapshot shape (page `{ blocks, coverImage }`,
 * deck `Deck`). Conflicts → 409 `{ error: 'conflicts', conflicts }` with
 * nothing applied; else 200 `{ applied: true, version }`.
 */
export interface MergePreviewRequest {
  base: unknown;
  theirs: unknown;
  resolutions?: Array<{ id: string; choose: 'ours' | 'theirs' }>;
  actor: CollabActor;
}

export interface MergePreviewResponse {
  applied: true;
  version: number;
}

export type MergePreviewOutcome =
  | { applied: true; version: number }
  | { applied: false; conflicts: Array<Record<string, unknown>>; autoMerged?: number };

export async function postMergePreview(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  request: MergePreviewRequest
): Promise<MergePreviewOutcome> {
  try {
    const result = await collabRequest<MergePreviewResponse>(
      env,
      'POST',
      docPath(kind, id, 'merge-preview'),
      request
    );
    return { applied: true, version: result.version };
  } catch (error) {
    if (error instanceof CollabRequestError && error.status === 409 && error.code === 'conflicts') {
      const { conflicts, autoMerged } = error.body as { conflicts?: unknown; autoMerged?: unknown };
      return {
        applied: false,
        conflicts: Array.isArray(conflicts) ? (conflicts as Array<Record<string, unknown>>) : [],
        ...(typeof autoMerged === 'number' ? { autoMerged } : {}),
      };
    }
    throw error;
  }
}

/**
 * `POST /internal/:kind/:id/cursor`: the agent's caret (page) or the slide it
 * points at (deck), with no content change. `{ shown: false }` when nobody
 * has the doc open; 404 for an unknown block or slide.
 */
export function postCursor(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  request: CursorRequest
): Promise<CursorResponse> {
  return collabRequest<CursorResponse>(env, 'POST', docPath(kind, id, 'cursor'), request);
}

/** `POST /internal/:kind/:id/close`: checkpoint now, then close every connection. */
export function postClose(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  reason: string
): Promise<{ closed: number }> {
  return collabRequest<{ closed: number }>(env, 'POST', docPath(kind, id, 'close'), { reason });
}

/**
 * Tell open editors that this doc's preview was created, updated or
 * discarded (`POST /internal/:kind/:id/preview-changed`), so their
 * pending-preview banner refreshes. Only for live classrooms with the collab
 * env; best effort — a failure is logged and never fails the tool call.
 */
export async function notifyPreviewChanged(
  classroom: unknown,
  kind: CollabKind,
  id: string
): Promise<void> {
  const env = liveStateFor(classroom)?.env;
  if (!env) return;
  try {
    await collabRequest<unknown>(env, 'POST', docPath(kind, id, 'preview-changed'), {});
  } catch (error) {
    console.warn(
      `[mcp] Could not tell live editors the ${kind} preview changed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Tell open editors this doc's title (or page width) changed outside the
 * document (`POST /internal/:kind/:id/meta-changed`), so their header
 * updates live. Live classrooms with the collab env only; best effort.
 */
export async function notifyMetaChanged(
  classroom: unknown,
  kind: CollabKind,
  id: string,
  meta: { title?: string; width?: number }
): Promise<void> {
  if (meta.title === undefined && meta.width === undefined) return;
  const env = liveStateFor(classroom)?.env;
  if (!env) return;
  try {
    await collabRequest<unknown>(env, 'POST', docPath(kind, id, 'meta-changed'), meta);
  } catch (error) {
    console.warn(
      `[mcp] Could not tell live editors the ${kind} title changed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ─── Actor ───────────────────────────────────────────────────────────────────

/**
 * Who the agent edits as: the MCP caller, under their name (peers see
 * `<name> (agent)`). Falls back to the login, then a placeholder. The MCP
 * session (`Mcp-Session-Id`) rides along, so each of the caller's agent
 * sessions is its own presence.
 */
export async function actorFor(ctx: ToolContext): Promise<CollabActor> {
  const userId = ctx.viewer.userId;
  let name = '';
  try {
    const user = (await ClassmojiService.user.findById(userId)) as {
      name?: string | null;
      login?: string | null;
    } | null;
    name = user?.name?.trim() || user?.login?.trim() || '';
  } catch (error) {
    console.warn('[mcp] Could not read the editor name for a live edit:', error);
  }
  const agentSession = ctx.viewer.agentSession;
  return { userId, name: name || 'Teacher', ...(agentSession ? { agentSession } : {}) };
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * A refusal from a live WRITE, as the agent should read it. Reads fall back
 * to git on `unavailable` instead of calling this.
 */
export function liveWriteError(
  error: unknown,
  what: 'page' | 'deck',
  options: { previewHint?: boolean; expectedSha?: string } = {}
): Error {
  if (!(error instanceof CollabRequestError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const previewHint = options.previewHint ?? true;
  const preview = previewHint ? " Retry, or use mode: 'preview'." : ' Retry shortly.';
  if (error.unavailable) {
    return new ToolError(
      'internal',
      `The live editing service did not answer, so nothing was changed.${preview}`,
      'LIVE_UNAVAILABLE'
    );
  }
  if (error.status === 409 && error.code === 'slide-locked') {
    return slideLockedError(error.body);
  }
  if (error.status === 409 && error.code === 'block-changed') {
    const ids = (error.body as { changedIds?: unknown }).changedIds;
    return blockChangedError(
      what,
      Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    );
  }
  if (
    error.code === 'legacy-html' ||
    error.code === 'unparseable-deck' ||
    error.code === 'content-missing'
  ) {
    const why =
      error.code === 'content-missing'
        ? `This ${what} has no content file yet`
        : error.code === 'legacy-html'
          ? 'This page still stores legacy HTML'
          : "This deck's HTML cannot be parsed into a structured deck";
    return new ToolError(
      'invalid_params',
      `${why}, so it cannot be edited live and nothing was changed. Use mode: 'preview' ` +
        '(for a page, a replace_all op writes fresh content), or open it once in the web editor.',
      'LIVE_UNSUPPORTED'
    );
  }
  if (error.status === 400 || error.status === 422) {
    return new ToolError(
      'invalid_params',
      error.detail ?? `The live ${what} refused these ops (${error.code ?? error.status})`
    );
  }
  if (error.status === 404) {
    return new ToolError('not_found', `The live ${what} was not found`);
  }
  if (error.status === 409 && error.code === 'stale-epoch') {
    return liveEpochConflict(what);
  }
  if (error.status === 409 && error.code === 'unknown-version') {
    const current = (error.body as { current?: { epoch?: unknown; version?: unknown } }).current;
    const valid =
      current && typeof current.epoch === 'number' && typeof current.version === 'number'
        ? { epoch: current.epoch, version: current.version }
        : null;
    return livePinUnknown(options.expectedSha ?? null, valid, what);
  }
  if (error.status === 409 && error.code === 'unreadable-live-doc') {
    // A server-side read fault, not the agent's pin: re-reading won't help.
    return new ToolError(
      'internal',
      `The live ${what} holds content the live editing service cannot read, so nothing was ` +
        "changed. Use mode: 'preview', or ask someone to open it in the web editor.",
      'LIVE_UNREADABLE',
      { reason: error.code }
    );
  }
  if (error.status === 409) {
    return new ToolError(
      'invalid_params',
      error.detail ?? `The live ${what} refused the edit (${error.code ?? 'conflict'})`,
      'CONTENT_CONFLICT',
      { reason: error.code ?? 'conflict' }
    );
  }
  return new ToolError('internal', `${error.message} (HTTP ${error.status})`);
}

/**
 * A live READ the service refused for a reason the read path does not fall
 * back on (not down, not legacy content, not 404), as the agent should read
 * it — never a bare internal error.
 */
export function liveReadError(error: CollabRequestError, what: 'page' | 'deck'): ToolError {
  if (error.status === 409 && error.code === 'unreadable-live-doc') {
    return new ToolError(
      'internal',
      `The live ${what} holds content the live editing service cannot read. Ask someone to ` +
        'open it in the web editor, or retry shortly.',
      'LIVE_UNREADABLE',
      { reason: error.code }
    );
  }
  if (error.status === 409 && error.code === 'stale-epoch') {
    return new ToolError(
      'internal',
      `The live ${what} was being reloaded from git; read it again.`,
      'LIVE_UNAVAILABLE',
      { reason: error.code }
    );
  }
  return new ToolError(
    'internal',
    `The live editing service refused to read this ${what} ` +
      `(${error.detail ?? error.code ?? `HTTP ${error.status}`}). Retry, or read at: 'preview'.`,
    'LIVE_READ_FAILED',
    { reason: error.code ?? String(error.status) }
  );
}

/** The 409 slide-locked body as an agent-facing error. */
export function slideLockedError(body: unknown): ToolError {
  const { slideId, holder } = (body ?? {}) as { slideId?: string; holder?: Partial<SlideLock> };
  const who = holder?.name?.trim() || 'Someone';
  const slide = slideId ? `slide '${slideId}'` : 'a slide these ops touch';
  return new ToolError(
    'invalid_params',
    `${who} is editing ${slide} right now, so nothing was changed — while someone holds a ` +
      'slide, every change to it is refused, its notes and attributes included. Edit another ' +
      "slide, try this one again once they are done, or use mode: 'preview' to propose the " +
      'change for review.',
    'SLIDE_LOCKED',
    { ...(slideId ? { slide_id: slideId } : {}), held_by: who }
  );
}
