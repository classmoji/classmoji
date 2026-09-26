/**
 * The user-token client used while a request waits (organization settings)
 * must REPORT a rate limit, not wait one out — the same wiring as
 * getAppOctokit (see GitHubProvider.getAppOctokit.test.ts). Drives the real
 * client against a stub `fetch`, then checks that the error it throws is the
 * one the organization settings service reports as RATE_LIMITED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';
import { toOrgRepoSettingsError } from '../../classmoji/orgRepoSettings.service.ts';

// Only the first test uses PATCH: the throttling plugin spaces write requests
// about a second apart, which is pacing rather than a rate-limit wait.

// Octokit's plugins narrate rate limits through `console`; keep the run quiet.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (status: number, message: string, headers: Record<string, string>) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ message }), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })
  );

describe('GitHubProvider.getImmediateUserOctokit', () => {
  it('throws a primary rate limit straight through, and it maps to RATE_LIMITED', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fetch = jsonResponse(403, 'API rate limit exceeded', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    });
    const octokit = GitHubProvider.getImmediateUserOctokit('ghu_token');

    const startedAt = Date.now();
    const error = await octokit
      .request('PATCH /orgs/{org}', { org: 'myorg', request: { fetch } })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(toOrgRepoSettingsError(error)).toMatchObject({ code: 'RATE_LIMITED', status: 403 });
  });

  it('throws a secondary limit (429) straight through, and it maps to RATE_LIMITED', async () => {
    const fetch = jsonResponse(429, 'You have exceeded a secondary rate limit', {
      'retry-after': '60',
    });
    const octokit = GitHubProvider.getImmediateUserOctokit('ghu_token');

    const startedAt = Date.now();
    const error = await octokit
      .request('GET /orgs/{org}', { org: 'myorg', request: { fetch } })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(toOrgRepoSettingsError(error)).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('maps an ordinary 403 to a refused change', async () => {
    const fetch = jsonResponse(403, 'Must be an organization owner', {
      'x-ratelimit-remaining': '4999',
    });
    const octokit = GitHubProvider.getImmediateUserOctokit('ghu_token');

    const error = await octokit
      .request('GET /orgs/{org}', { org: 'myorg', request: { fetch } })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(toOrgRepoSettingsError(error)).toMatchObject({ code: 'NOT_ORG_OWNER', status: 403 });
  });

  it('sends the user token', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ role: 'admin', state: 'active' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const octokit = GitHubProvider.getImmediateUserOctokit('ghu_token');
    await octokit.request('GET /user/memberships/orgs/{org}', {
      org: 'myorg',
      request: { fetch },
    });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('token ghu_token');
  });
});
