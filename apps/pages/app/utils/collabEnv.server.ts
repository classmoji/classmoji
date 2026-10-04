/**
 * Where the collab server is and how to talk to its internal API.
 *
 * Pure (no database, no services) so the unit suite can drive it with a fake
 * environment and a fake `fetch`. The database half — the room's epoch, the
 * editor's name — is in `collab.server.ts`.
 *
 * Env (wired by the collab slice in `scripts/devport-env.sh`, `.env.example`
 * and `turbo.json`):
 *  - `COLLAB_WS_URL`          the browser's WebSocket URL;
 *  - `COLLAB_URL`             the internal HTTP base (server-to-server);
 *  - `COLLAB_INTERNAL_SECRET` the `x-collab-secret` header value;
 *  - `COLLAB_PORT`            devport's port, used only for dev fallbacks.
 *
 * Outside production every value falls back to the local collab server on
 * `COLLAB_PORT` (7700 + devport id × 10) and the shared dev secret
 * (`@classmoji/collab/env`). In production a missing URL or secret switches
 * live editing OFF for every classroom (one error in the log) rather than
 * failing the page: the classroom then keeps the git editor.
 */

import {
  COLLAB_INTERNAL_PREFIX,
  COLLAB_SECRET_HEADER,
  roomName,
  userColor,
  type CollabLoaderData,
} from '@classmoji/collab';
import { SCHEMA_VERSION } from '@classmoji/page-schema/constants';
import { resolveCollabEnv, type CollabEnv } from '@classmoji/collab/env';

export { DEV_COLLAB_INTERNAL_SECRET, DEFAULT_COLLAB_PORT } from '@classmoji/collab/env';
export type { CollabEnv };

type Env = Record<string, string | undefined>;

let warnedMissing = false;

/**
 * The collab endpoints, or null when live editing is unavailable.
 *
 * Resolved by `@classmoji/collab/env`, the same rules every service uses, with
 * one addition: in production the browser's `COLLAB_WS_URL` must be set
 * explicitly. The internal `COLLAB_URL` is a private address there, and a
 * WebSocket URL derived from it would point browsers at something they cannot
 * reach.
 */
export function collabEnv(env: Env = process.env): CollabEnv | null {
  const resolved = resolveCollabEnv(env);
  const wsMissing = env.NODE_ENV === 'production' && !env.COLLAB_WS_URL?.trim();
  if (!resolved || wsMissing) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.error(
        '[pages] Live editing is off: COLLAB_URL, COLLAB_WS_URL and COLLAB_INTERNAL_SECRET must be set.'
      );
    }
    return null;
  }
  return resolved;
}

/**
 * The loader's `collab` payload for one page editor (spec "Client contracts").
 * The colour is derived from the user id, so every peer shows a person in the
 * same colour without coordinating.
 */
export function buildCollabLoaderData({
  env,
  pageId,
  epoch,
  user,
}: {
  env: CollabEnv;
  pageId: string;
  epoch: number;
  user: { id: string; name: string };
}): CollabLoaderData {
  const safeEpoch = Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : 1;
  return {
    wsUrl: env.wsUrl,
    room: roomName('page', pageId, safeEpoch),
    epoch: safeEpoch,
    schemaVersion: SCHEMA_VERSION,
    user: { id: user.id, name: user.name, color: userColor(user.id) },
  };
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
 * One call to `${COLLAB_URL}/internal/...` with the shared secret. JSON in,
 * JSON out. Throws `CollabRequestError` on a non-2xx answer (status and parsed
 * body attached) and on a network failure or timeout (status 0).
 */
export async function collabInternalRequest<T>(
  env: CollabEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  { fetchImpl = fetch, timeoutMs = 10_000 }: CollabRequestOptions = {}
): Promise<T> {
  const url = `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        [COLLAB_SECRET_HEADER]: env.secret,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    const reason =
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${response.status}`;
    throw new CollabRequestError(
      `Live editing service refused: ${reason}`,
      response.status,
      parsed
    );
  }
  return parsed as T;
}

/** `/page/<id>/<action>` with the id encoded. */
export function pageInternalPath(pageId: string, action: string): string {
  return `/page/${encodeURIComponent(pageId)}/${action}`;
}
