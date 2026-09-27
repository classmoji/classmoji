/**
 * The throttling plugin's automatic retry is capped on ordinary clients: a
 * rate-limited WRITE is retried once, and only when GitHub asks for 60 s or
 * less. Anything longer surfaces as the 403 at once, so it reaches our own
 * bounded retry (ContentService.uploadBatch) instead of the plugin sleeping
 * e.g. 300 s inside a user request. Reads keep the umbrella's behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubProvider,
  THROTTLE_MAX_WRITE_RETRY_AFTER_S,
  throttleHandlers,
} from '../GitHubProvider.ts';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeOctokit = () => ({ log: { warn: vi.fn(), info: vi.fn() } });
const opts = (method: string, retryCount = 0) => ({
  method,
  url: '/repos/o/r/git/blobs',
  request: { retryCount },
});

describe.each([
  ['onRateLimit', throttleHandlers.onRateLimit],
  ['onSecondaryRateLimit', throttleHandlers.onSecondaryRateLimit],
] as const)('throttleHandlers.%s', (_name, handler) => {
  it('caps at 60 seconds', () => {
    expect(THROTTLE_MAX_WRITE_RETRY_AFTER_S).toBe(60);
  });

  it.each([
    [30, true],
    [60, true],
    [61, false],
    [300, false],
  ])('write, wait %i s, first attempt → retry %s', (retryAfter, expected) => {
    expect(handler(retryAfter, opts('POST'), fakeOctokit(), 0)).toBe(expected);
  });

  it('retries a write at most once', () => {
    expect(handler(30, opts('PATCH', 1), fakeOctokit(), 1)).toBe(false);
  });

  it('reads the attempt count from options when the 4th argument is absent', () => {
    expect(handler(30, opts('PUT', 1), fakeOctokit())).toBe(false);
    expect(handler(30, opts('PUT', 0), fakeOctokit())).toBe(true);
  });

  it('keeps reads as they were: retried once, however long the wait', () => {
    expect(handler(300, opts('GET'), fakeOctokit(), 0)).toBe(true);
    expect(handler(3600, opts('HEAD'), fakeOctokit(), 0)).toBe(true);
    expect(handler(30, opts('GET', 1), fakeOctokit(), 1)).toBe(false);
  });
});

const secondaryLimit = (retryAfter: string) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
      })
  );

// Drives a real client through the real throttling plugin, so this fails if
// the hooks are not actually wired in (the umbrella's would sleep 300 s here).
describe('the capped client (getUserOctokit)', () => {
  it('throws a write refused for 300 s at once, without the plugin retrying', async () => {
    const fetch = secondaryLimit('300');
    const octokit = GitHubProvider.getUserOctokit('ghu_token');

    const startedAt = Date.now();
    const error = await octokit
      .request('POST /repos/{owner}/{repo}/git/blobs', {
        owner: 'o',
        repo: 'r',
        content: 'x',
        request: { fetch },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(error).toMatchObject({ status: 403 });
  });

  it('still retries a write once when the wait is short', async () => {
    const fetch = secondaryLimit('1');
    const octokit = GitHubProvider.getUserOctokit('ghu_token');

    const error = await octokit
      .request('POST /repos/{owner}/{repo}/git/blobs', {
        owner: 'o',
        repo: 'r',
        content: 'x',
        request: { fetch },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ status: 403 });
  }, 10_000);
});
