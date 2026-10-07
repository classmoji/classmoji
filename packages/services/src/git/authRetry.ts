/**
 * Retry a request GitHub rejected as unauthorized, for an installation client.
 *
 * An installation token is minted on the client's first request. GitHub can
 * reject a token it has only just issued for a little while (it has not reached
 * every server yet), and does so more often when many tokens are minted at once:
 * a batch of repo-creation runs starting together. @octokit/auth-app retries
 * that case for only ~15s; past that the run failed with a bare `HttpError`.
 *
 * A 401 means GitHub did nothing with the request, so retrying is safe for any
 * method, writes included. A request that failed with no status at all (the
 * connection dropped) is retried only when it is a read, since a write may have
 * landed. Anything else is passed through untouched.
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

/** Waits before each retry: about 37s in all, on top of auth-app's own ~15s. */
export const AUTH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

const READ_METHODS = new Set(['GET', 'HEAD']);

const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status > 0 ? status : null;
};

/** Whether this failure is worth another try, given the request's method. */
export function isRetryableAuthFailure(error: unknown, method: string | undefined): boolean {
  const status = statusOf(error);
  if (status === 401) return true;
  return status === null && READ_METHODS.has((method ?? 'GET').toUpperCase());
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
        const retry = attempt < delays.length && isRetryableAuthFailure(error, options.method);
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
