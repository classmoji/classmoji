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
 * Github throttling (a 429, or a 403 naming a rate limit) is retried too, at
 * the time Github asks for: see `githubRateLimit`.
 */
import { isTransientDatabaseError } from './databaseRetry.ts';
import { isRepoNotFound } from './gitErrors.ts';

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
    // Github took the pack but failed to move the branch on its side.
    String.raw`fatal error in commit_refs`,
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

/** Github's words for being throttled: secondary limits, primary exhaustion, abuse detection. */
const RATE_LIMIT_MESSAGE = /secondary rate limit|rate limit exceeded|abuse detection/i;

type HeaderBag = Record<string, unknown> | undefined;

function headerOf(headers: HeaderBag, name: string): string | undefined {
  const value = headers?.[name];
  return value === undefined || value === null ? undefined : String(value);
}

export interface GithubRateLimit {
  /** How long Github asked us to wait, in ms, or null when it did not say. */
  waitMs: number | null;
}

/**
 * Is this Github throttling us? A 429, or a 403 that names a rate limit, carries
 * `retry-after`, or reports `x-ratelimit-remaining: 0` (Github answers
 * secondary limits with either status). An ordinary permission 403 is NOT a
 * rate limit and still fails at once. Follows `cause` like isTransientGitError.
 */
export function githubRateLimit(
  error: unknown,
  now = Date.now(),
  depth = 0
): GithubRateLimit | null {
  if (!error || typeof error !== 'object' || depth > 3) return null;
  const e = error as {
    status?: unknown;
    message?: unknown;
    cause?: unknown;
    response?: { headers?: HeaderBag; data?: { message?: unknown } };
  };
  // Octokit lower-cases response header names.
  const headers = e.response?.headers;
  const message = [e.message, e.response?.data?.message]
    .filter((m): m is string => typeof m === 'string')
    .join(' ');
  const retryAfter = headerOf(headers, 'retry-after');
  const remaining = headerOf(headers, 'x-ratelimit-remaining');
  const reset = headerOf(headers, 'x-ratelimit-reset');

  const throttled =
    e.status === 429 ||
    (e.status === 403 &&
      (RATE_LIMIT_MESSAGE.test(message) || retryAfter !== undefined || remaining === '0'));
  if (!throttled) return githubRateLimit(e.cause, now, depth + 1);

  // `retry-after` is seconds; `x-ratelimit-reset` is UTC epoch seconds.
  const afterSeconds = retryAfter !== undefined ? Number(retryAfter) : NaN;
  if (Number.isFinite(afterSeconds) && afterSeconds >= 0) return { waitMs: afterSeconds * 1000 };
  const resetSeconds = remaining === '0' && reset !== undefined ? Number(reset) : NaN;
  if (Number.isFinite(resetSeconds)) return { waitMs: Math.max(0, resetSeconds * 1000 - now) };
  return { waitMs: null };
}

/** Github says to wait at least a minute when a secondary limit gives no `retry-after`. */
export const RATE_LIMIT_MIN_WAIT_MS = 60_000;
/** Backoff ceiling when Github gave no wait of its own; its own wait is never shortened. */
export const RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60_000;
/** Spread so the runs one limit stopped together do not all come back in the same second. */
export const RATE_LIMIT_JITTER_MS = 30_000;

/**
 * When to retry a throttled attempt: Github's own wait if it gave one, never
 * under a backoff that starts at 1 minute and doubles each attempt (1, 2, 4,
 * 8 min, capped at 15), plus up to 30s of jitter. Scheduled by Trigger.dev, not
 * slept in the run, so the attempt gives back its queue slot while it waits.
 */
export function rateLimitRetryAt(
  limit: GithubRateLimit,
  attempt: number,
  now = Date.now(),
  random: () => number = Math.random
): Date {
  const backoff = Math.min(
    RATE_LIMIT_MIN_WAIT_MS * 2 ** Math.max(0, attempt - 1),
    RATE_LIMIT_MAX_BACKOFF_MS
  );
  const wait = Math.max(limit.waitMs ?? 0, backoff);
  return new Date(now + wait + Math.floor(random() * RATE_LIMIT_JITTER_MS));
}

/**
 * Spread into a task config: `task({ id, ...retryOnGitBlip, run })`. A database
 * blip is let through too, since these tasks also write their rows. Github
 * throttling is retried at the time it asks for (`rateLimitRetryAt`) instead of
 * on the outage schedule; the attempt limit (5) still applies.
 */
export const retryOnGitBlip = {
  retry: GIT_BLIP_RETRY,
  catchError: async ({
    error,
    ctx,
  }: {
    error: unknown;
    ctx?: { attempt?: { number?: number } };
  }) => {
    const limit = githubRateLimit(error);
    if (limit) return { retryAt: rateLimitRetryAt(limit, ctx?.attempt?.number ?? 1) };
    return isTransientGitError(error) || isTransientDatabaseError(error)
      ? undefined
      : { skipRetrying: true };
  },
};

/** Waits between reads of a repository Github has only just created: about 30s in all. */
export const NEW_REPO_VISIBLE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Read a repository Github has only just created. The API answers the create
 * before Github's git servers know the repository, so git can say "Repository
 * not found" for a few seconds, more often when a batch creates many at once
 * (prod, Oct 2026: 10 of 21 repos in one batch). Retries that answer alone;
 * anything else is thrown at once.
 */
export async function readNewRepo<T>(
  read: () => Promise<T>,
  delays: readonly number[] = NEW_REPO_VISIBLE_DELAYS_MS,
  wait: (ms: number) => Promise<unknown> = sleep
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error: unknown) {
      if (attempt >= delays.length || !isRepoNotFound(error)) throw error;
      await wait(delays[attempt]);
    }
  }
}
