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

const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2021', 'P2022', 'P2024']);

const MISSING_RELATION_OR_COLUMN =
  /\b(?:relation|column) "[^"]+"(?: of relation "[^"]+")? does not exist\b/i;

/** Same patterns as packages/tasks/src/helpers/databaseRetry.ts `TRANSIENT_DB_MESSAGE`. */
const CONNECTION_LOST =
  /can't reach database server|server has closed the connection|connection (?:terminated|reset|refused)|timed out fetching a new connection/i;

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
  return isTokenStoreUnavailable(e.cause, depth + 1);
}
