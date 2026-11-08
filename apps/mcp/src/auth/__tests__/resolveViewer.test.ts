/**
 * Unit tests for resolveViewer — the single token-validation seam (plan §3.2).
 *
 * Two kinds of bearer are accepted, and nothing else:
 *   - internal tokens (`askmoji_…`), found by their SHA-256 in
 *     `mcp_internal_tokens` (internalToken.ts);
 *   - JWT access tokens the OAuth server signs (jwtAccessToken.ts), verified
 *     with better-auth's REAL verifier (core's `verifyJwsAccessToken`, on the
 *     root jose) against a key set this file generates; then liveness reads
 *     of the client, the user and the consent.
 *
 * Only the key read (`auth.api.getJwks`) and Prisma stand in. Prisma is the
 * DMMF-validating stub, so a misspelled column in any of these reads fails
 * the test instead of production. The real database path is covered by
 * jwksStoreUnavailable.test.ts and the integration suites.
 *
 * The verifier caches the key set for five minutes and refetches it at most
 * every 30 seconds. `Date` is faked and moved ten minutes on before every
 * test, so each test starts with an expired cache and no refetch pause.
 */

import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenStoreUnavailableError, UnauthorizedError } from '../../mcp/errors.ts';

const mocks = vi.hoisted(() => ({ getJwks: vi.fn() }));

