/**
 * Retry a GitHub request that failed for a reason on GitHub's side, for an
 * installation client.
 *
 * Two failures this covers, both seen in production:
 * - A token GitHub has only just minted can be rejected (401) for a little
 *   while, more often when many runs start together. @octokit/auth-app retries
 *   that for ~15s only.
 * - GitHub returns empty 500s on writes for a minute or two at a time (CS52
 *   team creation lost 4 teams to a ~90s spell). The octokit retry plugin's
 *   three quick tries are over long before it ends.
 *
 * Retrying is safe only where a repeat cannot do the work twice:
 * - 401: GitHub did nothing, so any method.
 * - 5xx, or no status (the connection dropped): GET, HEAD, PUT, PATCH and
 *   DELETE, which are idempotent; and the two POSTs whose duplicate GitHub
 *   refuses with 422 "already exists", which their callers treat as success
 *   (create a repository, create a team). Any other POST (an issue, a pull
 *   request) is never retried: a repeat could open a second one.
 * Everything else (403, 404, 422, ...) passes straight through.
 */

interface WrappableHook {
  wrap(
    name: 'request',
    fn: (
      request: (options: RequestOptions) => Promise<unknown>,
      options: RequestOptions
    ) => Promise<unknown>
  ): void;
}

interface RequestOptions {
  method?: string;
  url?: string;
}

/** Waits before each retry: a little over 2 minutes in all, longer than the spells seen. */
export const AUTH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

/** POSTs whose repeat GitHub refuses as "already exists" (422), handled by their callers. */
const SAFE_TO_REPEAT_POSTS = new Set(['/orgs/{org}/repos', '/orgs/{org}/teams']);

const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status > 0 ? status : null;
};

/** Whether this failure is worth another try, given the request it came from. */
export function isRetryableAuthFailure(
  error: unknown,
  method: string | undefined,
  url?: string
): boolean {
  const status = statusOf(error);
  if (status === 401) return true;
  if (status !== null && status < 500) return false;
  const verb = (method ?? 'GET').toUpperCase();
  if (IDEMPOTENT_METHODS.has(verb)) return true;
  return verb === 'POST' && url !== undefined && SAFE_TO_REPEAT_POSTS.has(url);
}

/** Status, GitHub request id, endpoint and message: what a bare HttpError leaves out. */
export function describeGithubError(error: unknown, options?: RequestOptions): string {
  const e = (error ?? {}) as {
    message?: unknown;
    response?: { headers?: Record<string, unknown> };
  };
  const requestId = e.response?.headers?.['x-github-request-id'];
  return [
    `status ${statusOf(error) ?? 'none'}`,
    typeof requestId === 'string' ? `request ${requestId}` : null,
    options?.method && options?.url ? `${options.method} ${options.url}` : null,
    typeof e.message === 'string' && e.message ? e.message : 'no message',
  ]
    .filter(Boolean)
    .join(' | ');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function retryRejectedAuth(
  // Octokit's own hook type is too specific to name here; only `wrap` is used.
  octokit: { hook: unknown },
  label: string,
  delays: number[] = AUTH_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<unknown> = sleep
): void {
  (octokit.hook as WrappableHook).wrap('request', async (request, options) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(options);
      } catch (error: unknown) {
        const retry =
          attempt < delays.length && isRetryableAuthFailure(error, options.method, options.url);
        console.warn(
          `[GitHubProvider] ${label}: ${describeGithubError(error, options)}` +
            (retry ? ` (retrying in ${delays[attempt] / 1000}s)` : '')
        );
        if (!retry) throw error;
        await wait(delays[attempt]);
      }
    }
  });
}
