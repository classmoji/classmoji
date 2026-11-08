/**
 * The two kinds of bearer the MCP server accepts, end to end: a real spawned
 * server on the seeded database, and tokens made the way production makes
 * them.
 *
 *   - Access tokens from the REAL OAuth server (./oauthServer.ts: open DCR,
 *     consent, code, token), including one refreshed from a grant copied from
 *     the 1.4 tables the way the migration copies it. Then what makes revoking
 *     at the server take effect: a disabled client, a ban, a disconnect, and a
 *     reconnect (the old token stays refused; CX-4), with the same-second
 *     edge.
 *   - Ask Moji tokens from the REAL `mintMcpAccessToken`, minted under a View
 *     as session: served with the session's admin on the audit rows, and
 *     refused once the session ends.
 *
 * Identities: fake-student-2 and fake-ta; every row this file changes is put
 * back (CleanupStack).
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  callTool,
  CleanupStack,
  DEV_REF,
  EXPECTED_CHALLENGE,
  getPrisma,
  loadFixtures,
  rpc,
  rpcRaw,
  startServer,
  type Fixtures,
  type ServerHandle,
} from './helpers.ts';

const {
  AUTH_ISSUER,
  MCP_RESOURCE,
  TOKEN_ENDPOINT,
  claimsOf,
  connectApp,
  deleteIssuedGrants,
  dpopProofs,
  registerClient,
  sessionCookie,
  tokenRequest,
} = await import('./oauthServer.ts');
const { mintMcpAccessToken, hashInternalToken } = await import('@classmoji/auth/mcp-token');

const prisma = getPrisma();
const cleanup = new CleanupStack();
const suiteStart = new Date();
let server: ServerHandle;
let fx: Fixtures;
let student: string;
let ta: string;

/** Status of a tools/list with this token. */
const statusOf = async (token: string) => (await rpcRaw(token, 'tools/list')).status;

/** whoami's userId for this token. */
async function whoami(token: string): Promise<string> {
  const outcome = await callTool(token, 'whoami', {});
  expect(outcome.isError).toBe(false);
  return outcome.payload.userId as string;
}

const sleepToNextSecond = () =>
  new Promise(resolve => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 50));

beforeAll(async () => {
  fx = await loadFixtures();
  student = fx.users['fake-student-2'].id;
  ta = fx.users['fake-ta'].id;
  server = await startServer();
});

afterAll(async () => {
  try {
    await cleanup.run();
    await deleteIssuedGrants();
    await prisma.auditLog.deleteMany({
      where: { timestamp: { gte: suiteStart }, user_id: { in: [student, ta] } },
    });
  } finally {
    await server?.stop();
  }
});

