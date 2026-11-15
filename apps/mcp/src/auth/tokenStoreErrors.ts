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
 *   class 08 or 57P01-57P03, i.e. the connection went, not the query (and
 *   the same SQLSTATE in `cause.originalCode` of an unwrapped
 *   `DriverAdapterError`, as a transaction whose connection died raises, or
 *   such an error whose `cause.kind` is a socket failure: ConnectionClosed,
 *   SocketTimeout, DatabaseNotReachable); P1000
 *   (authentication failed) and P1003 (no such database), which Prisma 6
 *   raised as initialization errors; a refused or unroutable connection
 *   (`code` ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, EAI_AGAIN, on a known
 *   request error or on Node's own unwrapped `Error`/`AggregateError`, as a
 *   connect refused inside an interactive transaction arrives); and
 *   node-postgres's own failures, plain `Error`s with an exact whole message:
 *   the pool timeout `timeout exceeded when trying to connect` (Prisma 7 has
 *   no pool of its own, so no P2024), the connect timeouts `Connection
 *   terminated due to connection timeout` (the pool's) and `timeout expired`
 *   (the client's own), a dropped socket `Connection terminated
 *   unexpectedly`, and `Client has encountered a connection error and is not
 *   queryable`. A read is safe to repeat, so unlike the tasks'
 *   retry rule this one does not care whether a statement was in flight.
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

/**
 * node-postgres's own failures, plain `Error`s rather than Prisma ones, by
 * their whole message: the pool timeout, the pool's and the client's own
 * connect timeouts, a socket that closed under a query, and a query sent on a
 * client whose connection already failed.
 */
const PG_CONNECTION_FAILURE =
  /^(?:timeout exceeded when trying to connect|Connection terminated due to connection timeout|timeout expired|Connection failed while connecting|Connection terminated unexpectedly|Client has encountered a connection error and is not queryable)$/;

/**
 * Socket errors while opening a connection, as the `code` of a Prisma 7 known
 * request error (a host with several addresses, as Neon's have, refuses with
 * an AggregateError carrying the same code).
 */
const CONNECT_ERRNOS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/**
 * The adapter's socket failures (`cause.kind` of a DriverAdapterError): the
 * socket closed (ECONNRESET), timed out (ETIMEDOUT), or the server could not
 * be reached (ECONNREFUSED, ENOTFOUND).
 */
const SOCKET_KINDS = new Set(['ConnectionClosed', 'SocketTimeout', 'DatabaseNotReachable']);

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
      if (
        typeof e.code === 'string' &&
        (UNAVAILABLE_CODES.has(e.code) || CONNECT_ERRNOS.has(e.code))
      ) {
        return true;
      }
      break;
    case 'PrismaClientUnknownRequestError':
      if (
        typeof e.message === 'string' &&
        (MISSING_RELATION_OR_COLUMN.test(e.message) || CONNECTION_LOST.test(e.message))
      ) {
        return true;
      }
      break;
    case 'Error':
    case 'AggregateError':
      // Node's own socket error, unwrapped: a connect refused inside an
      // interactive transaction arrives so. The token check talks to nothing
      // but the database, so a refused or unroutable connect is its outage.
      if (typeof e.code === 'string' && CONNECT_ERRNOS.has(e.code)) return true;
      break;
    case 'DriverAdapterError': {
      // The adapter's own error, unwrapped (a transaction whose connection
      // died): a Postgres error's SQLSTATE in `cause.originalCode`, or a
      // socket failure's `cause.kind` with no SQLSTATE; there is no `meta`.
      const cause = e.cause as { originalCode?: unknown; kind?: unknown } | undefined;
      if (typeof cause?.originalCode === 'string' && CONNECTION_SQLSTATE.test(cause.originalCode)) {
        return true;
      }
      if (typeof cause?.kind === 'string' && SOCKET_KINDS.has(cause.kind)) return true;
      break;
    }
  }
  const sqlState = adapterSqlState(error);
  if (typeof sqlState === 'string' && CONNECTION_SQLSTATE.test(sqlState)) return true;
  // node-postgres's own failures are plain Errors, not Prisma ones: those exact
  // messages only (any other plain error stays an authentication failure).
  if (
    e.name === 'Error' &&
    typeof e.message === 'string' &&
    PG_CONNECTION_FAILURE.test(e.message)
  ) {
    return true;
  }
  return isTokenStoreUnavailable(e.cause, depth + 1);
}
