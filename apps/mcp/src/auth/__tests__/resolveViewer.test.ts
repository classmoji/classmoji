/**
 * Unit tests for resolveViewer — the single token-validation seam (plan §3.2).
 *
 * better-auth's getMcpSession is mocked (vi.mock factory idiom, per
 * packages/services/__tests__) because the two behaviors under test are OURS,
 * layered on top of it:
 *   1. expiry enforcement — better-auth 1.4.18 getMcpSession returns the raw
 *      oauth_access_tokens row WITHOUT checking accessTokenExpiresAt, so
 *      resolveViewer must reject expired rows itself;
 *   2. scope parsing — the row stores scopes as a space-delimited string;
 *   3. the `oauth_applications.disabled` kill switch (finding 16) — getMcpSession
 *      returns the TOKEN row only and never looks at the owning application, so
 *      disabling a client would revoke nothing unless resolveViewer checks it.
 *      Prisma stands in for the same reason better-auth does: the behaviour
 *      under test is ours.
 *
 * The Prisma stand-in is the DMMF-validating stub (P2-8), NOT a hand-written
 * `vi.fn()`. A hand-written one answers whatever it is asked — including a
 * `select` of a column `oauth_applications` does not have — so the kill-switch
 * query could drift off the schema with this suite still green, which is the
 * exact failure the stub was built to catch. Here the query is resolved against
 * the generated client's own datamodel, so a renamed or misspelled column fails
 * the test instead of production.
 */

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TokenStoreUnavailableError,
  UnauthorizedError,
  UnsupportedTokenFormatError,
} from '../../mcp/errors.ts';

const getMcpSession = vi.fn();

