import { describe, expect, it, vi } from 'vitest';
import { Octokit } from 'octokit';

import { quotaIsLow, rateLimitRefusal, watchRateLimits } from '../rateLimitWatch.ts';

function fetchReturning(status: number, headers: Record<string, string>, body: unknown = {}) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
  );
}

const plainOctokit = (fetch: typeof globalThis.fetch) =>
  new Octokit({
    request: { fetch, retries: 0 },
    throttle: { enabled: false },
    retry: { enabled: false },
  } as never);

describe('quotaIsLow / rateLimitRefusal', () => {
  it('reads the primary quota headers', () => {
    expect(quotaIsLow({ 'x-ratelimit-remaining': '400', 'x-ratelimit-limit': '5000' }).low).toBe(
      true
    );
    expect(quotaIsLow({ 'x-ratelimit-remaining': '600', 'x-ratelimit-limit': '5000' }).low).toBe(
      false
    );
    expect(quotaIsLow({}).low).toBe(false);
  });

  it('recognises secondary limits and an exhausted quota, not other 403s', () => {
    const err = (status: number, headers: Record<string, string>, message = '') => ({
      status,
      message,
      response: { headers, data: { message } },
    });
    expect(
      rateLimitRefusal(
        err(403, { 'retry-after': '60' }, 'You have exceeded a secondary rate limit')
      )
    ).toEqual({
      status: 403,
      retryAfter: '60',
      secondary: true,
    });
    expect(rateLimitRefusal(err(429, {}))).toMatchObject({ status: 429, secondary: true });
    expect(rateLimitRefusal(err(403, { 'x-ratelimit-remaining': '0' }))).toMatchObject({
      secondary: false,
    });
    expect(rateLimitRefusal(err(403, {}, 'Resource not accessible by integration'))).toBeNull();
    expect(rateLimitRefusal(err(404, {}))).toBeNull();
  });
});

describe('watchRateLimits on a real Octokit', () => {
  it('warns once a minute when the quota is under 10%', async () => {
    const log = vi.fn();
    let t = 0;
    const octokit = plainOctokit(
      fetchReturning(200, { 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000' }) as never
    );
    watchRateLimits(octokit as never, 'installation 1', log, () => t);
    await octokit.request('GET /rate_limit');
    await octokit.request('GET /rate_limit');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][1]).toMatchObject({
      client: 'installation 1',
      remaining: 100,
      limit: 5000,
    });
    t += 61_000;
    await octokit.request('GET /rate_limit');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('stays quiet with plenty of quota', async () => {
    const log = vi.fn();
    const octokit = plainOctokit(
      fetchReturning(200, { 'x-ratelimit-remaining': '4900', 'x-ratelimit-limit': '5000' }) as never
    );
    watchRateLimits(octokit as never, 'i', log);
    await octokit.request('GET /rate_limit');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs every secondary-limit refusal with retry-after, and still throws it', async () => {
    const log = vi.fn();
    const octokit = plainOctokit(
      fetchReturning(
        403,
        { 'retry-after': '30' },
        { message: 'You have exceeded a secondary rate limit' }
      ) as never
    );
    watchRateLimits(octokit as never, 'i', log);
    await expect(
      octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner: 'o',
        repo: 'r',
        path: 'p',
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(octokit.request('GET /rate_limit')).rejects.toMatchObject({ status: 403 });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]).toEqual([
      '[github] secondary rate limit',
      expect.objectContaining({
        status: 403,
        retryAfter: '30',
        request: expect.stringContaining('PUT'),
      }),
    ]);
  });

  it('does not log ordinary failures, and installs once per client', async () => {
    const log = vi.fn();
    const octokit = plainOctokit(fetchReturning(404, {}, { message: 'Not Found' }) as never);
    watchRateLimits(octokit as never, 'i', log);
    watchRateLimits(octokit as never, 'i', log);
    await expect(octokit.request('GET /repos/o/r')).rejects.toMatchObject({ status: 404 });
    expect(log).not.toHaveBeenCalled();
  });
});
