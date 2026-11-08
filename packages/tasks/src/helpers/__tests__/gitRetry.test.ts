import { describe, expect, it, vi } from 'vitest';
import {
  GIT_BLIP_RETRY,
  RATE_LIMIT_JITTER_MS,
  githubRateLimit,
  isTransientGitError,
  rateLimitRetryAt,
  readNewRepo,
  retryOnGitBlip,
} from '../gitRetry.ts';

// Shaped like simple-git's GitError (git's stderr is the message) and Octokit's
// RequestError, without importing either. Messages are from failed prod runs.
const gitError = (message: string) => Object.assign(new Error(message), { name: 'GitError' });
const httpError = (status: number | undefined, message = '') =>
  Object.assign(new Error(message), { name: 'HttpError', status });

describe('isTransientGitError', () => {
  it('counts github.com being unreachable during a push', () => {
    expect(
      isTransientGitError(
        gitError(
          "Pushing to https://github.com/acme/hw1-alice.git\nfatal: unable to access 'https://github.com/acme/hw1-alice.git/': Failed to connect to github.com port 443 after 135206 ms: Couldn't connect to server"
        )
      )
    ).toBe(true);
  });

  it('counts a push Github dropped or answered with a 5xx', () => {
    expect(
      isTransientGitError(
        gitError(
          'POST git-receive-pack (70103 bytes)\nerror: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly'
        )
      )
    ).toBe(true);
    expect(
      isTransientGitError(
        gitError(
          'To https://github.com/acme/hw1-alice.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (Internal Server Error)\nremote: Internal Server Error'
        )
      )
    ).toBe(true);
    expect(
      isTransientGitError(
        gitError(
          "To https://github.com/acme/hw1-alice.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (failure)\nDone\nPushing to https://github.com/acme/hw1-alice.git\nPOST git-receive-pack (376 bytes)\nremote: fatal error in commit_refs        \nerror: failed to push some refs to 'https://github.com/acme/hw1-alice.git'\n"
        )
      )
    ).toBe(true);
  });

  it('counts Github API 5xx, rate limits, and a request that died with no status', () => {
    expect(isTransientGitError(httpError(502, 'Bad Gateway'))).toBe(true);
    expect(isTransientGitError(httpError(503))).toBe(true);
    expect(isTransientGitError(httpError(429, 'rate limited'))).toBe(true);
    expect(isTransientGitError(httpError(undefined, ''))).toBe(true);
  });

  it('counts socket errors and follows a wrapped cause', () => {
    expect(
      isTransientGitError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    ).toBe(true);
    expect(
      isTransientGitError(new Error('wrapped', { cause: httpError(500, 'Server Error') }))
    ).toBe(true);
  });

  it('does not count what Github refused or what is missing', () => {
    expect(
      isTransientGitError(
        httpError(
          403,
          'Resource not accessible by integration - https://docs.github.com/rest/collaborators/collaborators#add-a-repository-collaborator'
        )
      )
    ).toBe(false);
    expect(
      isTransientGitError(
        httpError(404, 'Not Found - https://docs.github.com/rest/repos/repos#get-a-repository')
      )
    ).toBe(false);
    expect(
      isTransientGitError(
        gitError(
          "remote: Repository not found.\nfatal: repository 'https://github.com/acme/template.git/' not found"
        )
      )
    ).toBe(false);
    expect(
      isTransientGitError(
        new Error(
          'Assignment "HW1" has no usable template repository (template is ""). Set it to owner/name.'
        )
      )
    ).toBe(false);
    expect(
      isTransientGitError(
        Object.assign(new Error('Foreign key constraint violated'), { code: 'P2003' })
      )
    ).toBe(false);
    expect(isTransientGitError(undefined)).toBe(false);
  });
});

describe('retryOnGitBlip', () => {
  it('allows five attempts', () => {
    expect(GIT_BLIP_RETRY.maxAttempts).toBe(5);
    expect(retryOnGitBlip.retry).toBe(GIT_BLIP_RETRY);
  });

  it('lets a Github or database blip retry and stops everything else', async () => {
    expect(
      await retryOnGitBlip.catchError({
        error: gitError("Failed to connect to github.com port 443: Couldn't connect to server"),
      })
    ).toBeUndefined();
    expect(
      await retryOnGitBlip.catchError({
        error: Object.assign(new Error("Can't reach database server"), { errorCode: 'P1001' }),
      })
    ).toBeUndefined();
    expect(await retryOnGitBlip.catchError({ error: httpError(404, 'Not Found') })).toEqual({
      skipRetrying: true,
    });
  });

  it('schedules a throttled attempt instead of failing it', async () => {
    const before = Date.now();
    const result = await retryOnGitBlip.catchError({
      error: httpError(403, 'You have exceeded a secondary rate limit.'),
      ctx: { attempt: { number: 2 } },
    });
    const at = (result as { retryAt: Date }).retryAt.getTime();
    // attempt 2: at least 2 minutes, at most 2 minutes + 30s jitter
    expect(at - before).toBeGreaterThanOrEqual(2 * 60_000);
    expect(at - before).toBeLessThanOrEqual(2 * 60_000 + RATE_LIMIT_JITTER_MS + 1_000);
  });

  it('still stops at once on a permission 403', async () => {
    expect(
      await retryOnGitBlip.catchError({
        error: httpError(403, 'Resource not accessible by integration'),
      })
    ).toEqual({ skipRetrying: true });
  });
});

