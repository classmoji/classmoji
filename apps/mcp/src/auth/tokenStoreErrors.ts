/**
 * Which failures of a token check's reads mean "the token store is
 * unavailable" rather than "this token is not valid": the internal token
 * lookup, the signing-key read and the access-token liveness reads
 * (internalToken.ts, jwtAccessToken.ts).
 *
 * resolveViewer answers the first with a 503 + Retry-After (try again later)
 * and everything else with a 401 (sign in again). The two must never be
 * confused in the 401 → 503 direction: a 503 for a bad token would leave a
 * client retrying forever with a token that will never work. So this is an
 * allowlist of Prisma failures that say nothing about the token, and anything
 * it does not recognise stays a 401:
 *
 * - `PrismaClientInitializationError`: the client could not connect at all.
 * - `PrismaClientRustPanicError`: the query engine crashed.
 * - `PrismaClientKnownRequestError` with a connection or schema code:
 *   P1001 can't reach the server, P1002 the server timed out, P1008 the
 *   operation timed out, P1017 the server closed the connection, P2024 timed
 *   out waiting for a pooled connection, P2021 the table does not exist,
 *   P2022 the column does not exist.
 * - `PrismaClientUnknownRequestError` whose message is Postgres's own
 *   missing-relation or missing-column error (42P01 / 42703), which is how a
 *   missing table can surface outside Prisma's typed codes, or a dropped or
 *   refused connection (the messages packages/tasks' databaseRetry.ts treats
 *   as transient).
 * - On a driver adapter (Prisma 7's pg one): a known request error whose
 *   Postgres SQLSTATE (`meta.driverAdapterError.cause.originalCode`) is
 *   class 08 or 57P01-57P03, i.e. the connection went, not the query; P1000
 *   (authentication failed) and P1003 (no such database), which Prisma 6
 *   raised as initialization errors; and node-postgres's own pool timeout, a
 *   plain `Error` whose whole message is `timeout exceeded when trying to
 *   connect` (Prisma 7 has no pool of its own, so no P2024).
 *
 * Duck-typed on `name` and `code`/`errorCode` rather than `instanceof`, like
 * packages/tasks' `isTransientDatabaseError`: the generated client's class
 * identity is not stable across engines and re-generates. `cause` is followed
 * a few levels, so a wrapped Prisma error still counts. The liveness reads
 * call Prisma directly, and the signing-key read (`auth.api.getJwks()`,
 * better-auth 1.7.18's jwt plugin through @better-auth/prisma-adapter)
 * surfaces the client's error unwrapped (jwksStoreUnavailable.test.ts), so
 * the top level is the common case.
 */

// P1000 (authentication failed) and P1003 (no such database) arrived as
// PrismaClientInitializationError on Prisma 6, always unavailable; Prisma 7 on
// the pg adapter raises them as known request errors.
const UNAVAILABLE_CODES = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1008',
  'P1017',
  'P2021',
  'P2022',
  'P2024',
]);

const MISSING_RELATION_OR_COLUMN =
  /\b(?:relation|column) "[^"]+"(?: of relation "[^"]+")? does not exist\b/i;

/**
 * The connection-loss patterns of packages/tasks/src/helpers/databaseRetry.ts
 * `TRANSIENT_DB_MESSAGE`. The pg pool timeout is matched separately below.
 */
const CONNECTION_LOST =
  /can't reach database server|server has closed the connection|connection (?:terminated|reset|refused)|timed out fetching a new connection/i;

const PG_POOL_TIMEOUT = /^timeout exceeded when trying to connect$/;

/** Same rule as databaseRetry.ts: a dropped connection's SQLSTATE on a driver adapter error. */
const CONNECTION_SQLSTATE = /^(?:08[0-9A-Z]{3}|57P0[123])$/;
const adapterSqlState = (error: unknown): unknown =>
  (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })?.meta
    ?.driverAdapterError?.cause?.originalCode;

const MAX_CAUSE_DEPTH = 3;

export function isTokenStoreUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > MAX_CAUSE_DEPTH) return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  switch (e.name) {
    case 'PrismaClientInitializationError':
    case 'PrismaClientRustPanicError':
      return true;
    case 'PrismaClientKnownRequestError':
      if (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) return true;
      break;
    case 'PrismaClientUnknownRequestError':
      if (
        typeof e.message === 'string' &&
        (MISSING_RELATION_OR_COLUMN.test(e.message) || CONNECTION_LOST.test(e.message))
      ) {
        return true;
      }
      break;
  }
  const sqlState = adapterSqlState(error);
  if (typeof sqlState === 'string' && CONNECTION_SQLSTATE.test(sqlState)) return true;
  // node-postgres's own pool timeout is a plain Error, not a Prisma one: that
  // exact message only (any other plain error stays an authentication failure).
  if (typeof e.message === 'string' && PG_POOL_TIMEOUT.test(e.message)) return true;
  return isTokenStoreUnavailable(e.cause, depth + 1);
}
