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

/**
 * How long the token endpoint may take before the mint is abandoned.
 *
 * Generous, because this leg is legitimately slow: the endpoint lives in the
 * webapp, and on an environment whose webapp autostops the first request after
 * an idle period pays a cold start before it even reaches the GitHub App. A
 * short bound here would turn "the app was asleep" into "the content origin is
 * down" — the two look identical from this side and only one of them is true.
 *
 * It is a bound at all so a webapp that has stopped answering cannot hold a
 * Worker invocation open indefinitely. Past this, the pull becomes an
 * `OriginError`, which the router already answers 502 `origin unavailable` and
 * the app already falls back from.
 */
export const TOKEN_FETCH_TIMEOUT_MS = 25_000;

/**
 * What one token acquisition cost, and whether it cost anything at all.
 *
 * The distinction is the whole point of measuring: a `cached` mint is
 * sub-millisecond module-map work, and a `minted` one is a network round trip
 * to a possibly-cold webapp. A pull that took four seconds means something very
 * different depending on which of those it was, and without this the two are
 * indistinguishable in the log.
 */
export interface OriginTokenTiming {
  ms: number;
  source: 'cached' | 'minted';
}

async function mintOriginRef(env: Env, classroomId: string, now: number): Promise<OriginRef> {
  let response: Response;
  try {
    response = await fetch(env.CONTENT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CONTENT_WORKER_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ classroomId }),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a refused socket is the origin being unreachable, which is
    // the case `OriginError` already names — and deliberately NOT
    // `OriginAuthError`, because retrying a hung endpoint with a fresh token
    // would only spend the budget twice on the same silence.
    throw new OriginError(
      502,
      `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

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

/**
 * `getOriginRef`, plus what it cost.
 *
 * Split out rather than folded into the caller so the timing is taken around
 * the acquisition itself and cannot drift as the cache logic changes. See
 * `OriginTokenTiming` for why a cached hit is still worth reporting.
 */
export async function getOriginRefTimed(
  env: Env,
  classroomId: string,
  forceRefresh = false
): Promise<{ ref: OriginRef; timing: OriginTokenTiming }> {
  const startedAt = Date.now();
  const now = startedAt;
  if (!forceRefresh) {
    const cached = cachedOriginRef(classroomId, now);
    if (cached) return { ref: cached, timing: { ms: Date.now() - startedAt, source: 'cached' } };
  }
  const ref = await mintOriginRef(env, classroomId, now);
  return { ref, timing: { ms: Date.now() - startedAt, source: 'minted' } };
}

export async function getOriginRef(
  env: Env,
  classroomId: string,
  forceRefresh = false
): Promise<OriginRef> {
  return (await getOriginRefTimed(env, classroomId, forceRefresh)).ref;
}

function isUnauthorized(value: unknown): boolean {
  return value instanceof Response && value.status === 401;
}

/**
 * Run an origin call with the classroom's token. If the origin rejects the
 * credential — a 401 response or an OriginAuthError — drop the cached token
 * and try exactly once more with a fresh one.
 *
 * `onToken` is called for EVERY acquisition, so a retry reports twice. A caller
 * that is timing the pull should therefore accumulate rather than overwrite:
 * the retry path really did spend two token acquisitions, and a log line that
 * showed only the second would hide the one that made the request slow.
 */
export async function withOriginRetry<T>(
  env: Env,
  classroomId: string,
  run: (ref: OriginRef) => Promise<T>,
  onToken?: (timing: OriginTokenTiming) => void
): Promise<T> {
  const first = await getOriginRefTimed(env, classroomId);
  onToken?.(first.timing);
  try {
    const result = await run(first.ref);
    if (!isUnauthorized(result)) return result;
  } catch (error) {
    if (!(error instanceof OriginAuthError)) throw error;
  }

  invalidateOriginRef(classroomId);
  const refreshed = await getOriginRefTimed(env, classroomId, true);
  onToken?.(refreshed.timing);
  return run(refreshed.ref);
}
