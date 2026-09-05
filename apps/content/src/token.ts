import type { Env } from './env.ts';
import { OriginAuthError, OriginError, type OriginRef } from './origins/types.ts';

/**
 * Installation tokens are minted by the webapp, not by this Worker. We cache
 * each classroom's token in module scope (per isolate) and refresh it five
 * minutes before it expires, so a token never expires mid-fetch.
 */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface TokenPayload {
  org?: string;
  repo?: string;
  token?: string;
  expiresAt?: string;
}

interface CacheEntry {
  ref: OriginRef;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

/** A cached token is usable until `skew` before its stated expiry. */
export function isTokenFresh(expiresAtMs: number, now: number = Date.now()): boolean {
  return now < expiresAtMs - TOKEN_REFRESH_SKEW_MS;
}

export function cachedOriginRef(classroomId: string, now: number = Date.now()): OriginRef | null {
  const entry = cache.get(classroomId);
  if (!entry) return null;
  if (!isTokenFresh(entry.expiresAtMs, now)) {
    cache.delete(classroomId);
    return null;
  }
  return entry.ref;
}

export function invalidateOriginRef(classroomId: string): void {
  cache.delete(classroomId);
}

/** Test seam — the cache is module state and would otherwise leak between cases. */
export function clearOriginCache(): void {
  cache.clear();
}

async function mintOriginRef(env: Env, classroomId: string, now: number): Promise<OriginRef> {
  const response = await fetch(env.CONTENT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CONTENT_WORKER_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ classroomId }),
  });

  if (response.status === 401)
    throw new OriginAuthError('token endpoint rejected the worker secret');
  if (!response.ok) throw new OriginError(response.status, `token endpoint: ${response.status}`);

  const payload = (await response.json()) as TokenPayload;
  if (!payload.org || !payload.repo || !payload.token) {
    throw new OriginError(502, 'token endpoint returned an incomplete payload');
  }

  const ref: OriginRef = { org: payload.org, repo: payload.repo, token: payload.token };
  const expiresAtMs = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
  // Only cache a token we know the lifetime of; an unparseable expiry means
  // we re-mint next request rather than serve with a token that may be dead.
  if (Number.isFinite(expiresAtMs) && isTokenFresh(expiresAtMs, now)) {
    cache.set(classroomId, { ref, expiresAtMs });
  }
  return ref;
}

export async function getOriginRef(
  env: Env,
  classroomId: string,
  forceRefresh = false
): Promise<OriginRef> {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = cachedOriginRef(classroomId, now);
    if (cached) return cached;
  }
  return mintOriginRef(env, classroomId, now);
}

function isUnauthorized(value: unknown): boolean {
  return value instanceof Response && value.status === 401;
}

/**
 * Run an origin call with the classroom's token. If the origin rejects the
 * credential — a 401 response or an OriginAuthError — drop the cached token
 * and try exactly once more with a fresh one.
 */
export async function withOriginRetry<T>(
  env: Env,
  classroomId: string,
  run: (ref: OriginRef) => Promise<T>
): Promise<T> {
  const ref = await getOriginRef(env, classroomId);
  try {
    const result = await run(ref);
    if (!isUnauthorized(result)) return result;
  } catch (error) {
    if (!(error instanceof OriginAuthError)) throw error;
  }

  invalidateOriginRef(classroomId);
  return run(await getOriginRef(env, classroomId, true));
}