describe('an access token from the OAuth server', () => {
  it('is served: the user, the scopes it was granted, the MCP resource as audience', async () => {
    const clientId = await registerClient();
    const { access_token } = await connectApp(clientId, await sessionCookie(student));

    expect(claimsOf(access_token)).toMatchObject({
      iss: AUTH_ISSUER,
      aud: MCP_RESOURCE,
      azp: clientId,
      sub: student,
    });
    expect(MCP_RESOURCE).toBe(`${BASE}/mcp`);
    expect(await whoami(access_token)).toBe(student);

    const list = await rpc(access_token, 'tools/list');
    const names = (list.result?.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('whoami');
    expect(names).toContain('page_comment_create'); // a write tool: `write` was granted
  });

  it('is served when the client also asked for openid (the audience is then a list)', async () => {
    const clientId = await registerClient();
    const { access_token } = await connectApp(
      clientId,
      await sessionCookie(student),
      'openid read write'
    );
    const { aud } = claimsOf(access_token);
    expect(Array.isArray(aud) && aud.includes(MCP_RESOURCE)).toBe(true);
    expect(await whoami(access_token)).toBe(student);
  });

  it('is served when refreshed from a grant copied from the 1.4 tables', async () => {
    // As the migration copies them: the consent with no resources and a
    // millisecond creation time, the refresh token hashed with no resources
    // (the token endpoint adds the MCP resource on first use).
    const clientId = await registerClient();
    const refresh = `copied-${randomBytes(16).toString('hex')}`;
    await prisma.$executeRaw`
      INSERT INTO "oauth2_consents" ("id", "client_id", "user_id", "scopes", "created_at", "updated_at")
      VALUES (gen_random_uuid()::text, ${clientId}, ${student},
              ARRAY['offline_access', 'read', 'write']::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    await prisma.$executeRaw`
      INSERT INTO "oauth2_refresh_tokens" ("id", "token", "client_id", "user_id", "scopes", "expires_at", "created_at")
      VALUES (gen_random_uuid()::text,
              rtrim(translate(encode(sha256(convert_to(${refresh}, 'UTF8')), 'base64'), '+/', '-_'), '='),
              ${clientId}, ${student}, ARRAY['read', 'write', 'offline_access']::text[],
              CURRENT_TIMESTAMP + interval '30 days', CURRENT_TIMESTAMP)`;
    const consent = await prisma.oauthConsent.findFirstOrThrow({ where: { clientId } });
    expect(consent.resources).toEqual([]); // NULL, read by Prisma as []

    const { status, body } = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(claimsOf(body.access_token)).toMatchObject({ aud: MCP_RESOURCE, sub: student });
    expect(await whoami(body.access_token)).toBe(student);
  });

  it('is a Bearer token the server accepts when the client sent a DPoP proof, and refreshes with or without one', async () => {
    // A client that uses DPoP (RFC 9449) sends a proof with each token
    // request; the OAuth server reads none, so it answers with a Bearer
    // token, which the client then uses as one (§5).
    const proof = dpopProofs();
    const clientId = await registerClient();
    const issued = await connectApp(clientId, await sessionCookie(student), 'read write', {
      dpop: proof(TOKEN_ENDPOINT),
    });
    expect(issued.token_type).toBe('Bearer');
    expect(claimsOf(issued.access_token)).not.toHaveProperty('cnf');
    expect(await whoami(issued.access_token)).toBe(student);

    const withProof = await tokenRequest(
      { grant_type: 'refresh_token', refresh_token: issued.refresh_token!, client_id: clientId },
      { dpop: proof(TOKEN_ENDPOINT) }
    );
    expect(withProof.status, JSON.stringify(withProof.body)).toBe(200);
    expect(withProof.body.token_type).toBe('Bearer');
    expect(await whoami(withProof.body.access_token)).toBe(student);

    const without = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: withProof.body.refresh_token!,
      client_id: clientId,
    });
    expect(without.status, JSON.stringify(without.body)).toBe(200);
    expect(await whoami(without.body.access_token)).toBe(student);
  });

  describe('revoking at the server takes effect on the next request', () => {
    it('a disabled client', async () => {
      const clientId = await registerClient();
      const { access_token } = await connectApp(clientId, await sessionCookie(student));
      expect(await statusOf(access_token)).toBe(200);

      await prisma.oauthClient.update({ where: { clientId }, data: { disabled: true } });
      const refused = await rpcRaw(access_token, 'tools/list');
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);

      await prisma.oauthClient.update({ where: { clientId }, data: { disabled: false } });
      expect(await statusOf(access_token)).toBe(200);
    });

    it('a ban, until it ends', async () => {
      const clientId = await registerClient();
      const { access_token } = await connectApp(clientId, await sessionCookie(student));
      const restore = await prisma.user.findUniqueOrThrow({
        where: { id: student },
        select: { banned: true, ban_expires_at: true },
      });
      cleanup.add('fake-student-2 ban state', () =>
        prisma.user.update({ where: { id: student }, data: restore })
      );

      // Bypassing better-auth on purpose: its ban hook would also end the
      // grant (P2-10), and this is about the MCP server's own check.
      await prisma.user.update({
        where: { id: student },
        data: { banned: true, ban_expires_at: new Date(Date.now() + 3_600_000) },
      });
      expect(await statusOf(access_token)).toBe(401);

      await prisma.user.update({
        where: { id: student },
        data: { banned: true, ban_expires_at: new Date(Date.now() - 1_000) },
      });
      expect(await statusOf(access_token)).toBe(200);
      await prisma.user.update({ where: { id: student }, data: restore });
    });

    it('a disconnect (the consent deleted), and a reconnect leaves the old token refused', async () => {
      const clientId = await registerClient();
      const cookie = await sessionCookie(student);
      const first = await connectApp(clientId, cookie);
      expect(await statusOf(first.access_token)).toBe(200);

      await prisma.oauthConsent.deleteMany({ where: { clientId, userId: student } });
      expect(await statusOf(first.access_token)).toBe(401);

      // Reconnect in a later second than the first token's `iat`.
      await sleepToNextSecond();
      const second = await connectApp(clientId, cookie);
      expect(await statusOf(second.access_token)).toBe(200);
      expect(await statusOf(first.access_token)).toBe(401);
    });

    it('a token issued in the same second as its consent is served; one second earlier is not', async () => {
      const clientId = await registerClient();
      const { access_token } = await connectApp(clientId, await sessionCookie(student));
      const iat = claimsOf(access_token).iat as number;

      await prisma.oauthConsent.updateMany({
        where: { clientId, userId: student },
        data: { createdAt: new Date(iat * 1000 + 999) },
      });
      expect(await statusOf(access_token)).toBe(200);

      await prisma.oauthConsent.updateMany({
        where: { clientId, userId: student },
        data: { createdAt: new Date((iat + 1) * 1000) },
      });
      expect(await statusOf(access_token)).toBe(401);
    });
  });
});

describe('an Ask Moji token minted under View as', () => {
  let viewAsSessionId: string;
  let admin: string;

  beforeAll(async () => {
    admin = fx.users['fake-teacher'].id;
    const session = await prisma.session.create({
      data: {
        token: `mcp-it-viewas-${randomBytes(12).toString('hex')}`,
        user_id: ta,
        impersonatedBy: admin,
        expires_at: new Date(Date.now() + 3_600_000),
      },
    });
    viewAsSessionId = session.id;
    cleanup.add('View as session', () =>
      prisma.session.deleteMany({ where: { id: viewAsSessionId } })
    );
  });

  it('is stored hashed and served as the user, read-only', async () => {
    const { accessToken } = await mintMcpAccessToken(ta, {
      impersonationSessionId: viewAsSessionId,
    });
    const row = await prisma.mcpInternalToken.findUniqueOrThrow({
      where: { token_hash: hashInternalToken(accessToken) },
    });
    expect(row).toMatchObject({
      client_id: 'classmoji-ask-moji',
      user_id: ta,
      scopes: ['read'],
      impersonation_session_id: viewAsSessionId,
      impersonated_by: admin,
    });
    cleanup.add('Ask Moji token', () =>
      prisma.mcpInternalToken.deleteMany({ where: { token_hash: row.token_hash } })
    );

    expect(await whoami(accessToken)).toBe(ta);
    const list = await rpc(accessToken, 'tools/list');
    const names = (list.result?.tools as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('get_roster');
    expect(names).not.toContain('page_comment_create');
  });

  it('writes the View as admin and the client on the audit row of a read of others’ data', async () => {
    const { accessToken } = await mintMcpAccessToken(ta, {
      impersonationSessionId: viewAsSessionId,
    });
    cleanup.add('Ask Moji token', () =>
      prisma.mcpInternalToken.deleteMany({ where: { token_hash: hashInternalToken(accessToken) } })
    );
    const outcome = await callTool(accessToken, 'get_roster', { classroom: DEV_REF });
    expect(outcome.isError).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { user_id: ta, action: 'VIEW', timestamp: { gte: suiteStart } },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit?.data).toMatchObject({
      via: 'mcp',
      client_id: 'classmoji-ask-moji',
      impersonated_by: admin,
    });
  });

  it('is refused when its header names another admin', async () => {
    const { accessToken } = await mintMcpAccessToken(ta, {
      impersonationSessionId: viewAsSessionId,
    });
    cleanup.add('Ask Moji token', () =>
      prisma.mcpInternalToken.deleteMany({ where: { token_hash: hashInternalToken(accessToken) } })
    );
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        'x-classmoji-impersonated-by': fx.users['fake-student-1'].id,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('is refused once the View as session ends, and no new one is minted for it', async () => {
    const { accessToken } = await mintMcpAccessToken(ta, {
      impersonationSessionId: viewAsSessionId,
    });
    cleanup.add('Ask Moji token', () =>
      prisma.mcpInternalToken.deleteMany({ where: { token_hash: hashInternalToken(accessToken) } })
    );
    expect(await statusOf(accessToken)).toBe(200);

    await prisma.session.delete({ where: { id: viewAsSessionId } });
    expect(await statusOf(accessToken)).toBe(401);
    await expect(
      mintMcpAccessToken(ta, { impersonationSessionId: viewAsSessionId })
    ).rejects.toThrow(/View as session/);
  });

  it('an internal token that is not in the table is refused with the challenge', async () => {
    const res = await rpcRaw(`askmoji_${randomBytes(32).toString('base64url')}`, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);
  });
});
