/**
 * A failed GitHub or GitLab token refresh is reported (`github.token_refresh`,
 * `gitlab.token_refresh`) once, with what each call returned or threw before
 * unchanged. The expected refusal (`bad_refresh_token` / `invalid_grant`: the
 * person signs in again) and a Gitlab instance that is gone are not reported
 * at all (they recur on every request for that person); a missing client
 * id/secret is reported once per process; network, 5xx and unreadable answers
 * are reported each time. Reports carry the reason, status and OAuth error
 * code only, never a token or the provider's text. Nothing is reported
 * without a reporter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

const accountFindFirst = vi.fn();
const accountUpdate = vi.fn();
const oauthClientMock = vi.fn();
const gitlabFetchMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({ account: { findFirst: accountFindFirst, update: accountUpdate } }),
}));

vi.mock('../gitlabInstance.service.ts', () => {
  class GitLabInstanceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    GitLabInstanceError,
    oauthClient: (...a: unknown[]) => oauthClientMock(...a),
    gitlabFetch: (...a: unknown[]) => gitlabFetchMock(...a),
  };
});

const { getGitHubTokenForUser } = await import('../githubUserToken.service.ts');
const { getGitLabTokenForUser } = await import('../gitlabUserToken.service.ts');
const { GitLabInstanceError } = (await import('../gitlabInstance.service.ts')) as unknown as {
  GitLabInstanceError: new (code: string, message: string) => Error;
};

const REFRESH = 'ghr_refresh_secret_value';
const ACCESS = 'ghu_access_secret_value';

let captured: Array<{ error: unknown; context: ReportContext }>;
const reporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

const expiredAccount = {
  id: 'acct-1',
  account_id: 'gl-42',
  access_token: 'old',
  refresh_token: REFRESH,
  access_token_expires_at: new Date(0),
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Nothing secret in any report: not the refresh token, not the access token. */
const expectNoSecrets = () => {
  const text = JSON.stringify(
    captured.map(c => ({ m: (c.error as Error)?.message, ctx: c.context }))
  );
  expect(text).not.toContain(REFRESH);
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain('client-secret');
};

beforeEach(() => {
  vi.clearAllMocks();
  captured = [];
  setErrorReporter(reporter);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
  // First read: the expired account; the re-read after a failure: still expired.
  accountFindFirst.mockResolvedValue(expiredAccount);
  accountUpdate.mockResolvedValue({});
  oauthClientMock.mockResolvedValue({
    instanceId: null,
    host: 'https://gitlab.example',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
});

afterEach(() => {
  setErrorReporter(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('github.token_refresh', () => {
  it('bad_refresh_token: not reported, and null as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'bad_refresh_token', error_description: `token ${REFRESH} gone` })
      )
    );

    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it('another refusal code is an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'incorrect_client_credentials' }))
    );

    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'github.token_refresh',
      tags: { reason: 'refused', status: 200, code: 'incorrect_client_credentials' },
    });
  });

  it('a code that is not a plain code is left out of the tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: `Weird text ${REFRESH}` }))
    );

    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(captured[0].context.tags?.code).toBeUndefined();
    expectNoSecrets();
  });

  it('a network failure is reported as an error and still thrown', async () => {
    const failure = new TypeError('fetch failed');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw failure;
      })
    );

    await expect(getGitHubTokenForUser('user-1')).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'github.token_refresh',
      tags: { reason: 'network' },
    });
  });

  it('an unreadable 5xx answer is reported with its status and still thrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 502 }))
    );

    await expect(getGitHubTokenForUser('user-1')).rejects.toThrow(SyntaxError);
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'github.token_refresh',
      tags: { reason: 'unreadable_response', status: 502 },
    });
  });

  it('missing client credentials are reported once per process, and null as before', async () => {
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(await getGitHubTokenForUser('user-2')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured.map(c => c.context.tags?.reason)).toEqual(['not_configured']);
  });

  it('a successful refresh reports nothing and returns the new token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ access_token: ACCESS, refresh_token: 'r2', expires_in: 28800 })
      )
    );

    expect(await getGitHubTokenForUser('user-1')).toMatchObject({ token: ACCESS });
    expect(captured).toHaveLength(0);
  });

  it('without a reporter: same null, nothing captured', async () => {
    setErrorReporter(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'bad_refresh_token' }))
    );

    expect(await getGitHubTokenForUser('user-1')).toBeNull();
    expect(captured).toHaveLength(0);
  });
});

describe('gitlab.token_refresh', () => {
  it('invalid_grant: not reported, and null as before', async () => {
    gitlabFetchMock.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', error_description: `bad ${REFRESH}` }, 400)
    );

    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it('a 5xx is an error, without GitLab’s text', async () => {
    gitlabFetchMock.mockResolvedValue(new Response(`upstream said ${REFRESH}`, { status: 503 }));

    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'gitlab.token_refresh',
      tags: { reason: 'refused', status: 503, code: undefined },
    });
    expectNoSecrets();
  });

  it('a network failure is reported and still thrown', async () => {
    const failure = new Error('ECONNRESET');
    gitlabFetchMock.mockRejectedValue(failure);

    await expect(getGitLabTokenForUser('user-2')).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toEqual({
      surface: 'gitlab.token_refresh',
      tags: { reason: 'network' },
    });
  });

  it('an unreadable 200 answer is reported and still thrown', async () => {
    gitlabFetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(getGitLabTokenForUser('user-2')).rejects.toThrow(SyntaxError);
    expect(captured[0].context).toMatchObject({
      tags: { reason: 'unreadable_response', status: 200 },
    });
  });

  it('an instance that is gone is not reported; another client failure is', async () => {
    oauthClientMock.mockRejectedValueOnce(new GitLabInstanceError('not_found', 'gone'));
    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    oauthClientMock.mockRejectedValueOnce(new GitLabInstanceError('disabled', 'off'));
    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    oauthClientMock.mockRejectedValueOnce(new Error('decrypt failed'));
    expect(await getGitLabTokenForUser('user-3')).toBeNull();

    expect(captured.map(c => c.context.tags)).toEqual([{ reason: 'no_client', code: undefined }]);
    expect(gitlabFetchMock).not.toHaveBeenCalled();
  });

  it('gitlab.com not configured is reported once per process', async () => {
    oauthClientMock.mockRejectedValue(new GitLabInstanceError('not_configured', 'unset'));
    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    expect(await getGitLabTokenForUser('user-3')).toBeNull();

    expect(captured.map(c => c.context.tags)).toEqual([
      { reason: 'not_configured', code: 'not_configured' },
    ]);
  });

  it('a successful refresh reports nothing', async () => {
    gitlabFetchMock.mockResolvedValue(
      jsonResponse({ access_token: ACCESS, refresh_token: 'r2', expires_in: 7200 })
    );

    expect(await getGitLabTokenForUser('user-2')).toMatchObject({ token: ACCESS });
    expect(captured).toHaveLength(0);
  });

  it('without a reporter: same null, nothing captured', async () => {
    setErrorReporter(null);
    gitlabFetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    expect(await getGitLabTokenForUser('user-2')).toBeNull();
    expect(captured).toHaveLength(0);
  });
});
