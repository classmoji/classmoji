/**
 * Retry a task when Github (or the network to it) blinks, and only then.
 *
 * Same idea as ./databaseRetry.ts: the project default is a single attempt, and
 * a task opts in by spreading `retryOnGitBlip` into its config. Only a task
 * whose run is safe to repeat should: gh-create_git_repo is, because each
 * attempt reads the student repository first and carries on from wherever the
 * last one stopped (createRepository's `isHalfInitialised` / `resumableMain`),
 * and adding a collaborator twice is a no-op.
 *
 * What counts as a blip comes from real failed runs: git failing to reach
 * github.com, a push dropped halfway, Github answering 5xx, and Octokit errors
 * that carry no status at all. A missing template, a permission Github refuses
 * or a deleted assignment is not a blip and still fails at its first attempt.
 */
import { isTransientDatabaseError } from './databaseRetry.ts';

/** git's own words (simple-git puts git's stderr in the message) for a lost connection or a Github 5xx. */
const TRANSIENT_GIT_MESSAGE = new RegExp(
  [
    String.raw`failed to connect to \S+ port \d+`,
    String.raw`couldn'?t connect to server`,
    String.raw`could not resolve host`,
    String.raw`connection (?:timed out|reset|refused)`,
    String.raw`operation timed out`,
    String.raw`rpc failed`,
    String.raw`the remote end hung up unexpectedly`,
    String.raw`unexpected disconnect`,
    String.raw`early eof`,
    String.raw`internal server error`,
    String.raw`returned error: 5\d\d`,
    String.raw`\bhttp 5\d\d\b`,
    String.raw`bad gateway`,
    String.raw`service unavailable`,
    String.raw`gateway time-?out`,
    String.raw`gnutls_handshake`,
  ].join('|'),
  'i'
);

/** Node socket and DNS failures. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Is this a transient Github or network failure? Reads an HTTP status (Octokit:
 * 5xx and 429 retry, 4xx does not), a socket error code, then git's message,
 * and follows `cause` so a wrapped error still counts. An Octokit `HttpError`
 * with no status and no message is what a connection that died mid-request
 * looks like, so it counts too.
 */
export function isTransientGitError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const e = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof e.status === 'number' && e.status > 0) {
    return e.status >= 500 || e.status === 429;
  }
  if (typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  if (message && TRANSIENT_GIT_MESSAGE.test(message)) return true;
  if (e.name === 'HttpError' && !message) return true;
  return isTransientGitError(e.cause, depth + 1);
}

/**
 * Five attempts, waiting about 30s, 1.5m, 4.5m then 10m: enough to ride out a
 * Github incident of around twenty minutes. Longer outages are what Sync is for.
 * The waits hold no queue slot, so other classrooms keep provisioning meanwhile.
 */
export const GIT_BLIP_RETRY = {
  maxAttempts: 5,
  factor: 3,
  minTimeoutInMs: 30_000,
  maxTimeoutInMs: 600_000,
  randomize: true,
};

/**
 * Spread into a task config: `task({ id, ...retryOnGitBlip, run })`. A database
 * blip is let through too, since these tasks also write their rows.
 */
export const retryOnGitBlip = {
  retry: GIT_BLIP_RETRY,
  catchError: async ({ error }: { error: unknown }) =>
    isTransientGitError(error) || isTransientDatabaseError(error)
      ? undefined
      : { skipRetrying: true },
};
