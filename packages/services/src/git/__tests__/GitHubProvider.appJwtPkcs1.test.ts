/**
 * The GitHub App key Github hands out is PKCS#1 (`BEGIN RSA PRIVATE KEY`).
 * Octokit signs the App JWT itself (universal-github-app-jwt), for both the
 * app client and the installation-token exchange behind every installation
 * client, so check both with a PKCS#1 key: the JWT verifies against the public
 * key, and the installation token it mints is what the next request sends.
 * Drives the real clients against a stubbed global `fetch`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// The module reads both of these once, at import time.
process.env.GITHUB_APP_ID = '424242';
process.env.GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(privateKey).toString('base64');

let GitHubProvider: typeof import('../GitHubProvider.ts').GitHubProvider;

beforeAll(async () => {
  ({ GitHubProvider } = await import('../GitHubProvider.ts'));
});

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const bearer = (init: RequestInit | undefined) => {
  const headers = new Headers(init?.headers);
  return headers.get('authorization') ?? '';
};

describe('App JWT from a PKCS#1 key', () => {
  it('signs a JWT for the app client that verifies against the public key', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json(200, []));

    await GitHubProvider.getAppOctokit().request('GET /app/installations', {
      request: { fetch },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const token = bearer(fetch.mock.calls[0][1]).replace(/^bearer /i, '');
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(String(claims.iss)).toBe('424242');
  });

  it('mints an installation token with it and sends that token', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/app/installations/77/access_tokens')) {
        return json(201, {
          token: 'ghs_installation',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: 'all',
        });
      }
      return json(200, {
        id: 5_000_000_001,
        number: 3,
        html_url: 'https://github.com/o/r/issues/3',
        state: 'open',
      });
    });
    vi.stubGlobal('fetch', fetch);

    const issue = await new GitHubProvider('77', 'o').getIssue('o', 'r', 3);

    expect(issue).toEqual({
      id: 5_000_000_001,
      number: 3,
      url: 'https://github.com/o/r/issues/3',
      state: 'open',
    });
    const [tokenCall, issueCall] = fetch.mock.calls;
    const appJwt = bearer(tokenCall[1]).replace(/^bearer /i, '');
    expect(() => jwt.verify(appJwt, publicKey, { algorithms: ['RS256'] })).not.toThrow();
    expect(bearer(issueCall[1])).toMatch(/^token ghs_installation$/i);
  });
});
