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
 */

/**
 * Prisma codes for "could not talk to the database", as opposed to "the
 * database said no". P1001 can't reach server, P1002 server timed out, P1008
 * operation timed out, P1017 server closed the connection, P2024 timed out
 * waiting for a pooled connection.
 */
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

const TRANSIENT_DB_MESSAGE =
  /can't reach database server|server has closed the connection|connection (?:terminated|reset|refused)|timed out fetching a new connection/i;

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
  if (typeof e.code === 'string' && TRANSIENT_DB_CODES.has(e.code)) return true;
  if (typeof e.errorCode === 'string' && TRANSIENT_DB_CODES.has(e.errorCode)) return true;
  if (typeof e.message === 'string' && TRANSIENT_DB_MESSAGE.test(e.message)) return true;
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
