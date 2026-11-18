/**
 * Errors thrown by the generated client (`@classmoji/database/client`, the
 * `prisma-client` generator) on a real database, against the errors captured
 * from Prisma 7.10.1's `prisma-client-js` client (testing/prismaErrors.ts),
 * which every classifier's own tests run on.
 *
 * For each failure: the same class (`instanceof` the namespace's error
 * classes), and the same fields the classifiers read (name, code, the
 * driver adapter's cause), so a classifier tested on the captured error
 * recognises the live one. The two connection classifiers (task retries, the
 * MCP's 503) are also run on both. The error classes are the runtime's own
 * objects, whether the runtime is imported or required, so `instanceof` holds
 * in any code handed this client.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, like
 * clientApi.integration.test.ts. Every row it writes is removed.
 */
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@classmoji/database/client';
import { getPrisma } from '../index.ts';
import { createPgPrismaClient } from '../pgClient.ts';
import { PRISMA_7_ERRORS, type CapturedPrismaError } from '../testing/prismaErrors.ts';
import { isTransientDatabaseError } from '../../tasks/src/helpers/databaseRetry.ts';
import { isTokenStoreUnavailable } from '../../../apps/mcp/src/auth/tokenStoreErrors.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const USER_ID = `client-errors-user-${process.pid}`;

type Cause = Record<string, unknown> & { kind?: unknown; originalCode?: unknown };

