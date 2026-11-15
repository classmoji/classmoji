/**
 * Retry a task when the database blinks, and only then.
 *
 * The project default (trigger.config.js) is a single attempt, deliberately:
 * many tasks create things on GitHub, send email or move tokens, and a blind
 * retry of those repeats the side effect. So a task opts in by spreading
 * `retryOnDatabaseBlip` into its config — and only a task whose run is safe to
 * repeat should. `catchError` lets a retry through for a connection-level
 * Prisma failure (Neon unreachable, a dropped connection, a pool timeout) and
 * stops every other error at its first attempt, so a logic error still fails
 * once and loudly.
 *
 * On Prisma 7 (the pg driver adapter) the rule is narrower than "the
 * connection failed": it retries only a failure that proves the statement did
 * not take effect. Either it could not connect (P1001, a refused connection,
 * the connect timed out (`timeout expired`), no free pooled connection, 57P03 the server is
 * starting), or the server ended the session itself (57P01), which aborts the
 * statement that was running. A connection that dropped under a statement in
 * flight (the socket closed or timed out: `ConnectionClosed`, `SocketTimeout`,
 * "Connection terminated unexpectedly", an errno raised by read/write on an
 * established socket; 08xxx, 57P02 crash, and a transaction whose connection
 * died under it) is NOT retried: the statement may have
 * committed before the reply was lost, and running a write twice is worse
 * than failing once. Prisma 6's shapes keep their old answers.
 */

/**
 * Prisma codes for "could not talk to the database", as opposed to "the
 * database said no". P1001 can't reach server, P1002 server timed out, P1008
 * operation timed out, P1017 server closed the connection, P2024 timed out
 * waiting for a pooled connection.
 */
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

/**
 * Socket errors that mean "could not connect" when raised by connect() (the
 * error's `code` on Prisma 7; a host with several addresses, as Neon's have,
 * gives an AggregateError with the same code). The same errnos on an
 * ESTABLISHED socket (a write already on the server) are not retried: see
 * `whileConnecting`. ECONNRESET and ETIMEDOUT are left out altogether.
 */
const CONNECT_ERRNOS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

// `timeout exceeded when trying to connect` is node-postgres's pool timeout and
// `Connection terminated due to connection timeout` its connect timeout
// (Prisma 7 has no pool of its own, so no P2024).
const TRANSIENT_DB_MESSAGE =
  /can't reach database server|server has closed the connection|connection (?:terminated|reset|refused)|timed out fetching a new connection|timeout exceeded when trying to connect/i;

/**
 * node-postgres's own connect timer (`connect_timeout`, pgClient.ts): raised
 * only while a connection is being opened, so nothing was sent.
 */
const PG_CONNECT_TIMEOUT = /^timeout expired$/;

/**
 * The factory's Client (pgClient.ts, CONNECT_FAILURE_MESSAGE) wraps every
 * failure raised while a connection is being opened in this message, the
 * original as `cause`: a dropped or reset socket, a refused or unroutable
 * connect, a TLS handshake that failed. Nothing was sent, so it is retried
 * whatever the cause. (A server error, which carries a SQLSTATE, is left
 * unwrapped and judged by its code.)
 */
const PG_CONNECT_FAILURE = /^Connection failed while connecting$/;

/** node-postgres: the socket closed, possibly with a statement in flight. */
const PG_CONNECTION_DROPPED = /^Connection terminated unexpectedly$/;

/**
 * What a transaction reports when its connection died under it: a query sent
 * on a client that already failed ("… is not queryable"), or the adapter's
 * own `DriverAdapterError` unwrapped (its SQLSTATE in `cause.originalCode`).
 * Either can follow a COMMIT whose reply was lost (the error the caller sees
 * may be the ROLLBACK's), so neither proves the transaction did not commit:
 * NOT retried, whatever the SQLSTATE.
 */
const PG_NOT_QUERYABLE = /^Client has encountered a connection error and is not queryable$/;

/**
 * Prisma 7 on a driver adapter reports a server-side error as P2010/P2039
 * with the Postgres SQLSTATE in `meta.driverAdapterError.cause.originalCode`.
 * 57P01 (admin shutdown: Neon suspending a compute, a terminated backend)
 * aborts the running statement; 57P03 (cannot connect now) refuses before any.
 */
const TRANSIENT_SQLSTATE = /^57P0[13]$/;
type AdapterCause = { originalCode?: unknown; kind?: unknown; host?: unknown };
const adapterCause = (error: unknown): AdapterCause | undefined =>
  (error as { meta?: { driverAdapterError?: { cause?: AdapterCause } } })?.meta?.driverAdapterError
    ?.cause;

