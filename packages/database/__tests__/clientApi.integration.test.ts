/**
 * The parts of the Prisma client API this codebase leans on, on a real
 * database through `@classmoji/database` (the pg adapter on Prisma 7): the
 * namespace helpers and error classes, JSON null vs database NULL, bigint and
 * numeric results, `Prisma.sql` / `join` / `raw` / `empty`, and transactions
 * (interactive with `maxWait` / `timeout`, rollback, batch, isolation level).
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, like
 * pgClient.integration.test.ts. Every row it writes is removed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@classmoji/database/client';
import { getPrisma } from '../index.ts';
import { createPgPrismaClient } from '../pgClient.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const KIND = `client-api-test-${process.pid}`;
const USER_ID = `client-api-user-${process.pid}`;

describe.skipIf(!RUN)('the Prisma client API on a real database', () => {
  const prisma = RUN ? getPrisma() : (undefined as never);

  afterAll(async () => {
    if (!RUN) return;
    await prisma.courseworkMigrationReport.deleteMany({ where: { kind: KIND } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  it('keeps the namespace helpers and error classes', () => {
    // Named one by one: `Prisma` is a module namespace in the generated
    // client, and lint refuses computed reads of one.
    const helpers = {
      PrismaClientKnownRequestError: Prisma.PrismaClientKnownRequestError,
      PrismaClientUnknownRequestError: Prisma.PrismaClientUnknownRequestError,
      PrismaClientInitializationError: Prisma.PrismaClientInitializationError,
      PrismaClientValidationError: Prisma.PrismaClientValidationError,
      Decimal: Prisma.Decimal,
      DbNull: Prisma.DbNull,
      JsonNull: Prisma.JsonNull,
      AnyNull: Prisma.AnyNull,
      sql: Prisma.sql,
      join: Prisma.join,
      raw: Prisma.raw,
      empty: Prisma.empty,
    };
    for (const [name, value] of Object.entries(helpers)) {
      expect(value, name).toBeDefined();
    }
  });

  it('writes JSON null and database NULL as different things', async () => {
    const jsonNull = await prisma.courseworkMigrationReport.create({
      data: { kind: KIND, details: Prisma.JsonNull },
    });
    const dbNull = await prisma.courseworkMigrationReport.create({
      data: { kind: KIND, details: Prisma.DbNull },
    });
    const value = await prisma.courseworkMigrationReport.create({
      data: { kind: KIND, details: { a: [1, 'b', null], big: '9007199254740993' } },
    });
    const rows = await prisma.$queryRaw<{ id: string; t: string | null }[]>`
      SELECT id, jsonb_typeof(details) AS t FROM coursework_migration_report WHERE kind = ${KIND}`;
    const typeOf = new Map(rows.map(row => [row.id, row.t]));
    expect(typeOf.get(jsonNull.id)).toBe('null');
    expect(typeOf.get(dbNull.id)).toBeNull();
    expect(typeOf.get(value.id)).toBe('object');
    expect(
      await prisma.courseworkMigrationReport.count({
        where: { kind: KIND, details: { equals: Prisma.JsonNull } },
      })
    ).toBe(1);
    expect(
      await prisma.courseworkMigrationReport.count({
        where: { kind: KIND, details: { equals: Prisma.DbNull } },
      })
    ).toBe(1);
    const read = await prisma.courseworkMigrationReport.findUniqueOrThrow({
      where: { id: value.id },
    });
    expect(read.details).toEqual({ a: [1, 'b', null], big: '9007199254740993' });
  });

  it('returns bigint, numeric and parameters as before', async () => {
    const [row] = await prisma.$queryRaw<
      { n: number; big: bigint; c: bigint; d: Prisma.Decimal; j: unknown }[]
    >(
      Prisma.sql`SELECT ${42}::int AS n, 9007199254740993::bigint AS big,
        (SELECT count(*) FROM generate_series(1, 3)) AS c, 12.50::numeric(10,2) AS d,
        ${JSON.stringify({ k: [1] })}::jsonb AS j`
    );
    expect(row.n).toBe(42);
    expect(row.big).toBe(9007199254740993n);
    expect(row.c).toBe(3n);
    // A decimal.js value (its class is renamed on Prisma 7; nothing here uses instanceof).
    expect(Number(row.d)).toBe(12.5);
    expect(String(row.d)).toBe('12.5');
    expect(JSON.stringify(row.d)).toBe('"12.5"');
    expect(row.j).toEqual({ k: [1] });
  });

  it('composes Prisma.sql, join, raw and empty', async () => {
    const ids = ['a', 'b'];
    const filter = Prisma.sql`AND x <> ${'c'}`;
    const rows = await prisma.$queryRaw<{ x: string }[]>(
      Prisma.sql`SELECT x FROM unnest(ARRAY['a','b','c']) AS ${Prisma.raw('t(x)')}
        WHERE x IN (${Prisma.join(ids)}) ${filter} ${Prisma.empty} ORDER BY x`
    );
    expect(rows.map(row => row.x)).toEqual(['a', 'b']);
  });

  it('raises the known request errors the code checks for', async () => {
    await prisma.user.create({ data: { id: USER_ID, email: `${USER_ID}@x.test` } });
    const duplicate = await prisma.user
      .create({ data: { id: USER_ID, email: `${USER_ID}-2@x.test` } })
      .catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((duplicate as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    const missing = await prisma.user
      .findUniqueOrThrow({ where: { id: `${USER_ID}-missing` } })
      .catch((error: unknown) => error);
    expect((missing as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
  });

  it('runs interactive transactions with maxWait / timeout, and rolls back on a throw', async () => {
    const pids = await prisma.$transaction(
      async tx => {
        await tx.courseworkMigrationReport.create({ data: { kind: KIND, subject_id: 'kept' } });
        const [a] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const [b] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        return [a.pid, b.pid];
      },
      { maxWait: 5_000, timeout: 10_000 }
    );
    expect(pids[0]).toBe(pids[1]);

    await expect(
      prisma.$transaction(async tx => {
        await tx.courseworkMigrationReport.create({ data: { kind: KIND, subject_id: 'rolled' } });
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');
    const subjects = await prisma.courseworkMigrationReport.findMany({
      where: { kind: KIND, subject_id: { not: null } },
      select: { subject_id: true },
    });
    expect(subjects.map(row => row.subject_id)).toEqual(['kept']);
  });

  it('ends a transaction that outlives its timeout (P2028), and its write is not kept', async () => {
    const run = (timeout: number) =>
      prisma
        .$transaction(
          async tx => {
            // ::text, or the void column alone fails the query (P2010).
            await tx.$queryRaw`SELECT pg_sleep(1.5)::text AS slept`;
            await tx.courseworkMigrationReport.create({ data: { kind: KIND, subject_id: 'late' } });
          },
          { timeout }
        )
        .then(
          () => null,
          (error: unknown) => error
        );
    const failure = await run(500);
    expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
    expect(
      await prisma.courseworkMigrationReport.count({ where: { kind: KIND, subject_id: 'late' } })
    ).toBe(0);
    // The same body with room to finish commits: the failure above was the timeout.
    expect(await run(10_000)).toBeNull();
    expect(
      await prisma.courseworkMigrationReport.count({ where: { kind: KIND, subject_id: 'late' } })
    ).toBe(1);
  }, 20_000);

  it('runs a batch transaction and honours an isolation level', async () => {
    const [, count] = await prisma.$transaction([
      prisma.courseworkMigrationReport.create({ data: { kind: KIND, subject_id: 'batch' } }),
      prisma.courseworkMigrationReport.count({ where: { kind: KIND, subject_id: 'batch' } }),
    ]);
    expect(count).toBe(1);
    const level = await prisma.$transaction(
      async tx => {
        const [row] = await tx.$queryRaw<{ level: string }[]>`
          SELECT current_setting('transaction_isolation') AS level`;
        return row.level;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    expect(level).toBe('serializable');
  });
});

/**
 * Raw SQL where the pg adapter reads values differently from Prisma 6's engine,
 * in the session this codebase runs in (UTC, Neon's default), and the one
 * thing that depends on that: a `timestamptz` value read in a non-UTC session.
 */
