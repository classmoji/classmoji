import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_REFRESH_SKEW_MS,
  cachedOriginRef,
  clearOriginCache,
  getOriginRef,
  invalidateOriginRef,
  isTokenFresh,
  withOriginRetry,
} from '../src/token.ts';
import { OriginAuthError, OriginError } from '../src/origins/types.ts';
import { CLASSROOM, fakeEnv } from './helpers.ts';

const realFetch = globalThis.fetch;

function tokenResponse(overrides: Record<string, unknown> = {}, status = 200) {
  return new Response(
    JSON.stringify({
      org: 'classmoji',
      repo: 'content-cs1',
      token: 'ghs_installation',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...overrides,
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

beforeEach(() => {
  clearOriginCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('token freshness', () => {
  it('treats a token as stale five minutes before it expires', () => {
    const now = 1_000_000;
    expect(isTokenFresh(now + TOKEN_REFRESH_SKEW_MS + 1, now)).toBe(true);
    expect(isTokenFresh(now + TOKEN_REFRESH_SKEW_MS, now)).toBe(false);
    expect(isTokenFresh(now + TOKEN_REFRESH_SKEW_MS - 1, now)).toBe(false);
    expect(isTokenFresh(now - 1, now)).toBe(false);
  });

  it('drops an entry once it falls inside the refresh window', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getOriginRef(fakeEnv(), CLASSROOM);
    expect(cachedOriginRef(CLASSROOM)).toMatchObject({ org: 'classmoji', repo: 'content-cs1' });

    // Ask again from a moment inside the skew window: the entry is evicted.
    expect(cachedOriginRef(CLASSROOM, Date.now() + 60 * 60 * 1000)).toBeNull();
    expect(cachedOriginRef(CLASSROOM)).toBeNull();
  });
});

describe('getOriginRef', () => {
  it('mints once and serves the rest from module cache', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const env = fakeEnv();
    await getOriginRef(env, CLASSROOM);
    await getOriginRef(env, CLASSROOM);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('presents the shared secret as a bearer token', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getOriginRef(fakeEnv(), CLASSROOM);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://staging.classmoji.io/api/content/token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer shared');
    expect(init.body).toBe(JSON.stringify({ classroomId: CLASSROOM }));
  });

  it('refuses to cache a token whose expiry it cannot read', async () => {
    const fetchMock = vi.fn(async () => tokenResponse({ expiresAt: 'not-a-date' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const env = fakeEnv();
    await getOriginRef(env, CLASSROOM);
    await getOriginRef(env, CLASSROOM);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises an auth error when the endpoint rejects the worker secret', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(getOriginRef(fakeEnv(), CLASSROOM)).rejects.toBeInstanceOf(OriginAuthError);
  });

  it('raises an origin error for an unknown classroom', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(getOriginRef(fakeEnv(), CLASSROOM)).rejects.toBeInstanceOf(OriginError);
  });

  it('rejects an incomplete payload rather than fetching with half a ref', async () => {
    globalThis.fetch = (async () => tokenResponse({ token: undefined })) as unknown as typeof fetch;
    await expect(getOriginRef(fakeEnv(), CLASSROOM)).rejects.toBeInstanceOf(OriginError);
  });
});

describe('withOriginRetry', () => {
  it('refreshes the token and retries once when the origin returns 401', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = vi
      .fn<(ref: { token: string }) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('bytes', { status: 200 }));

    const result = await withOriginRetry(fakeEnv(), CLASSROOM, run);
    expect(result.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once when the origin throws an auth error', async () => {
    globalThis.fetch = (async () => tokenResponse()) as unknown as typeof fetch;

    const run = vi
      .fn<(ref: { token: string }) => Promise<string[]>>()
      .mockRejectedValueOnce(new OriginAuthError('expired'))
      .mockResolvedValueOnce(['ok']);

    expect(await withOriginRetry(fakeEnv(), CLASSROOM, run)).toEqual(['ok']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-auth failure', async () => {
    globalThis.fetch = (async () => tokenResponse()) as unknown as typeof fetch;

    const run = vi.fn(async () => {
      throw new OriginError(500, 'boom');
    });

    await expect(withOriginRetry(fakeEnv(), CLASSROOM, run)).rejects.toBeInstanceOf(OriginError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache empty after an invalidation', async () => {
    globalThis.fetch = (async () => tokenResponse()) as unknown as typeof fetch;
    await getOriginRef(fakeEnv(), CLASSROOM);
    invalidateOriginRef(CLASSROOM);
    expect(cachedOriginRef(CLASSROOM)).toBeNull();
  });
});
