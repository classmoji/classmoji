/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma stand-in below
   accepts whatever argument shape better-auth's adapter passes. */
/**
 * Who may use the authorization server's token endpoint (/oauth2/token,
 * better-auth 1.7.18's oauth-provider through @better-auth/mcp), through the
 * REAL exported `auth` over `auth.handler`; only Prisma and the service layer
 * are stood in. The issuing side, on a real database, is in
 * ./oauth2.integration.test.ts.
 *
 *   - The Classmoji-owned client ids (Ask Moji, the dev mint) are reserved as
 *     disabled clients, so no grant ever names them, and an Ask Moji token
 *     (minted directly, never through this server) is no refresh token here.
 *   - A confidential client refreshes only with its secret, presented the way
 *     it registered; a disabled client gets nothing.
 *
 * Each case runs at /oauth2/token and at the 1.4 path /mcp/token, which the
 * webapp maps to it (../oauthHttp.ts, withLegacyMcpPathMapped): a client that
 * kept the old discovery document gets the same answers.
 *
 * oauth-provider authenticates the client before it looks the refresh token
 * up (`handleRefreshTokenGrant` → `validateClientCredentials`), so an unknown
 * refresh token that answers `invalid_grant` shows the client got through,
 * and `invalid_client` shows it did not.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const hashed = (value: string) => createHash('sha256').update(value).digest('base64url');

const mocks = vi.hoisted(() => {
  const clients: Record<string, any>[] = [];
  const refreshTokens: Record<string, any>[] = [];
  const noop = () => ({
    findFirst: vi.fn(() => Promise.resolve(null)),
    findUnique: vi.fn(() => Promise.resolve(null)),
    findMany: vi.fn(() => Promise.resolve([])),
    create: vi.fn(({ data }: any) => Promise.resolve(data)),
    update: vi.fn(({ data }: any) => Promise.resolve(data)),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    delete: vi.fn(() => Promise.resolve({})),
    deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    count: vi.fn(() => Promise.resolve(0)),
  });
  const client: any = {};
  for (const model of ['user', 'session', 'account', 'verification']) client[model] = noop();
  client.oauthClient = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(clients.find(c => c.clientId === where?.clientId) ?? null)
    ),
  };
  client.oauthRefreshToken = {
    ...noop(),
    findFirst: vi.fn(({ where }: any) =>
      Promise.resolve(refreshTokens.find(t => t.token === where?.token) ?? null)
    ),
  };
  client.Session = client.session;
  client.User = client.user;
  client.Account = client.account;
  client.Verification = client.verification;
  return { client, clients, refreshTokens };
});

vi.mock('@classmoji/database', async () => {
  const { standInClient } = await import('./support/prismaStandIn.ts');
  const client = standInClient(mocks.client);
  return { default: () => client };
});
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const { auth } = await import('../server.ts');
const { ASK_MOJI_CLIENT_ID } = await import('../mcpToken.ts');
const { withLegacyMcpPathMapped } = await import('../oauthHttp.ts');

const BASE = 'http://localhost:3000/api/auth';
const DEV_MINT_CLIENT_ID = 'classmoji-dev-mint';
const CONFIDENTIAL_SECRET = 'confidential-secret-value';

/** A client row as oauth-provider reads it. */
const clientRow = (over: Record<string, unknown>) => ({
  id: `row-${String(over.clientId)}`,
  clientSecret: null,
  disabled: false,
  redirectUris: ['http://localhost:9999/callback'],
  grantTypes: ['authorization_code', 'refresh_token'],
  responseTypes: ['code'],
  scopes: ['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
  tokenEndpointAuthMethod: 'none',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** The two reserved rows, as the migration and the seed write them. */
const reservedRow = (clientId: string) =>
  clientRow({
    clientId,
    disabled: true,
    redirectUris: [],
    grantTypes: [],
    responseTypes: [],
    scopes: [],
    tokenEndpointAuthMethod: 'client_secret_basic',
  });

/** The token endpoint path the cases below use (see describe.each at the end). */
let tokenPath = '/oauth2/token';

/** A request as the webapp hands it on: a 1.4 path mapped first. */
async function handled(request: Request) {
  return auth.handler(await withLegacyMcpPathMapped(request));
}

function tokenRequest(body: Record<string, string>, headers: Record<string, string> = {}) {
  return handled(
    new Request(`${BASE}${tokenPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    })
  );
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.refreshTokens.length = 0;
  mocks.clients.push(
    reservedRow(ASK_MOJI_CLIENT_ID),
    reservedRow(DEV_MINT_CLIENT_ID),
    clientRow({ clientId: 'public-client' }),
    clientRow({
      clientId: 'confidential-client',
      clientSecret: hashed(CONFIDENTIAL_SECRET),
      tokenEndpointAuthMethod: 'client_secret_basic',
    }),
    clientRow({
      clientId: 'disabled-client',
      clientSecret: hashed(CONFIDENTIAL_SECRET),
      tokenEndpointAuthMethod: 'client_secret_basic',
      disabled: true,
    })
  );
  vi.clearAllMocks();
});

describe.each([
  ['/oauth2/token', '/oauth2/authorize'],
  ['/mcp/token', '/mcp/authorize'],
])('at %s', (token, authorize) => {
  beforeEach(() => {
    tokenPath = token;
  });

  describe('the Classmoji-owned client ids', () => {
    it.each([[ASK_MOJI_CLIENT_ID], [DEV_MINT_CLIENT_ID]])(
      'refuse every grant naming %s (a disabled client)',
      async clientId => {
        for (const body of [
          { grant_type: 'refresh_token', refresh_token: 'askmoji-norefresh_abc' },
          {
            grant_type: 'authorization_code',
            code: 'any-code',
            redirect_uri: 'http://localhost:9999/callback',
            code_verifier: 'v'.repeat(43),
          },
        ] as Record<string, string>[]) {
          const res = await tokenRequest({ ...body, client_id: clientId });
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(await errorOf(res)).toBe('invalid_client');
        }
        expect(mocks.client.oauthRefreshToken.create).not.toHaveBeenCalled();
      }
    );

    it('do not let an Ask Moji token be refreshed through another client', async () => {
      // An Ask Moji token is never a refresh token on this server: the migration
      // copies none of the reserved clients' rows.
      const res = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'askmoji-norefresh_abc',
        client_id: 'public-client',
      });
      expect(await errorOf(res)).toBe('invalid_grant');
      expect(mocks.client.oauthRefreshToken.create).not.toHaveBeenCalled();
    });

    it('cannot start an authorization either', async () => {
      const url = new URL(`${BASE}${authorize}`);
      for (const [k, v] of Object.entries({
        client_id: ASK_MOJI_CLIENT_ID,
        response_type: 'code',
        redirect_uri: 'http://localhost:9999/callback',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
      })) {
        url.searchParams.set(k, v);
      }
      const res = await handled(new Request(url));
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('error=client_disabled');
    });

    // With no grant types the provider still assumes authorization_code
    // (`clientAllowsGrant`), so the disabled flag is what holds these ids.
    it('rely on the disabled flag: the same row enabled would be served', async () => {
      mocks.clients[0] = { ...reservedRow(ASK_MOJI_CLIENT_ID), disabled: false };
      const res = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'unknown',
        client_id: ASK_MOJI_CLIENT_ID,
        client_secret: 'anything',
      });
      // Past the disabled check, refused only for its (absent) secret.
      expect(await res.clone().text()).not.toContain('client is disabled');
    });
  });

  describe('a confidential client refreshes only with its secret', () => {
    const refresh = (headers: Record<string, string> = {}, body: Record<string, string> = {}) =>
      tokenRequest(
        { grant_type: 'refresh_token', refresh_token: 'not-a-known-token', ...body },
        headers
      );

    it('refuses a refresh with no client secret', async () => {
      const res = await refresh({}, { client_id: 'confidential-client' });
      expect(await errorOf(res)).toBe('invalid_client');
    });

    it('refuses a refresh with the wrong client secret', async () => {
      const res = await refresh({ authorization: basic('confidential-client', 'wrong') });
      expect(await errorOf(res)).toBe('invalid_client');
    });

    it('refuses the secret in the body when the client registered for Basic', async () => {
      const res = await refresh(
        {},
        { client_id: 'confidential-client', client_secret: CONFIDENTIAL_SECRET }
      );
      expect(await errorOf(res)).toBe('invalid_client');
    });

    it('lets the right secret through to the refresh token check', async () => {
      const res = await refresh({
        authorization: basic('confidential-client', CONFIDENTIAL_SECRET),
      });
      expect(await errorOf(res)).toBe('invalid_grant');
    });

    it('refuses a disabled client, secret or not', async () => {
      const res = await refresh({ authorization: basic('disabled-client', CONFIDENTIAL_SECRET) });
      expect(await errorOf(res)).toBe('invalid_client');
      expect(await refresh({}, { client_id: 'disabled-client' }).then(errorOf)).toBe(
        'invalid_client'
      );
    });

    it('leaves a public client refreshing without a secret', async () => {
      const res = await refresh({}, { client_id: 'public-client' });
      expect(await errorOf(res)).toBe('invalid_grant');
    });

    it('refuses a refresh token issued to another client', async () => {
      mocks.refreshTokens.push({
        id: 'rt-1',
        token: hashed('public-clients-token'),
        clientId: 'public-client',
        userId: 'user-1',
        scopes: ['read', 'offline_access'],
        resources: [],
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(),
      });
      const res = await refresh(
        { authorization: basic('confidential-client', CONFIDENTIAL_SECRET) },
        { refresh_token: 'public-clients-token' }
      );
      expect(await errorOf(res)).toBe('invalid_grant');
      expect(mocks.client.oauthRefreshToken.create).not.toHaveBeenCalled();
    });
  });
});
