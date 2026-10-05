/**
 * Rate-limit visibility for an installation's Octokit: a response hook that
 * warns when the primary quota runs low, and an error hook that logs every
 * secondary-limit refusal with its `retry-after`. Observation only — it never
 * changes a request or swallows an error — and cheap: header reads per
 * response, and the low-quota warning at most once a minute per client.
 */

interface HookedOctokit {
  hook: {
    after(name: 'request', fn: (response: ResponseLike, options: RequestLike) => void): void;
    error(name: 'request', fn: (error: unknown, options: RequestLike) => unknown): void;
  };
}

type Headers = Record<string, string | number | undefined>;
interface ResponseLike {
  headers?: Headers;
}
interface RequestLike {
  method?: string;
  url?: string;
}

export type RateLimitLog = (message: string, data: Record<string, unknown>) => void;

/** Warn below this share of the quota left. */
export const LOW_QUOTA_FRACTION = 0.1;
/** At most one low-quota warning per client per this many ms. */
export const LOW_QUOTA_WARN_INTERVAL_MS = 60_000;

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Whether `headers` say the primary quota is under `LOW_QUOTA_FRACTION`. */
export function quotaIsLow(headers: Headers | undefined): {
  low: boolean;
  remaining: number | null;
  limit: number | null;
} {
  const remaining = num(headers?.['x-ratelimit-remaining']);
  const limit = num(headers?.['x-ratelimit-limit']);
  return {
    low:
      remaining !== null && limit !== null && limit > 0 && remaining < limit * LOW_QUOTA_FRACTION,
    remaining,
    limit,
  };
}

/** A 403/429 that is a rate limit (secondary, or the primary quota at zero). */
export function rateLimitRefusal(error: unknown): {
  status: number;
  retryAfter: string | null;
  secondary: boolean;
} | null {
  const e = error as {
    status?: number;
    message?: string;
    response?: { headers?: Headers; data?: { message?: string } };
  };
  if (e?.status !== 403 && e?.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  const message = `${e.message ?? ''} ${e.response?.data?.message ?? ''}`;
  const retryAfter = headers['retry-after'] != null ? String(headers['retry-after']) : null;
  const secondary = /secondary rate limit|abuse/i.test(message) || e.status === 429;
  const primaryExhausted = num(headers['x-ratelimit-remaining']) === 0;
  if (!secondary && !primaryExhausted && retryAfter === null) return null;
  return { status: e.status, retryAfter, secondary };
}

const defaultLog: RateLimitLog = (message, data) => console.warn(message, data);

/** Attach the hooks to `octokit` (once per instance). */
export function watchRateLimits(
  octokit: HookedOctokit,
  label: string,
  log: RateLimitLog = defaultLog,
  now: () => number = Date.now
): void {
  const tagged = octokit as HookedOctokit & { __classmojiRateLimitWatch?: true };
  if (tagged.__classmojiRateLimitWatch) return;
  tagged.__classmojiRateLimitWatch = true;

  let lastLowWarn = -Infinity;
  octokit.hook.after('request', (response, options) => {
    const { low, remaining, limit } = quotaIsLow(response?.headers);
    if (!low || now() - lastLowWarn < LOW_QUOTA_WARN_INTERVAL_MS) return;
    lastLowWarn = now();
    log('[github] rate limit running low', {
      client: label,
      remaining,
      limit,
      reset: response?.headers?.['x-ratelimit-reset'],
      request: `${options?.method} ${options?.url}`,
    });
  });
  octokit.hook.error('request', (error, options) => {
    const refusal = rateLimitRefusal(error);
    if (refusal) {
      log(refusal.secondary ? '[github] secondary rate limit' : '[github] rate limit exhausted', {
        client: label,
        status: refusal.status,
        retryAfter: refusal.retryAfter,
        request: `${options?.method} ${options?.url}`,
      });
    }
    throw error;
  });
}
