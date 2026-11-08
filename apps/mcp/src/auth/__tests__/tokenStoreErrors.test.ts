/**
 * isTokenStoreUnavailable — which token-lookup failures are "try again later"
 * (503) rather than "sign in again" (401). Built from the real Prisma error
 * classes, with the shapes the token lookups were observed to throw against a
 * local Postgres (first through better-auth 1.4's token read, the same Prisma
 * client): a renamed table (P2021), a renamed column (P2022),
 * the server stopped under a connected client (P1017, then P1001), and the
 * server down before the first query (PrismaClientInitializationError).
 * Anything not on the allowlist must stay a 401.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isTokenStoreUnavailable } from '../tokenStoreErrors.ts';

const clientVersion = '6.19.3';

const known = (
  code: string,
  message = 'Invalid `prisma.oauthAccessToken.findFirst()` invocation'
) => new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion });

describe('isTokenStoreUnavailable', () => {
  it.each([
    ['P1001', "Can't reach database server"],
    ['P1002', 'The database server was reached but timed out'],
    ['P1008', 'Operations timed out'],
    ['P1017', 'Server has closed the connection.'],
    ['P2021', 'The table `public.oauth_access_tokens` does not exist in the current database.'],
    [
      'P2022',
      'The column `oauth_access_tokens.access_token` does not exist in the current database.',
    ],
    ['P2024', 'Timed out fetching a new connection from the connection pool.'],
  ])('counts a known request error %s', (code, message) => {
    expect(isTokenStoreUnavailable(known(code, message))).toBe(true);
  });

  it('counts a client that could not connect at all, with or without a code', () => {
    expect(
      isTokenStoreUnavailable(
        new Prisma.PrismaClientInitializationError("Can't reach database server", clientVersion)
      )
    ).toBe(true);
    expect(
      isTokenStoreUnavailable(
        new Prisma.PrismaClientInitializationError('x', clientVersion, 'P1001')
      )
    ).toBe(true);
  });

  it('counts a query engine crash', () => {
    expect(
      isTokenStoreUnavailable(new Prisma.PrismaClientRustPanicError('panicked', clientVersion))
    ).toBe(true);
  });

  it("counts Postgres's own missing-relation and missing-column errors", () => {
    for (const message of [
      'relation "oauth_access_tokens" does not exist',
      'column "access_token" does not exist',
      'column "disabled" of relation "oauth_applications" does not exist',
    ]) {
      expect(
        isTokenStoreUnavailable(
          new Prisma.PrismaClientUnknownRequestError(message, { clientVersion })
        )
      ).toBe(true);
    }
  });

  it('counts an unknown request error saying the connection was lost or refused', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'Server has closed the connection.',
      'read ECONNRESET: connection reset by peer',
      'connection refused',
      "Can't reach database server at `db:5432`",
      'Timed out fetching a new connection from the connection pool.',
    ]) {
      expect(
        isTokenStoreUnavailable(
          new Prisma.PrismaClientUnknownRequestError(message, { clientVersion })
        ),
        message
      ).toBe(true);
    }
  });

  it('reads those messages only on an unknown request error', () => {
    expect(isTokenStoreUnavailable(known('P2002', 'Connection terminated unexpectedly'))).toBe(
      false
    );
    expect(
      isTokenStoreUnavailable(
        new Prisma.PrismaClientValidationError('connection reset', { clientVersion })
      )
    ).toBe(false);
    expect(isTokenStoreUnavailable(new Error('Connection terminated unexpectedly'))).toBe(false);
  });

  it('follows a cause, a few levels deep', () => {
    const wrapped = new Error('lookup failed', {
      cause: new Error('adapter', { cause: known('P1001') }),
    });
    expect(isTokenStoreUnavailable(wrapped)).toBe(true);

    let deep: unknown = known('P1001');
    for (let i = 0; i < 5; i += 1) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(isTokenStoreUnavailable(deep)).toBe(false);
  });

  describe('everything else stays an authentication failure', () => {
    it.each([
      ['P2002', 'Unique constraint failed'],
      ['P2025', 'Record not found'],
      ['P2023', 'Inconsistent column data'],
      ['P1012', 'Schema validation error'],
    ])('a known request error %s', (code, message) => {
      expect(isTokenStoreUnavailable(known(code, message))).toBe(false);
    });

    it('an unknown request error about something other than a missing relation', () => {
      expect(
        isTokenStoreUnavailable(
          new Prisma.PrismaClientUnknownRequestError('deadlock detected', { clientVersion })
        )
      ).toBe(false);
    });

    it('a validation error', () => {
      expect(
        isTokenStoreUnavailable(
          new Prisma.PrismaClientValidationError('bad args', { clientVersion })
        )
      ).toBe(false);
    });

    it('better-auth API errors and plain errors, even with a connection-sounding message or code', () => {
      expect(isTokenStoreUnavailable(new Error('APIError: bad request'))).toBe(false);
      expect(
        isTokenStoreUnavailable(
          Object.assign(new Error('UNAUTHORIZED'), { name: 'APIError', status: 401 })
        )
      ).toBe(false);
      expect(isTokenStoreUnavailable(new Error("Can't reach database server"))).toBe(false);
      expect(isTokenStoreUnavailable(Object.assign(new Error('x'), { code: 'P1001' }))).toBe(false);
    });

    it('non-errors', () => {
      for (const value of [undefined, null, 'P1001', 42, {}]) {
        expect(isTokenStoreUnavailable(value)).toBe(false);
      }
    });
  });
});