/**
 * The adapter's socket kinds that a LIVE connection raises as readily as a
 * new one: `ConnectionClosed` (ECONNRESET, a closed socket) and
 * `SocketTimeout` (ETIMEDOUT, Prisma 7's only source of P1008). The adapter
 * keeps no `syscall`, so a connect that timed out reads the same as a write
 * whose reply never came; neither is retried. (A connect does not get that
 * far in practice: the factory's own connect timer, `timeout expired`, fires
 * long before the operating system's.)
 */
const LIVE_SOCKET_KINDS = new Set(['ConnectionClosed', 'SocketTimeout']);

/**
 * An errno raised by connect(), not by read()/write() on an established
 * socket. Node's own error says so in `syscall`; wrapped in a Prisma error,
 * only the message's last words do (`connect EHOSTUNREACH` vs
 * `read EHOSTUNREACH`).
 */
const whileConnecting = (e: { syscall?: unknown; message?: unknown }): boolean =>
  (e.syscall === undefined || e.syscall === 'connect' || e.syscall === 'getaddrinfo') &&
  !(typeof e.message === 'string' && /\b(?:read|write) E[A-Z_]+\s*$/.test(e.message));

/**
 * Is this a transient database connection failure? Reads Prisma's `code`
 * (known request errors) and `errorCode` (initialization errors such as the
 * "Can't reach database server" a Neon blip produces), then the message, and
 * follows `cause` so a wrapped error still counts.
 */
export function isTransientDatabaseError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const e = error as {
    name?: unknown;
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const adapter = adapterCause(error);
  // A socket that dropped or timed out under a statement: ambiguous, never retried (see above).
  if (typeof adapter?.kind === 'string' && LIVE_SOCKET_KINDS.has(adapter.kind)) return false;
  // P1001 from an ESTABLISHED socket (ECONNREFUSED after connect): the adapter
  // copies host and port from a connect error only, so no host means a live socket.
  if (adapter?.kind === 'DatabaseNotReachable' && adapter.host === undefined) return false;
  if (typeof e.message === 'string' && PG_CONNECTION_DROPPED.test(e.message)) return false;
  if (typeof e.message === 'string' && PG_NOT_QUERYABLE.test(e.message)) return false;
  if (e.name === 'DriverAdapterError') return false;
  if (
    e.name === 'Error' &&
    typeof e.message === 'string' &&
    (PG_CONNECT_TIMEOUT.test(e.message) || PG_CONNECT_FAILURE.test(e.message))
  ) {
    return true;
  }
  if (
    typeof e.code === 'string' &&
    (TRANSIENT_DB_CODES.has(e.code) || (CONNECT_ERRNOS.has(e.code) && whileConnecting(e)))
  ) {
    return true;
  }
  if (typeof e.errorCode === 'string' && TRANSIENT_DB_CODES.has(e.errorCode)) return true;
  if (typeof e.message === 'string' && TRANSIENT_DB_MESSAGE.test(e.message)) return true;
  const sqlState = adapter?.originalCode;
  if (typeof sqlState === 'string' && TRANSIENT_SQLSTATE.test(sqlState)) return true;
  return isTransientDatabaseError(e.cause, depth + 1);
}

/** Up to four attempts over roughly half a minute: enough to ride out a Neon blip. */
export const DATABASE_BLIP_RETRY = {
  maxAttempts: 4,
  factor: 2,
  minTimeoutInMs: 2_000,
  maxTimeoutInMs: 20_000,
  randomize: true,
};

/** Spread into a task config: `task({ id, ...retryOnDatabaseBlip, run })`. */
export const retryOnDatabaseBlip = {
  retry: DATABASE_BLIP_RETRY,
  catchError: async ({ error }: { error: unknown }) =>
    isTransientDatabaseError(error) ? undefined : { skipRetrying: true },
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The same policy for one database write made inside a larger run (where the
 * run itself must not repeat: it has already created things on Github or
 * Gitlab). Retries `write` on a transient connection failure only, with the
 * backoff above; anything else is thrown at once.
 */
export async function withDatabaseRetry<T>(
  write: () => Promise<T>,
  policy: Pick<
    typeof DATABASE_BLIP_RETRY,
    'maxAttempts' | 'factor' | 'minTimeoutInMs' | 'maxTimeoutInMs'
  > = DATABASE_BLIP_RETRY
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error: unknown) {
      if (attempt >= policy.maxAttempts || !isTransientDatabaseError(error)) throw error;
      const delay = Math.min(
        policy.minTimeoutInMs * policy.factor ** (attempt - 1),
        policy.maxTimeoutInMs
      );
      await sleep(delay);
    }
  }
}
