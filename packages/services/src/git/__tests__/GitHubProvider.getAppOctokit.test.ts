/**
 * The app-JWT client must REPORT a rate limit, not wait one out.
 *
 * `octokit`'s umbrella client ships the throttling plugin pre-wired to retry
 * once, and its retry is a `setTimeout` for however long GitHub asks — for a
 * primary limit that is time-until-reset, up to an hour. Every caller of
 * `getAppOctokit` (the installation repair lookup, the installation webhooks,
 * the post-install redirect) is supposed to turn a throttle into "try again in
 * N seconds", and none of them can do that from inside an hour-long sleep.
 *
 * This drives the REAL client — a real JWT, a real request pipeline — against a
 * stub `fetch`, because the bug being guarded lives in the plugin wiring rather
 * than in any of our own code, and only a real client exercises it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// The module reads both of these once, at import time.
process.env.GITHUB_APP_ID = '424242';
process.env.GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(privateKey).toString('base64');

let GitHubProvider: typeof import('../GitHubProvider.ts').GitHubProvider;

beforeAll(async () => {
  ({ GitHubProvider } = await import('../GitHubProvider.ts'));
});

// Octokit's own plugins narrate rate limits through `console`, and that output
// lands after the assertion has already passed — enough to race the worker's
// teardown and fail the whole run. Swallow it; the assertions here are about
// what the client DOES, not what it says.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A primary rate limit: 403, nothing left, and an hour until it resets. */
const rateLimitedFetch = (resetEpochSeconds: number) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetEpochSeconds),
        },
      })
  );

describe('GitHubProvider.getAppOctokit', () => {
  it('throws a 403 rate limit straight through instead of retrying after the reset', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fetch = rateLimitedFetch(reset);
    const octokit = GitHubProvider.getAppOctokit();

    const startedAt = Date.now();
    await expect(
      octokit.request('GET /app/installations', { request: { fetch } })
    ).rejects.toMatchObject({ status: 403 });
    const elapsed = Date.now() - startedAt;

    // ONE attempt. With the umbrella's default throttling the plugin would
    // answer this 403 by scheduling a second attempt for the reset — an hour
    // away — and this expectation is what catches that wiring coming back.
    // (Fake timers cannot stand in here: the plugin schedules through
    // Bottleneck, which never fires on a faked clock.)
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('keeps the rate-limit headers on the error so the retry-after is readable', async () => {
    const reset = Math.floor(Date.now() / 1000) + 90;
    const fetch = rateLimitedFetch(reset);
    const octokit = GitHubProvider.getAppOctokit();

    const error = await octokit
      .request('GET /app/installations', { request: { fetch } })
      .then(() => null)
      .catch((e: unknown) => e as { response?: { headers?: Record<string, string> } });

    expect(error?.response?.headers?.['x-ratelimit-remaining']).toBe('0');
    expect(error?.response?.headers?.['x-ratelimit-reset']).toBe(String(reset));
  });

  it('throws a 429 secondary limit straight through instead of retrying with backoff', async () => {
    // The retry plugin's default doNotRetry list skips 403 but not 429, so
    // without the override this would take four attempts and ~14 s.
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        })
    );
    const octokit = GitHubProvider.getAppOctokit();

    const startedAt = Date.now();
    const error = await octokit
      .request('GET /app/installations', { request: { fetch } })
      .then(() => null)
      .catch(
        (e: unknown) => e as { status?: number; response?: { headers?: Record<string, string> } }
      );
    const elapsed = Date.now() - startedAt;

    expect(error?.status).toBe(429);
    expect(error?.response?.headers?.['retry-after']).toBe('60');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});
