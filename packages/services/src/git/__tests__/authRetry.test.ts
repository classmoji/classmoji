import { describe, expect, it, vi } from 'vitest';
import { describeGithubError, isRetryableAuthFailure, retryRejectedAuth } from '../authRetry.ts';

const httpError = (status: number | undefined, message = '') =>
  Object.assign(new Error(message), { name: 'HttpError', status });

/** A stand-in for Octokit's hook: `wrap` installs the wrapper we test. */
const hooked = () => {
  let wrapper:
    | ((request: (o: object) => Promise<unknown>, options: object) => Promise<unknown>)
    | null = null;
  return {
    octokit: { hook: { wrap: (_name: string, fn: typeof wrapper) => (wrapper = fn) } },
    call: (request: (o: object) => Promise<unknown>, options: object) => wrapper!(request, options),
  };
};

const noWait = () => Promise.resolve();

describe('isRetryableAuthFailure', () => {
  it('retries a 401 for any method', () => {
    expect(isRetryableAuthFailure(httpError(401), 'POST', '/repos/{owner}/{repo}/issues')).toBe(
      true
    );
    expect(isRetryableAuthFailure(httpError(401), 'GET')).toBe(true);
  });

  it('retries a 5xx or a dropped connection on idempotent methods', () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
      expect(isRetryableAuthFailure(httpError(500), method)).toBe(true);
      expect(isRetryableAuthFailure(httpError(undefined), method)).toBe(true);
    }
    expect(
      isRetryableAuthFailure(
        httpError(503),
        'PUT',
        '/orgs/{org}/teams/{team_slug}/memberships/{username}'
      )
    ).toBe(true);
  });

  it('retries a 5xx on creating a repository or a team, whose repeat GitHub refuses', () => {
    expect(isRetryableAuthFailure(httpError(500), 'POST', '/orgs/{org}/repos')).toBe(true);
    expect(isRetryableAuthFailure(httpError(500), 'POST', '/orgs/{org}/teams')).toBe(true);
  });

  it('never retries any other POST, which could do the work twice', () => {
    expect(isRetryableAuthFailure(httpError(500), 'POST', '/repos/{owner}/{repo}/issues')).toBe(
      false
    );
    expect(
      isRetryableAuthFailure(httpError(undefined), 'POST', '/repos/{owner}/{repo}/pulls')
    ).toBe(false);
  });

  it('leaves every other refusal alone', () => {
    expect(
      isRetryableAuthFailure(httpError(403, 'Resource not accessible by integration'), 'PUT')
    ).toBe(false);
    expect(isRetryableAuthFailure(httpError(404), 'GET')).toBe(false);
    expect(isRetryableAuthFailure(httpError(422), 'POST', '/orgs/{org}/teams')).toBe(false);
  });
});

describe('retryRejectedAuth', () => {
  it('succeeds once GitHub accepts the token', async () => {
    const { octokit, call } = hooked();
    retryRejectedAuth(octokit, 'test', [1, 1, 1], noWait);
    const request = vi
      .fn()
      .mockRejectedValueOnce(httpError(401))
      .mockRejectedValueOnce(httpError(401))
      .mockResolvedValue({ status: 201 });

    await expect(call(request, { method: 'POST', url: '/orgs/acme/repos' })).resolves.toEqual({
      status: 201,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last wait and throws the original error', async () => {
    const { octokit, call } = hooked();
    retryRejectedAuth(octokit, 'test', [1, 1], noWait);
    const error = httpError(401);
    const request = vi.fn().mockRejectedValue(error);

    await expect(call(request, { method: 'POST', url: '/x' })).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rides out a spell of empty 500s on a team write', async () => {
    const { octokit, call } = hooked();
    retryRejectedAuth(octokit, 'test', [1, 1, 1, 1], noWait);
    const request = vi
      .fn()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue({ status: 201 });

    await expect(call(request, { method: 'POST', url: '/orgs/{org}/teams' })).resolves.toEqual({
      status: 201,
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not retry opening an issue that failed with a 500', async () => {
    const { octokit, call } = hooked();
    retryRejectedAuth(octokit, 'test', [1, 1], noWait);
    const request = vi.fn().mockRejectedValue(httpError(500));

    await expect(
      call(request, { method: 'POST', url: '/repos/{owner}/{repo}/issues' })
    ).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('describeGithubError', () => {
  it('names the status, request id and endpoint', () => {
    const error = Object.assign(httpError(401), {
      response: { headers: { 'x-github-request-id': 'ABCD:1234' } },
    });
    expect(describeGithubError(error, { method: 'POST', url: '/orgs/acme/repos' })).toBe(
      'status 401 | request ABCD:1234 | POST /orgs/acme/repos | no message'
    );
  });
});
