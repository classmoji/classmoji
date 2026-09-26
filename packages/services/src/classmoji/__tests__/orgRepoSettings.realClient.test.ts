/**
 * The organization settings calls, driven through the REAL user-token client
 * (GitHubProvider.getImmediateUserOctokit) against a stub `fetch`, so the
 * Octokit plugin wiring is what is under test:
 *   - the owner check's timeout bounds the whole check: one request, no
 *     retries of the aborted request;
 *   - a GitHub server error on save is reported after one attempt, not after
 *     the retry plugin's backoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrgOwnerStatus, updateOrgRepoSettings } from '../orgRepoSettings.service.ts';

const ORG = { login: 'myorg', provider: 'GITHUB', github_installation_id: '123' };

// Octokit's plugins narrate retries and limits through `console`.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getOrgOwnerStatus with the real client', () => {
  it('gives up at the timeout after a single request', async () => {
    // Like fetch: never answers, and rejects when the request's signal aborts.
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    vi.stubGlobal('fetch', fetch);

    const timeoutMs = 300;
    const startedAt = Date.now();
    await expect(getOrgOwnerStatus('myorg', 'ghu_token', { timeoutMs })).resolves.toBe('unknown');
    const elapsed = Date.now() - startedAt;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(timeoutMs + 700);
  });

  it('reads an owner membership', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ role: 'admin', state: 'active' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    await expect(getOrgOwnerStatus('myorg', 'ghu_token')).resolves.toBe('owner');
  });
});

describe('updateOrgRepoSettings with the real client', () => {
  it('reports a GitHub server error after one attempt per request', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetch);

    const startedAt = Date.now();
    await expect(
      updateOrgRepoSettings({
        gitOrganization: ORG,
        userToken: 'ghu_token',
        input: { default_repository_permission: 'read' },
      })
    ).rejects.toMatchObject({ code: 'GITHUB_ERROR', status: 500 });
    const elapsed = Date.now() - startedAt;

    // One GET for the current values, one PATCH; neither retried.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
