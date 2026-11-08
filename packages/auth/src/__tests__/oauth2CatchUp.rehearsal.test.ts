/**
 * The last step of the CX-2 rehearsal on a Neon branch: the REAL `auth`
 * (../server.ts) on that branch refreshes one caught-up refresh token and
 * the result is a JWT the MCP would accept. See
 * plans/2026-11-04-security-catchup/b2-cx2-catchup.md for the whole
 * rehearsal.
 *
 * Not a regular test: skipped unless OAUTH_REHEARSAL_DATABASE_URL is set.
 * It resets nothing. It does write to that database, as the 1.7 server
 * does: booting seeds the MCP resource row, the first token signs with a new
 * key (`jwks`), and the grant rotates the token it is given. Point it at the
 * rehearsal branch only.
 *
 *   OAUTH_REHEARSAL_DATABASE_URL='<branch direct URL>' \
 *   OAUTH_REHEARSAL_CLIENT_ID='<client id>' \
 *   OAUTH_REHEARSAL_REFRESH_TOKEN='<legacy plaintext refresh token>' \
 *   [OAUTH_REHEARSAL_CLIENT_SECRET='<secret, for a confidential client>'] \
 *   npm test -- oauth2CatchUp.rehearsal
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const URL_ = process.env.OAUTH_REHEARSAL_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
    authEmail: { sendAuthOtp: vi.fn(async () => {}) },
    gitlabInstance: { oauthClient: vi.fn(), findByHost: vi.fn(async () => null) },
  },
}));

describe.skipIf(!URL_)('CX-2 rehearsal: refresh a caught-up token', () => {
  type Auth = typeof import('../server.ts');
  let server: Auth;
  let db: PrismaClient;
  const BASE = 'http://localhost:3000/api/auth';
  const clientId = process.env.OAUTH_REHEARSAL_CLIENT_ID ?? '';
  const refreshToken = process.env.OAUTH_REHEARSAL_REFRESH_TOKEN ?? '';
  const secret = process.env.OAUTH_REHEARSAL_CLIENT_SECRET;

  beforeAll(async () => {
    expect(clientId, 'OAUTH_REHEARSAL_CLIENT_ID').not.toBe('');
    expect(refreshToken, 'OAUTH_REHEARSAL_REFRESH_TOKEN').not.toBe('');
    const target = new URL(URL_!);
    console.log(`rehearsal database: ${target.hostname}${target.pathname}`);
    db = new PrismaClient({ datasourceUrl: URL_ });
    server = await import('../server.ts');
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('refreshes to a JWT for the MCP resource that the MCP would accept', async () => {
    const res = await server.auth.handler(
      new Request(`${BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(secret
            ? {
                authorization: `Basic ${Buffer.from(
                  `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`
                ).toString('base64')}`,
              }
            : {}),
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...(secret ? {} : { client_id: clientId }),
        }).toString(),
      })
    );
    const body = (await res.json()) as Record<string, any>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(typeof body.refresh_token).toBe('string');

    const claims = await server.verifyJwsAccessToken(body.access_token, {
      jwksFetch: async () => (await server.auth.handler(new Request(`${BASE}/jwks`))).json(),
      verifyOptions: { issuer: server.AUTH_ISSUER, audience: server.MCP_RESOURCE },
    });
    expect(claims).toMatchObject({ azp: clientId });

    // The MCP's consent check (apps/mcp/src/auth/jwtAccessToken.ts).
    const consent = await db.oauthConsent.findFirst({
      where: { clientId, userId: String(claims.sub) },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    expect(consent, 'a consent for (client, user)').toBeTruthy();
    expect(Number(claims.iat)).toBeGreaterThanOrEqual(
      Math.floor(consent!.createdAt.getTime() / 1000)
    );
    console.log(
      `refreshed: azp ${clientId}, sub ${String(claims.sub)}, aud ${String(claims.aud)}; consent check passes`
    );
  });
});