describe.skipIf(!RUN)('raw SQL on the pg adapter (real database)', () => {
  const at = new Date('2026-03-08T06:30:00.123Z'); // just before the US DST switch
  const open = (timeZone: string) =>
    createPgPrismaClient(DATABASE_URL, {
      max: 1,
      keepIdle: true,
      options: `-c TimeZone=${timeZone}`,
    });

  it('in a UTC session: timestamps, numeric, bigint and bare parameters read as the code expects', async () => {
    const utc = open('UTC');
    try {
      const [row] = await utc.$queryRaw<
        {
          tz: string;
          literal: Date;
          param_tz: Date;
          param_ts: Date;
          now: Date;
          d: Prisma.Decimal;
          big: bigint;
          bare_int: unknown;
          bare_big: unknown;
        }[]
      >`SELECT current_setting('TimeZone') AS tz,
          '2026-03-08 06:30:00.123+00'::timestamptz AS literal,
          ${at}::timestamptz AS param_tz, ${at}::timestamp(3) AS param_ts, now() AS now,
          round(2.345::numeric, 2) AS d, 9007199254740993::bigint AS big,
          ${5}::int AS bare_int, ${BigInt(7)} AS bare_big`;
      expect(row.tz).toBe('UTC');
      expect(row.literal.toISOString()).toBe(at.toISOString());
      expect(row.param_tz.toISOString()).toBe(at.toISOString());
      expect(row.param_ts.toISOString()).toBe(at.toISOString());
      expect(Math.abs(row.now.getTime() - Date.now())).toBeLessThan(5_000);
      expect(Number(row.d)).toBe(2.35);
      expect(row.big).toBe(9007199254740993n);
      expect(row.bare_int).toBe(5);
      // An UNCAST parameter selected back is text on the adapter (a bigint on
      // Prisma 6): cast it, as every call site in this codebase does.
      expect(row.bare_big).toBe('7');
    } finally {
      await utc.$disconnect();
    }
  });

  it('in a non-UTC session a timestamptz value is read shifted (why sessions must stay UTC)', async () => {
    const newYork = open('America/New_York');
    try {
      const [row] = await newYork.$queryRaw<{ tz: string; literal: Date }[]>`
        SELECT current_setting('TimeZone') AS tz,
          '2026-03-08 06:30:00.123+00'::timestamptz AS literal`;
      expect(row.tz).toBe('America/New_York');
      // The same instant, read five hours early: the session offset is dropped.
      expect(row.literal.getTime() - at.getTime()).toBe(-5 * 3_600_000);
    } finally {
      await newYork.$disconnect();
    }
  });
});