/** Shaped like Octokit's RequestError: status, message, response headers. */
const throttled = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { name: 'HttpError', status, response: { headers } });

describe('githubRateLimit', () => {
  const now = Date.parse('2026-11-08T20:00:00Z');

  it('recognizes a secondary limit sent as 403 or 429', () => {
    expect(githubRateLimit(throttled(403, 'You have exceeded a secondary rate limit.'))).toEqual({
      waitMs: null,
    });
    expect(githubRateLimit(throttled(429, 'Too Many Requests'))).toEqual({ waitMs: null });
  });

  it('reads retry-after in seconds', () => {
    expect(githubRateLimit(throttled(403, 'forbidden', { 'retry-after': '90' }))).toEqual({
      waitMs: 90_000,
    });
  });

  it('reads an exhausted primary limit until its reset', () => {
    const reset = String(now / 1000 + 600);
    expect(
      githubRateLimit(
        throttled(403, 'API rate limit exceeded for installation', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': reset,
        }),
        now
      )
    ).toEqual({ waitMs: 600_000 });
  });

  it('ignores a malformed retry-after and falls back to no stated wait', () => {
    expect(
      githubRateLimit(throttled(403, 'secondary rate limit', { 'retry-after': 'soon' }))
    ).toEqual({ waitMs: null });
  });

  it('does not treat a permission 403 or other errors as throttling', () => {
    expect(githubRateLimit(throttled(403, 'Resource not accessible by integration'))).toBeNull();
    expect(githubRateLimit(throttled(404, 'Not Found'))).toBeNull();
    expect(githubRateLimit(new Error('rate limit exceeded'))).toBeNull();
    expect(githubRateLimit(null)).toBeNull();
  });

  it('follows a wrapped cause', () => {
    expect(
      githubRateLimit(new Error('wrapped', { cause: throttled(429, 'Too Many Requests') }))
    ).toEqual({ waitMs: null });
  });
});

describe('rateLimitRetryAt', () => {
  const now = 1_000_000;
  const noJitter = () => 0;

  it('waits at least a minute, doubling per attempt up to 15 minutes', () => {
    const wait = (attempt: number) =>
      rateLimitRetryAt({ waitMs: null }, attempt, now, noJitter).getTime() - now;
    expect([1, 2, 3, 4, 5, 6].map(wait)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
  });

  it("never shortens Github's own wait, even past the backoff cap", () => {
    expect(rateLimitRetryAt({ waitMs: 3_600_000 }, 1, now, noJitter).getTime() - now).toBe(
      3_600_000
    );
    expect(rateLimitRetryAt({ waitMs: 5_000 }, 1, now, noJitter).getTime() - now).toBe(60_000);
  });

  it('adds up to 30 seconds of jitter', () => {
    const at = rateLimitRetryAt({ waitMs: null }, 1, now, () => 0.999).getTime() - now;
    expect(at).toBeGreaterThan(60_000);
    expect(at).toBeLessThan(60_000 + RATE_LIMIT_JITTER_MS);
  });
});

describe('readNewRepo', () => {
  const notFound = () =>
    gitError(
      "remote: Repository not found.\nfatal: repository 'https://github.com/acme/hw1-alice.git/' not found"
    );
  const noWait = (_ms: number) => Promise.resolve();

  it('waits out a repository git does not see yet', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce('');
    const wait = vi.fn(noWait);
    await expect(readNewRepo(read, [1, 2, 3], wait)).resolves.toBe('');
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1, 2]);
  });

  it("gives up after the last wait with git's error", async () => {
    const read = vi.fn().mockRejectedValue(notFound());
    await expect(readNewRepo(read, [1, 2], noWait)).rejects.toThrow('Repository not found');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('throws any other error at once', async () => {
    const read = vi.fn().mockRejectedValue(gitError('fatal: Authentication failed'));
    const wait = vi.fn(noWait);
    await expect(readNewRepo(read, [1, 2], wait)).rejects.toThrow('Authentication failed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
