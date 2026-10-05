/**
 * The collab server's internal API, from the slides app's server.
 *
 * Endpoints and secret come from `@classmoji/collab/env` (server-only; the
 * same resolution every service uses): outside production they fall back to
 * the local collab server and the shared dev secret; in production a missing
 * URL or secret switches live editing OFF (one error in the log) and the
 * classroom keeps the git editor.
 */
import {
  COLLAB_INTERNAL_PREFIX,
  COLLAB_SECRET_HEADER,
  DECK_SCHEMA_VERSION,
  roomName,
  userColor,
  type CollabLoaderData,
} from '@classmoji/collab';
import { resolveCollabEnv, type CollabEnv } from '@classmoji/collab/env';

export type { CollabEnv };

type Env = Record<string, string | undefined>;

let warnedMissing = false;

export function collabEnv(env: Env = process.env): CollabEnv | null {
  const resolved = resolveCollabEnv(env);
  if (!resolved && !warnedMissing) {
    warnedMissing = true;
    console.error(
      '[slides] Live editing is off: COLLAB_URL (or COLLAB_WS_URL) and COLLAB_INTERNAL_SECRET must be set.'
    );
  }
  return resolved;
}

/** The loader's `collab` payload for one deck editor. */
export function buildDeckCollabLoaderData({
  env,
  slideId,
  epoch,
  user,
}: {
  env: CollabEnv;
  slideId: string;
  epoch: number;
  user: { id: string; name: string };
}): CollabLoaderData {
  const safeEpoch = Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : 1;
  return {
    wsUrl: env.wsUrl,
    room: roomName('deck', slideId, safeEpoch),
    epoch: safeEpoch,
    schemaVersion: DECK_SCHEMA_VERSION,
    user: { id: user.id, name: user.name, color: userColor(user.id) },
  };
}

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

/** One call to `${COLLAB_URL}/internal/...` with the shared secret. JSON in, JSON out. */
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

/** `/deck/<id>/<action>` with the id encoded. */
export function deckInternalPath(slideId: string, action: string): string {
  return `/deck/${encodeURIComponent(slideId)}/${action}`;
}
