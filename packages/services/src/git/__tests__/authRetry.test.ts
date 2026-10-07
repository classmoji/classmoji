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
    expect(isRetryableAuthFailure(httpError(401), 'POST')).toBe(true);
    expect(isRetryableAuthFailure(httpError(401), 'GET')).toBe(true);
  });

  it('retries a request that died with no status only when it is a read', () => {
    expect(isRetryableAuthFailure(httpError(undefined), 'GET')).toBe(true);
    expect(isRetryableAuthFailure(httpError(undefined), 'POST')).toBe(false);
  });

  it('leaves every other refusal alone', () => {
    expect(
      isRetryableAuthFailure(httpError(403, 'Resource not accessible by integration'), 'PUT')
    ).toBe(false);
    expect(isRetryableAuthFailure(httpError(404), 'GET')).toBe(false);
    expect(isRetryableAuthFailure(httpError(422), 'POST')).toBe(false);
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

  it('does not retry a write that failed without a status', async () => {
    const { octokit, call } = hooked();
    retryRejectedAuth(octokit, 'test', [1, 1], noWait);
    const request = vi.fn().mockRejectedValue(httpError(undefined));

    await expect(call(request, { method: 'POST', url: '/x' })).rejects.toBeDefined();
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
