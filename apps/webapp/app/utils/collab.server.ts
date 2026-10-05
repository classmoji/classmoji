/**
 * Live collaborative editing — the webapp's (small) server half.
 *
 * The webapp never hosts a live editor; it only talks to the collab server's
 * internal API (`${COLLAB_URL}/internal`, header `x-collab-secret`) for two
 * owner/teacher acts:
 *
 *  - the classroom's "Live editing" switch (`notifyCollabFlag`), and
 *  - deleting a page, which closes its live room first
 *    (`closeLivePageForDelete`).
 *
 * The request helper is a minimal copy of the pages app's
 * (`apps/pages/app/utils/collabEnv.server.ts`): moving it into
 * `@classmoji/collab` would make that package depend on fetch semantics every
 * other consumer already wraps its own way, so it is duplicated rather than
 * shared. `.server` keeps `@classmoji/collab/env` (and the dev secret it
 * knows) out of the client bundle.
 */

import {
  COLLAB_INTERNAL_PREFIX,
  COLLAB_SECRET_HEADER,
  type CloseRequest,
  type FlagRequest,
} from '@classmoji/collab';
import { resolveCollabEnv, type CollabEnv } from '@classmoji/collab/env';
import getPrisma from '@classmoji/database';

export type { CollabEnv };

/** The classroom flag, read defensively (absent on an older row = off). */
export function classroomCollabEnabled(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}

/**
 * The collab server's address + secret, or null when this deployment has no
 * collab server configured (production without COLLAB_URL /
 * COLLAB_INTERNAL_SECRET). Server-to-server only, so the browser WebSocket URL
 * is not required here.
 */
export function collabServerEnv(
  env: Record<string, string | undefined> = process.env
): CollabEnv | null {
  return resolveCollabEnv(env);
}

// ─── Internal API ────────────────────────────────────────────────────────────

/** A non-2xx answer from the collab server (or no answer at all: status 0). */
export class CollabRequestError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'CollabRequestError';
    this.status = status;
    this.body = body;
  }
}

export interface CollabRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One POST to `${COLLAB_URL}/internal/...` with the shared secret. JSON in,
 * JSON out. Throws `CollabRequestError` on a non-2xx answer (status attached)
 * and on a network failure or timeout (status 0).
 */
export async function collabInternalPost<T>(
  env: CollabEnv,
  path: string,
  body: unknown,
  { fetchImpl = fetch, timeoutMs = 10_000 }: CollabRequestOptions = {}
): Promise<T> {
  const url = `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { [COLLAB_SECRET_HEADER]: env.secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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
    throw new CollabRequestError(
      `Live editing service refused: HTTP ${response.status}`,
      response.status,
      parsed
    );
  }
  return parsed as T;
}

// ─── Classroom flag ──────────────────────────────────────────────────────────

/**
 * Tell the collab server a classroom's `collab_enabled` flipped
 * (`POST /internal/classroom/:id/flag { enabled }`). The server stores what
 * is open, runs a final checkpoint when turning off, closes every open room
 * (editors reload) and reseeds clean documents from git.
 *
 * Never throws: `{ ok: false }` when there is no collab server configured or
 * it could not be reached / refused. The caller has already written the flag.
 */
export async function notifyCollabFlag(
  classroomId: string,
  enabled: boolean,
  { env = collabServerEnv(), ...options }: CollabRequestOptions & { env?: CollabEnv | null } = {}
): Promise<{ ok: boolean }> {
  if (!env) {
    console.error('[collab] No collab server configured; flag change not delivered', classroomId);
    return { ok: false };
  }
  try {
    const body: FlagRequest = { enabled };
    await collabInternalPost(
      env,
      `/classroom/${encodeURIComponent(classroomId)}/flag`,
      body,
      options
    );
    return { ok: true };
  } catch (error) {
    console.error('[collab] Telling the collab server about the flag change failed:', error);
    return { ok: false };
  }
}

// ─── Page delete ─────────────────────────────────────────────────────────────

/** Whether a page's live room must be closed before the page is deleted. */
export function closeBeforeDelete({
  classroomFlagged,
  hasCollabDoc,
}: {
  classroomFlagged: boolean;
  hasCollabDoc: boolean;
}): boolean {
  return classroomFlagged || hasCollabDoc;
}

/**
 * Close a page's live room before the page is deleted
 * (`POST /internal/page/:id/close { reason: 'deleted' }`): the collab server
 * saves what it holds, then disconnects every editor (they reload and find the
 * page gone). Needed when the classroom edits live, or when a buffered
 * document exists for the page (the flag may have been turned off since).
 *
 * `ok: false` means the room could not be closed — the delete must wait, or
 * live editors would keep typing into a page that no longer exists. A 404 (no
 * such room or document on the collab server) is fine.
 *
 * Same rule as the pages app's `closeLivePageForDelete`.
 */
export async function closeLivePageForDelete(
  { pageId, classroom }: { pageId: string; classroom: unknown },
  { env = collabServerEnv(), ...options }: CollabRequestOptions & { env?: CollabEnv | null } = {}
): Promise<{ ok: boolean }> {
  const row = await getPrisma().collabDoc.findUnique({
    where: { kind_doc_id: { kind: 'page', doc_id: pageId } },
    select: { epoch: true },
  });
  if (
    !closeBeforeDelete({
      classroomFlagged: classroomCollabEnabled(classroom),
      hasCollabDoc: Boolean(row),
    })
  ) {
    return { ok: true };
  }
  if (!env) {
    console.error('[collab] Cannot close the live room before deleting page', pageId);
    return { ok: false };
  }
  try {
    const body: CloseRequest = { reason: 'deleted' };
    await collabInternalPost(env, `/page/${encodeURIComponent(pageId)}/close`, body, options);
    return { ok: true };
  } catch (error) {
    if (error instanceof CollabRequestError && error.status === 404) return { ok: true };
    console.error('[collab] Closing the live room before delete failed:', error);
    return { ok: false };
  }
}