vi.mock('@classmoji/auth/server', () => ({
  auth: { api: { getMcpSession: (...args: unknown[]) => getMcpSession(...args) } },
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const { bearerFrom, isNewerTokenFormat, resolveViewer } = await import('../resolveViewer.ts');
const { prismaCallsFor, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');

const HEADERS = new Headers({ authorization: 'Bearer whatever' });

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    clientId: 'client-1',
    scopes: 'openid read write',
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

/** What `oauthApplication.findUnique` answers with for the rest of this test. */
const applicationRow = (row: unknown) => setPrismaRows({ oauthApplication: { findUnique: row } });

/** Every kill-switch lookup this test provoked, validated against the schema. */
const applicationLookups = () => prismaCallsFor('oauthApplication', 'findUnique');

beforeEach(() => {
  getMcpSession.mockReset();
  resetPrismaStub();
  // Default: the token's OAuth application exists and is enabled.
  applicationRow({ disabled: false });
});

describe('resolveViewer', () => {
  it('resolves a valid token to a Viewer with parsed scopes', async () => {
    getMcpSession.mockResolvedValue(validRow());

    const viewer = await resolveViewer(HEADERS);

    expect(viewer.userId).toBe('user-1');
    expect(viewer.clientId).toBe('client-1');
    // 'openid read write' (space-delimited string) → Set
    expect(viewer.scopes).toBeInstanceOf(Set);
    expect([...viewer.scopes].sort()).toEqual(['openid', 'read', 'write']);
  });

  it('passes the headers through to getMcpSession', async () => {
    getMcpSession.mockResolvedValue(validRow());
    await resolveViewer(HEADERS);
    expect(getMcpSession).toHaveBeenCalledWith({ headers: HEADERS });
  });

  it('rejects a token past accessTokenExpiresAt (expiry enforced HERE, not in better-auth)', async () => {
    getMcpSession.mockResolvedValue(
      validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    );

    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/expired/i);
  });

  it('rejects a token expiring exactly now (boundary is exclusive)', async () => {
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: new Date(now) }));
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a row with no expiry at all (fail closed)', async () => {
    getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: null }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a row with an unparseable expiry (fail closed)', async () => {
    getMcpSession.mockResolvedValue(validRow({ accessTokenExpiresAt: 'not-a-date' }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
  });

  it('accepts an ISO-string expiry in the future (driver may return strings)', async () => {
    getMcpSession.mockResolvedValue(
      validRow({ accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    );
    const viewer = await resolveViewer(HEADERS);
    expect(viewer.userId).toBe('user-1');
  });

  it('rejects when no session is found (missing/unknown token)', async () => {
    getMcpSession.mockResolvedValue(null);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/missing or invalid/i);
  });

  it('maps a thrown better-auth APIError (garbage token / malformed header) to UnauthorizedError', async () => {
    getMcpSession.mockRejectedValue(new Error('APIError: bad request'));
    await expect(resolveViewer(new Headers({ authorization: 'garbage' }))).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('rejects a row not bound to a user', async () => {
    getMcpSession.mockResolvedValue(validRow({ userId: null }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/not bound to a user/i);
  });

  it('normalizes missing scopes to an empty set (never grants by default)', async () => {
    getMcpSession.mockResolvedValue(validRow({ scopes: null }));
    const viewer = await resolveViewer(HEADERS);
    expect(viewer.scopes.size).toBe(0);
  });

  it('collapses extra whitespace in the scope string', async () => {
    getMcpSession.mockResolvedValue(validRow({ scopes: '  read   write  ' }));
    const viewer = await resolveViewer(HEADERS);
    expect([...viewer.scopes].sort()).toEqual(['read', 'write']);
  });

  it('rejects a row with no client id (fail closed — the kill switch keys on it)', async () => {
    getMcpSession.mockResolvedValue(validRow({ clientId: undefined }));
    await expect(resolveViewer(HEADERS)).rejects.toThrow(/not bound to an oauth client/i);
  });

  describe('oauth_applications.disabled kill switch (finding 16)', () => {
    it('REFUSES a token whose OAuth application is disabled', async () => {
      getMcpSession.mockResolvedValue(validRow());
      applicationRow({ disabled: true });

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
      await expect(resolveViewer(HEADERS)).rejects.toThrow(/client is disabled/i);
    });

    it('looks the application up by the client id on the token row itself', async () => {
      getMcpSession.mockResolvedValue(validRow({ clientId: 'classmoji-ask-moji' }));

      await resolveViewer(HEADERS);

      // The stub resolved `clientId` and `disabled` against the generated
      // datamodel to get here: a column that no longer exists would have thrown
      // rather than matched.
      expect(applicationLookups()).toHaveLength(1);
      expect(applicationLookups()[0].args).toEqual({
        where: { clientId: 'classmoji-ask-moji' },
        select: { disabled: true },
      });
    });

    it('refuses a token whose application row has vanished', async () => {
      getMcpSession.mockResolvedValue(validRow());
      applicationRow(null);

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    });

    it('accepts a nullish `disabled` (the column is Boolean? defaulting to false)', async () => {
      getMcpSession.mockResolvedValue(validRow());
      applicationRow({ disabled: null });

      const viewer = await resolveViewer(HEADERS);
      expect(viewer.userId).toBe('user-1');
    });

    it('does not reach the application lookup for an already-expired token', async () => {
      getMcpSession.mockResolvedValue(
        validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
      expect(applicationLookups()).toHaveLength(0);
    });
  });

  describe('token store unavailable → TokenStoreUnavailableError (503), never a 401', () => {
    const clientVersion = '6.19.3';
    // The shapes getMcpSession throws (observed against a local Postgres).
    const tableMissing = new Prisma.PrismaClientKnownRequestError(
      'The table `public.oauth_access_tokens` does not exist in the current database.',
      { code: 'P2021', clientVersion }
    );
    const connectionClosed = new Prisma.PrismaClientKnownRequestError(
      'Server has closed the connection.',
      { code: 'P1017', clientVersion }
    );
    const cannotConnect = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `127.0.0.1:5432`",
      clientVersion
    );

    it.each([
      ['a missing table', tableMissing],
      ['a dropped connection', connectionClosed],
      ['no connection at all', cannotConnect],
    ])('when the token lookup fails with %s', async (_label, error) => {
      getMcpSession.mockRejectedValue(error);

      const failure = await resolveViewer(HEADERS).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TokenStoreUnavailableError);
      expect(failure).not.toBeInstanceOf(UnauthorizedError);
      expect((failure as Error).cause).toBe(error);
    });

    it('when the application lookup fails because the store is unavailable', async () => {
      getMcpSession.mockResolvedValue(validRow());
      applicationRow(() => {
        throw new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
          code: 'P1001',
          clientVersion,
        });
      });

      await expect(resolveViewer(HEADERS)).rejects.toThrow(TokenStoreUnavailableError);
    });

    it('but an application lookup failing for any other reason is passed on unchanged', async () => {
      const other = new Prisma.PrismaClientKnownRequestError('Inconsistent column data', {
        code: 'P2023',
        clientVersion,
      });
      getMcpSession.mockResolvedValue(validRow());
      applicationRow(() => {
        throw other;
      });

      // Not classified: the route answers it like today (401, logged).
      await expect(resolveViewer(HEADERS)).rejects.toBe(other);
    });

    it('a token lookup failing for any other reason is still a 401', async () => {
      getMcpSession.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion,
        })
      );
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);

      getMcpSession.mockRejectedValue(new Error("Can't reach database server"));
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    });

    it('an invalid, unknown or expired token is still a 401 while the store is up', async () => {
      getMcpSession.mockResolvedValue(null);
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);

      getMcpSession.mockResolvedValue(
        validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
      );
      await expect(resolveViewer(HEADERS)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('a token in a newer format → UnsupportedTokenFormatError (503)', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = (header: unknown) => `${b64(header)}.${b64({ sub: 'u1' })}.c2lnbmF0dXJl`;
    const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

    it('a JWT that is not found', async () => {
      getMcpSession.mockResolvedValue(null);
      const failure = await resolveViewer(bearer(jwt({ alg: 'EdDSA', typ: 'JWT' }))).catch(
        (e: unknown) => e
      );
      expect(failure).toBeInstanceOf(UnsupportedTokenFormatError);
      expect(failure).not.toBeInstanceOf(UnauthorizedError);
    });

    it('an Ask Moji token that is not found', async () => {
      getMcpSession.mockResolvedValue(null);
      await expect(resolveViewer(bearer('askmoji_abc123'))).rejects.toThrow(
        UnsupportedTokenFormatError
      );
    });

    it('but not three segments that are not a JWT header, nor an opaque token', async () => {
      getMcpSession.mockResolvedValue(null);
      for (const token of [
        jwt({ typ: 'JWT' }), // no alg
        `${b64('just a string')}.x.y`,
        'not-base64!.x.y',
        'a.b', // two segments
        'opaque-token-value',
        'Askmoji_abc', // prefix is case-sensitive
      ]) {
        await expect(resolveViewer(bearer(token)), token).rejects.toThrow(UnauthorizedError);
      }
      await expect(resolveViewer(new Headers())).rejects.toThrow(UnauthorizedError);
    });

    it('never for a token that is found: its expiry and client are checked', async () => {
      getMcpSession.mockResolvedValue(
        validRow({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
      );
      await expect(resolveViewer(bearer('askmoji_known'))).rejects.toThrow(/expired/i);

      getMcpSession.mockResolvedValue(validRow());
      const viewer = await resolveViewer(bearer('askmoji_known'));
      expect(viewer.userId).toBe('user-1');
    });
  });
});

describe('isNewerTokenFormat', () => {
  it('reads the bearer the way better-auth does', () => {
    expect(bearerFrom(new Headers({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(bearerFrom(new Headers())).toBeNull();
  });

  it('recognizes a JWT header and the Ask Moji prefix only', () => {
    const header = Buffer.from('{"alg":"RS256"}').toString('base64url');
    expect(isNewerTokenFormat(`${header}.e30.sig`)).toBe(true);
    expect(isNewerTokenFormat('askmoji_x')).toBe(true);
    expect(isNewerTokenFormat(`${header}.e30.`)).toBe(false);
    expect(isNewerTokenFormat('random')).toBe(false);
  });
});