vi.mock('@classmoji/auth/server', async () => ({
  auth: { api: { getJwks: (...args: unknown[]) => mocks.getJwks(...args) } },
  // The real verifier, as packages/auth/src/server.ts re-exports it.
  verifyJwsAccessToken: (await import('better-auth/oauth2')).verifyJwsAccessToken,
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const { bearerFrom, resolveViewer } = await import('../resolveViewer.ts');
const { prismaCalls, prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');
const { AUTH_ISSUER, MCP_RESOURCE } = await import('@classmoji/auth/mcp-resource');
const { ASK_MOJI_CLIENT_ID, DEV_MINT_CLIENT_ID } = await import('@classmoji/auth/mcp-token');

const clientVersion = '6.19.3';
const storeDown = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
    code: 'P1001',
    clientVersion,
  });
const otherFailure = () =>
  new Prisma.PrismaClientKnownRequestError('Inconsistent column data', {
    code: 'P2023',
    clientVersion,
  });

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');

/** The failure resolveViewer rejected with. */
const failureOf = (headers: Headers) => resolveViewer(headers).catch((error: unknown) => error);

let clock = Date.UTC(2026, 10, 7, 12, 0, 0);
beforeEach(() => {
  clock += 10 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  resetPrismaStub();
  mocks.getJwks.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bearerFrom', () => {
  it('reads the token of a Bearer header, the scheme in any case', () => {
    expect(bearerFrom(new Headers({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
    expect(bearerFrom(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
    expect(bearerFrom(new Headers({ authorization: 'BEARER  abc' }))).toBe('abc');
  });

  it('reads nothing from another scheme, an empty token or two tokens', () => {
    for (const value of ['Basic abc', 'DPoP abc', 'Bearer', 'Bearer ', 'Bearer a b', 'abc']) {
      expect(bearerFrom(new Headers({ authorization: value })), value).toBeNull();
    }
    expect(bearerFrom(new Headers())).toBeNull();
  });
});

describe('a bearer that is neither kind', () => {
  it('is refused without reading anything', async () => {
    for (const headers of [
      new Headers(),
      bearer('dev-0123456789abcdef'), // the 1.4-era dev mint
      bearer('AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf'), // a 1.4-era OAuth access token
      bearer('askmoji'),
      new Headers({ authorization: 'DPoP eyJ.eyJ.sig' }),
    ]) {
      const failure = await failureOf(headers);
      expect(failure).toBeInstanceOf(UnauthorizedError);
    }
    expect(prismaCalls).toHaveLength(0);
    expect(mocks.getJwks).not.toHaveBeenCalled();
  });
});

// ─── Internal tokens ─────────────────────────────────────────────────────────

describe('an internal token', () => {
  const TOKEN = 'askmoji_unit-test-token-0123456789';

  interface Row {
    client_id: string;
    user_id: string;
    scopes: string[];
    expires_at: Date;
    impersonation_session_id: string | null;
    impersonated_by: string | null;
    user: { banned: boolean; ban_expires_at: Date | null };
  }

  const rowOf = (overrides: Partial<Row> = {}): Row => ({
    client_id: ASK_MOJI_CLIENT_ID,
    user_id: 'user-1',
    scopes: ['read'],
    expires_at: new Date(Date.now() + 30 * 60_000),
    impersonation_session_id: null,
    impersonated_by: null,
    user: { banned: false, ban_expires_at: null },
    ...overrides,
  });

  /** The table: one row, under the hash of TOKEN. */
  const tokenRow = (row: Row | (() => never) | null) =>
    setPrismaRows({
      mcpInternalToken: {
        findUnique: (args: { where: { token_hash: string } }) => {
          if (typeof row === 'function') return row();
          return args.where.token_hash === sha256(TOKEN) ? row : null;
        },
      },
    });

  const sessionRow = (row: unknown) => setPrismaRows({ session: { findUnique: row } });

  it('resolves to the row’s user, client and scopes, looked up by its hash', async () => {
    tokenRow(rowOf());
    const viewer = await resolveViewer(bearer(TOKEN));

    expect(viewer).toEqual({
      tokenKind: 'internal',
      userId: 'user-1',
      clientId: ASK_MOJI_CLIENT_ID,
      scopes: new Set(['read']),
      impersonatedBy: null,
    });
    const [lookup] = prismaCallsFor('mcpInternalToken', 'findUnique');
    expect((lookup.args as { where: unknown }).where).toEqual({ token_hash: sha256(TOKEN) });
    // The raw token is never sent to the database.
    expect(JSON.stringify(prismaCalls)).not.toContain(TOKEN);
  });

  it('resolves a dev mint row to its own client', async () => {
    tokenRow(rowOf({ client_id: DEV_MINT_CLIENT_ID, scopes: ['read', 'write'] }));
    const viewer = await resolveViewer(bearer(TOKEN));
    expect(viewer.clientId).toBe(DEV_MINT_CLIENT_ID);
    expect([...viewer.scopes]).toEqual(['read', 'write']);
  });

  it('gives a row with no scopes none', async () => {
    tokenRow(rowOf({ scopes: [] }));
    expect((await resolveViewer(bearer(TOKEN))).scopes.size).toBe(0);
  });

  it('refuses a token that is not in the table (401, never 503)', async () => {
    tokenRow(null);
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a row naming a client other than the two internal ones', async () => {
    tokenRow(rowOf({ client_id: 'claude-connector' }));
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
  });

  it('refuses an expired token, the boundary exclusive', async () => {
    tokenRow(rowOf({ expires_at: new Date(Date.now() - 1) }));
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    tokenRow(rowOf({ expires_at: new Date(Date.now()) }));
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    tokenRow(rowOf({ expires_at: new Date(Date.now() + 1) }));
    await expect(resolveViewer(bearer(TOKEN))).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('refuses a banned user until the ban ends', async () => {
    tokenRow(rowOf({ user: { banned: true, ban_expires_at: null } }));
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    tokenRow(rowOf({ user: { banned: true, ban_expires_at: new Date(Date.now() + 60_000) } }));
    expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    tokenRow(rowOf({ user: { banned: true, ban_expires_at: new Date(Date.now() - 60_000) } }));
    await expect(resolveViewer(bearer(TOKEN))).resolves.toMatchObject({ userId: 'user-1' });
  });

  describe('minted under View as', () => {
    const bound = (overrides: Partial<Row> = {}) =>
      rowOf({ impersonation_session_id: 'sess-1', impersonated_by: 'admin-1', ...overrides });
    const liveSession = (overrides: Record<string, unknown> = {}) => ({
      user_id: 'user-1',
      impersonatedBy: 'admin-1',
      expires_at: new Date(Date.now() + 30 * 60_000),
      ...overrides,
    });

    it('resolves with the row’s admin while the session lives', async () => {
      tokenRow(bound());
      sessionRow(liveSession());
      const viewer = await resolveViewer(bearer(TOKEN));
      expect(viewer.impersonatedBy).toBe('admin-1');
      const [lookup] = prismaCallsFor('session', 'findUnique');
      expect((lookup.args as { where: unknown }).where).toEqual({ id: 'sess-1' });
    });

    it('refuses once the session is gone', async () => {
      tokenRow(bound());
      sessionRow(null);
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('refuses once the session has expired', async () => {
      tokenRow(bound());
      sessionRow(liveSession({ expires_at: new Date(Date.now()) }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a session of another user', async () => {
      tokenRow(bound());
      sessionRow(liveSession({ user_id: 'user-2' }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a session that names another admin, or none', async () => {
      tokenRow(bound());
      sessionRow(liveSession({ impersonatedBy: 'admin-2' }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
      sessionRow(liveSession({ impersonatedBy: null }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a row with an admin but no session, or a session but no admin', async () => {
      sessionRow(liveSession());
      tokenRow(bound({ impersonation_session_id: null }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
      tokenRow(bound({ impersonated_by: null }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('refuses a token bound to a session that is not a View as session', async () => {
      tokenRow(bound({ impersonated_by: null }));
      sessionRow(liveSession({ impersonatedBy: null }));
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(UnauthorizedError);
    });

    it('answers 503 when the session read fails because the store is unavailable', async () => {
      tokenRow(bound());
      sessionRow(() => {
        throw storeDown();
      });
      expect(await failureOf(bearer(TOKEN))).toBeInstanceOf(TokenStoreUnavailableError);
    });
  });

  it('answers 503 when the token read fails because the store is unavailable', async () => {
    const error = storeDown();
    tokenRow(() => {
      throw error;
    });
    const failure = await failureOf(bearer(TOKEN));
    expect(failure).toBeInstanceOf(TokenStoreUnavailableError);
    expect((failure as Error).cause).toBe(error);
  });

  it('passes any other read failure on unchanged (the route answers 401)', async () => {
    const error = otherFailure();
    tokenRow(() => {
      throw error;
    });
    expect(await failureOf(bearer(TOKEN))).toBe(error);
  });
});

// ─── JWT access tokens ───────────────────────────────────────────────────────

describe('a JWT access token', () => {
  const b64 = (value: unknown) =>
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

  interface SigningKey {
    kid: string;
    jwk: Record<string, unknown>;
    privateKey: KeyObject;
  }
  const keyPair = (kid: string): SigningKey => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { kid, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' }, privateKey };
  };
  const SERVER_KEY = keyPair('server-key-1');

  const signed = (
    payload: Record<string, unknown>,
    { key = SERVER_KEY, header = {} }: { key?: SigningKey; header?: Record<string, unknown> } = {}
  ) => {
    const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: key.kid, ...header })}.${b64(payload)}`;
    return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString('base64url')}`;
  };

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const claims = (overrides: Record<string, unknown> = {}) => {
    const iat = nowSeconds();
    return {
      sub: 'user-1',
      azp: 'client-1',
      client_id: 'client-1',
      aud: MCP_RESOURCE,
      iss: AUTH_ISSUER,
      scope: 'read write offline_access',
      iat,
      exp: iat + 3600,
      jti: 'jti-1',
      ...overrides,
    };
  };

  /** The server's key set, as `auth.api.getJwks` answers. */
  const serveKeys = (...keys: SigningKey[]) =>
    mocks.getJwks.mockResolvedValue({ keys: keys.map(k => k.jwk) });

  type Rows = {
    clients?: Record<string, { disabled: boolean | null }>;
    users?: Record<string, { banned: boolean; ban_expires_at: Date | null }>;
    consents?: Array<{ clientId: string; userId: string; createdAt: Date }>;
  };
  const live = (rows: Rows = {}) => {
    const clients = rows.clients ?? { 'client-1': { disabled: false } };
    const users = rows.users ?? { 'user-1': { banned: false, ban_expires_at: null } };
    const consents = rows.consents ?? [
      { clientId: 'client-1', userId: 'user-1', createdAt: new Date(Date.now() - 86_400_000) },
    ];
    setPrismaRows({
      oauthClient: {
        findUnique: (a: { where: { clientId: string } }) => clients[a.where.clientId] ?? null,
      },
      user: { findUnique: (a: { where: { id: string } }) => users[a.where.id] ?? null },
      oauthConsent: {
        findFirst: (a: { where: { clientId: string; userId: string } }) =>
          consents
            .filter(c => c.clientId === a.where.clientId && c.userId === a.where.userId)
            .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null,
      },
    });
  };

  beforeEach(() => {
    serveKeys(SERVER_KEY);
    live();
  });

  const refused = async (token: string) =>
    expect(await failureOf(bearer(token))).toBeInstanceOf(UnauthorizedError);

  it('resolves to sub, azp and the scope claim, after the three liveness reads', async () => {
    const viewer = await resolveViewer(bearer(signed(claims())));

    expect(viewer).toEqual({
      tokenKind: 'jwt',
      userId: 'user-1',
      clientId: 'client-1',
      scopes: new Set(['read', 'write', 'offline_access']),
      impersonatedBy: null,
    });
    expect(prismaCallsFor('oauthClient', 'findUnique')[0].args).toMatchObject({
      where: { clientId: 'client-1' },
    });
    expect(prismaCallsFor('user', 'findUnique')[0].args).toMatchObject({
      where: { id: 'user-1' },
    });
    expect(prismaCallsFor('oauthConsent', 'findFirst')[0].args).toMatchObject({
      where: { clientId: 'client-1', userId: 'user-1' },
    });
  });

  it('reads the keys in process, and once for a burst of requests', async () => {
    const token = signed(claims());
    await resolveViewer(bearer(token));
    await resolveViewer(bearer(token));
    await resolveViewer(bearer(token));
    expect(mocks.getJwks).toHaveBeenCalledTimes(1);
  });

  it('accepts an audience list that names the MCP resource (a client that asked for openid)', async () => {
    await expect(
      resolveViewer(
        bearer(signed(claims({ aud: [MCP_RESOURCE, `${AUTH_ISSUER}/api/auth/oauth2/userinfo`] })))
      )
    ).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('refuses any other audience', async () => {
    await refused(signed(claims({ aud: new URL(MCP_RESOURCE).origin })));
    await refused(signed(claims({ aud: `${MCP_RESOURCE}/` })));
    await refused(signed(claims({ aud: 'https://elsewhere.example/mcp' })));
    await refused(signed(claims({ aud: [`${AUTH_ISSUER}/api/auth/oauth2/userinfo`] })));
    await refused(signed(claims({ aud: undefined })));
  });

  it('refuses another issuer', async () => {
    await refused(signed(claims({ iss: `${AUTH_ISSUER}/api/auth` })));
    await refused(signed(claims({ iss: 'https://evil.example' })));
    await refused(signed(claims({ iss: undefined })));
  });

  it('refuses an expired token', async () => {
    await refused(signed(claims({ exp: nowSeconds() - 1 })));
    await refused(signed(claims({ exp: undefined })));
  });

  it('refuses a token that is not an access token (typ)', async () => {
    await refused(signed(claims(), { header: { typ: 'JWT' } }));
    await refused(signed(claims(), { header: { typ: undefined } }));
  });

  it('refuses a token without sub, azp or iat', async () => {
    await refused(signed(claims({ sub: undefined })));
    await refused(signed(claims({ azp: undefined })));
    await refused(signed(claims({ iat: undefined })));
    await refused(signed(claims({ sub: '' })));
  });

  it('refuses a sender-constrained (DPoP) token', async () => {
    await refused(signed(claims({ cnf: { jkt: 'thumbprint' } })));
  });

  it('refuses a token whose header is not a JSON object naming its key, before any key read', async () => {
    const payload = b64(claims());
    const signature = signed(claims()).split('.')[2];
    for (const header of [
      'aaaa', // not JSON
      b64('[1]'), // JSON, not an object
      b64('null'),
      b64({ alg: 'EdDSA', typ: 'at+jwt' }), // no kid
      b64({ alg: 'EdDSA', typ: 'at+jwt', kid: 7 }),
      b64({ alg: 'EdDSA', typ: 'at+jwt', kid: '' }),
    ]) {
      const failure = await failureOf(bearer(`${header}.${payload}.${signature}`));
      expect(failure, header).toBeInstanceOf(UnauthorizedError);
    }
    expect(await failureOf(bearer('aaaa.bbbb.cccc'))).toBeInstanceOf(UnauthorizedError);
    expect(mocks.getJwks).not.toHaveBeenCalled();
  });

  it('refuses a token that more than one of the keys fits', async () => {
    const twin = keyPair(SERVER_KEY.kid);
    serveKeys(SERVER_KEY, twin);
    expect(await failureOf(bearer(signed(claims())))).toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a token signed with no algorithm (alg none)', async () => {
    const token = `${b64({ alg: 'none', typ: 'at+jwt' })}.${b64(claims())}.`;
    await refused(token);
  });

  it('refuses an HS256 token keyed with the public key', async () => {
    const input = `${b64({ alg: 'HS256', typ: 'at+jwt', kid: SERVER_KEY.kid })}.${b64(claims())}`;
    for (const secret of [String(SERVER_KEY.jwk.x), JSON.stringify(SERVER_KEY.jwk)]) {
      const mac = createHmac('sha256', secret).update(input).digest('base64url');
      await refused(`${input}.${mac}`);
    }
  });

  it('refuses a token whose claims were changed after signing', async () => {
    const [header, , signature] = signed(claims()).split('.');
    await refused(`${header}.${b64(claims({ sub: 'user-2' }))}.${signature}`);
  });

  it('refuses a token signed by a key the server does not have', async () => {
    await refused(signed(claims(), { key: keyPair('server-key-1') }));
    await refused(signed(claims(), { key: keyPair('stranger') }));
  });

  it('refetches the keys for a key it has not seen (a rotation), at most every 30 s', async () => {
    const next = keyPair('server-key-2');
    await resolveViewer(bearer(signed(claims())));
    expect(mocks.getJwks).toHaveBeenCalledTimes(1);

    serveKeys(SERVER_KEY, next);
    await expect(resolveViewer(bearer(signed(claims(), { key: next })))).resolves.toMatchObject({
      userId: 'user-1',
    });
    expect(mocks.getJwks).toHaveBeenCalledTimes(2);

    // Another unknown key within 30 s: no refetch, refused.
    await refused(signed(claims(), { key: keyPair('server-key-3') }));
    expect(mocks.getJwks).toHaveBeenCalledTimes(2);
  });

  it.each([[ASK_MOJI_CLIENT_ID], [DEV_MINT_CLIENT_ID]])(
    'refuses a token issued to the reserved client %s, before any liveness read',
    async reserved => {
      live({ clients: { [reserved]: { disabled: false } } });
      await refused(signed(claims({ azp: reserved, client_id: reserved })));
      expect(prismaCallsFor('oauthClient')).toHaveLength(0);
      expect(prismaCallsFor('oauthConsent')).toHaveLength(0);
    }
  );

  it('refuses a token of a client that is disabled or gone', async () => {
    live({ clients: { 'client-1': { disabled: true } } });
    await refused(signed(claims()));
    live({ clients: {} });
    await refused(signed(claims()));
    live({ clients: { 'client-1': { disabled: null } } });
    await expect(resolveViewer(bearer(signed(claims())))).resolves.toMatchObject({
      clientId: 'client-1',
    });
  });

  it('refuses a token of a user who is banned (until the ban ends) or gone', async () => {
    live({ users: { 'user-1': { banned: true, ban_expires_at: null } } });
    await refused(signed(claims()));
    live({
      users: { 'user-1': { banned: true, ban_expires_at: new Date(Date.now() + 60_000) } },
    });
    await refused(signed(claims()));
    live({ users: {} });
    await refused(signed(claims()));
    live({
      users: { 'user-1': { banned: true, ban_expires_at: new Date(Date.now() - 60_000) } },
    });
    await expect(resolveViewer(bearer(signed(claims())))).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('refuses a token once the app is disconnected (no consent)', async () => {
    live({ consents: [] });
    await refused(signed(claims()));
    // A consent of the same user with another client, or the same client with
    // another user, is not this connection.
    live({
      consents: [
        { clientId: 'client-2', userId: 'user-1', createdAt: new Date(0) },
        { clientId: 'client-1', userId: 'user-2', createdAt: new Date(0) },
      ],
    });
    await refused(signed(claims()));
  });

  describe('the reconnect watermark (CX-4)', () => {
    it('refuses a token issued before the consent was given', async () => {
      const iat = nowSeconds();
      live({
        consents: [
          { clientId: 'client-1', userId: 'user-1', createdAt: new Date((iat + 1) * 1000) },
        ],
      });
      await refused(signed(claims({ iat })));
    });

    it('accepts a token issued in the same second, consent milliseconds later', async () => {
      const iat = nowSeconds();
      for (const ms of [0, 1, 999]) {
        live({
          consents: [
            { clientId: 'client-1', userId: 'user-1', createdAt: new Date(iat * 1000 + ms) },
          ],
        });
        await expect(resolveViewer(bearer(signed(claims({ iat }))))).resolves.toMatchObject({
          userId: 'user-1',
        });
      }
    });

    it('reads the newest consent when there are several', async () => {
      const iat = nowSeconds();
      live({
        consents: [
          { clientId: 'client-1', userId: 'user-1', createdAt: new Date((iat - 100) * 1000) },
          { clientId: 'client-1', userId: 'user-1', createdAt: new Date((iat + 5) * 1000) },
        ],
      });
      await refused(signed(claims({ iat })));
      expect(prismaCallsFor('oauthConsent', 'findFirst')[0].args).toMatchObject({
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('when a read fails', () => {
    it('answers 503 when the key read fails because the store is unavailable', async () => {
      const error = storeDown();
      mocks.getJwks.mockRejectedValue(error);
      const failure = await failureOf(bearer(signed(claims())));
      expect(failure).toBeInstanceOf(TokenStoreUnavailableError);
      expect((failure as Error).cause).toBe(error);
    });

    it('answers 503 when the key read takes longer than the verifier waits', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      vi.setSystemTime(clock);
      mocks.getJwks.mockReturnValue(new Promise(() => {}));
      const pending = failureOf(bearer(signed(claims())));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toBeInstanceOf(TokenStoreUnavailableError);
    });

    it('passes any other key-read failure on unchanged (the route answers 401)', async () => {
      const error = new Error('No key sets found');
      mocks.getJwks.mockRejectedValue(error);
      const failure = await failureOf(bearer(signed(claims())));
      expect(failure).not.toBeInstanceOf(TokenStoreUnavailableError);
      expect(failure).not.toBeInstanceOf(UnauthorizedError);
    });

    it.each([
      ['oauthClient', 'findUnique'],
      ['user', 'findUnique'],
      ['oauthConsent', 'findFirst'],
    ])(
      'answers 503 when the %s read fails because the store is unavailable',
      async (model, method) => {
        setPrismaRows({
          [model]: {
            [method]: () => {
              throw storeDown();
            },
          },
        });
        expect(await failureOf(bearer(signed(claims())))).toBeInstanceOf(
          TokenStoreUnavailableError
        );
      }
    );

    it('passes any other liveness read failure on unchanged', async () => {
      const error = otherFailure();
      setPrismaRows({
        oauthConsent: {
          findFirst: () => {
            throw error;
          },
        },
      });
      expect(await failureOf(bearer(signed(claims())))).toBe(error);
    });
  });
});