/** What the classifiers read, minus names that differ by table, host or user. */
function shape(error: unknown) {
  const e = error as CapturedPrismaError & { cause?: { code?: unknown } };
  const adapter = (e.meta?.driverAdapterError ?? undefined) as
    | { name?: unknown; cause?: Cause }
    | undefined;
  return {
    name: e.name,
    code: e.code,
    hasModelName: e.meta != null && 'modelName' in e.meta,
    adapterName: adapter?.name,
    kind: adapter?.cause?.kind,
    originalCode: adapter?.cause?.originalCode,
    // Fields with a value: the captured errors went through JSON, which drops
    // the undefined ones (`hint`, `detail`, ...).
    causeKeys: adapter?.cause
      ? Object.keys(adapter.cause)
          .filter(key => adapter.cause?.[key] !== undefined)
          .sort()
      : undefined,
    // Plain `Error`s from node-postgres carry the socket error as `cause`.
    socketCode: e.cause?.code,
  };
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe.skipIf(!RUN)('errors from the generated client (real database)', () => {
  const prisma = RUN ? getPrisma() : (undefined as never);
  const urlWith = (edit: (url: URL) => void) => {
    const url = new URL(DATABASE_URL);
    edit(url);
    return url.toString();
  };

  afterAll(async () => {
    if (!RUN) return;
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  it('throws the runtime’s own error classes, imported or required', async () => {
    const imported = await import('@prisma/client/runtime/client');
    const required = createRequire(import.meta.url)('@prisma/client/runtime/client');
    for (const runtime of [imported, required]) {
      expect(Prisma.PrismaClientKnownRequestError).toBe(runtime.PrismaClientKnownRequestError);
      expect(Prisma.PrismaClientUnknownRequestError).toBe(runtime.PrismaClientUnknownRequestError);
      expect(Prisma.PrismaClientValidationError).toBe(runtime.PrismaClientValidationError);
      expect(Prisma.PrismaClientInitializationError).toBe(runtime.PrismaClientInitializationError);
      expect(Prisma.PrismaClientRustPanicError).toBe(runtime.PrismaClientRustPanicError);
    }
  });

  it('a unique violation (P2002) matches the captured one', async () => {
    await prisma.user.create({ data: { id: USER_ID, email: `${USER_ID}@x.test` } });
    const error = await failure(() =>
      prisma.user.create({ data: { id: `${USER_ID}-2`, email: `${USER_ID}@x.test` } })
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(shape(error)).toEqual(shape(PRISMA_7_ERRORS.p2002_user_email));
    const cause = (error as Prisma.PrismaClientKnownRequestError).meta?.driverAdapterError as {
      cause: { constraint: unknown };
    };
    expect(cause.cause.constraint).toEqual({ index: 'users_email_key' });
  });

  it('a missing record (P2025) is a known request error', async () => {
    const error = await failure(() =>
      prisma.user.update({ where: { id: `${USER_ID}-missing` }, data: { name: 'x' } })
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
  });

  it('a foreign key violation (P2003) matches the captured one', async () => {
    const error = await failure(() =>
      prisma.session.create({
        data: {
          user_id: `${USER_ID}-nobody`,
          token: `${USER_ID}-token`,
          expires_at: new Date(Date.now() + 60_000),
        },
      })
    );
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(shape(error)).toEqual(shape(PRISMA_7_ERRORS.p2003_fk));
  });

  it('a failing raw query (P2010) carries the Postgres code', async () => {
    const error = await failure(() => prisma.$queryRawUnsafe('SELECT * FROM no_such_table_here'));
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(shape(error)).toMatchObject({
      code: 'P2010',
      adapterName: 'DriverAdapterError',
      originalCode: '42P01',
    });
  });

  it('an invalid argument is a validation error', async () => {
    // A unique lookup that names no unique field.
    const error = await failure(() => prisma.user.findUnique({ where: { id: undefined } }));
    expect(error).toBeInstanceOf(Prisma.PrismaClientValidationError);
    expect((error as Error).name).toBe('PrismaClientValidationError');
  });

  it('a session the server ends mid-query (P2010, 57P01) matches the captured one, and both classifiers agree', async () => {
    const victim = createPgPrismaClient(DATABASE_URL, { max: 1 });
    try {
      const marker = `client_errors_${process.pid}`;
      const sleeping = failure(() =>
        victim.$queryRawUnsafe(`SELECT pg_sleep(10)::text AS ${marker}`)
      );
      let killed = 0;
      for (let attempt = 0; attempt < 100 && killed === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const rows = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(
          `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
            WHERE query LIKE '%AS ${marker}%' AND pid <> pg_backend_pid()`
        );
        killed = rows.length;
      }
      expect(killed).toBe(1);
      const error = await sleeping;
      const captured = PRISMA_7_ERRORS.killed_mid_raw_query;
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(shape(error)).toEqual(shape(captured));
      expect(isTransientDatabaseError(error)).toBe(isTransientDatabaseError(captured));
      expect(isTokenStoreUnavailable(error)).toBe(isTokenStoreUnavailable(captured));
    } finally {
      await victim.$disconnect().catch(() => {});
    }
  }, 20_000);

  it('a missing database (P1003) matches the captured one, and both classifiers agree', async () => {
    const client = createPgPrismaClient(
      urlWith(url => {
        url.pathname = `/no_such_database_${process.pid}`;
      }),
      { max: 1 }
    );
    try {
      const error = await failure(() => client.user.count());
      const captured = PRISMA_7_ERRORS.missing_database;
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(shape(error)).toEqual(shape(captured));
      expect(isTransientDatabaseError(error)).toBe(isTransientDatabaseError(captured));
      expect(isTokenStoreUnavailable(error)).toBe(isTokenStoreUnavailable(captured));
    } finally {
      await client.$disconnect().catch(() => {});
    }
  });

  it('a wrong password (P1000) matches the captured one, and both classifiers agree', async ctx => {
    const client = createPgPrismaClient(
      urlWith(url => {
        url.password = `wrong-${process.pid}`;
      }),
      { max: 1 }
    );
    try {
      const error = await failure(() => client.user.count());
      // A server that trusts local connections takes any password.
      if (error === undefined) ctx.skip();
      const captured = PRISMA_7_ERRORS.wrong_password;
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(shape(error)).toEqual(shape(captured));
      expect(isTransientDatabaseError(error)).toBe(isTransientDatabaseError(captured));
      expect(isTokenStoreUnavailable(error)).toBe(isTokenStoreUnavailable(captured));
    } finally {
      await client.$disconnect().catch(() => {});
    }
  });

  it('an unreachable server matches the captured one, and both classifiers agree', async () => {
    const client = createPgPrismaClient(
      urlWith(url => {
        url.hostname = '127.0.0.1';
        url.port = '1';
      }),
      { max: 1 }
    );
    try {
      const error = await failure(() => client.user.count());
      const captured = PRISMA_7_ERRORS.unreachable;
      expect(shape(error)).toEqual(shape(captured));
      expect((error as Error).message).toBe(captured.message);
      expect(isTransientDatabaseError(error)).toBe(isTransientDatabaseError(captured));
      expect(isTokenStoreUnavailable(error)).toBe(isTokenStoreUnavailable(captured));
    } finally {
      await client.$disconnect().catch(() => {});
    }
  });
});
