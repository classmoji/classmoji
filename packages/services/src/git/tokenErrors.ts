/**
 * tokenErrors.ts — pure formatters for GitHub App installation-token failures.
 *
 * Two problems, both first seen when an import ran against a staging database
 * holding production-cloned org rows:
 *
 * 1. `GitHubProvider.getAccessToken()` throws a bare "Failed to retrieve GitHub
 *    installation token (404)". That message reaches the user through
 *    `ImportJob.error` and the progress banner, where it names neither the org
 *    nor the actual cause — the installation id on the row belongs to a DIFFERENT
 *    GitHub App than the one this environment is configured with, so no amount of
 *    retrying will help. `describeTokenMintError` names the org and says so.
 *
 * 2. Installation tokens are embedded in git remote URLs
 *    (`https://x-access-token:<token>@github.com/...`), and git echoes the full
 *    remote back in its failure output ("fatal: repository '<url>' not found").
 *    That output is what a task rethrows, which is what gets PERSISTED to
 *    `ImportJob.error` and rendered in the banner. `redactAccessTokens` strips
 *    the credential before any such text can be stored or displayed.
 *
 * Pure string functions with no imports on purpose: they run in the webapp
 * request path, in Trigger.dev tasks, and in tests, and must never drag GitHub
 * or database machinery along with them.
 */

/** Guard against pasting an entire git/octokit dump into a DB column. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Best-effort HTTP status for a failed token mint.
 *
 * Covers the three shapes this can arrive in: an Octokit `RequestError`
 * (`.status`), a fetch-response-derived error (`.response.status`), and
 * `GitHubProvider.getAccessToken`'s own plain `Error` whose only record of the
 * status is the trailing `(404)` in its message.
 */
function extractStatus(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const candidate = error as { status?: unknown; response?: { status?: unknown } };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.response?.status === 'number') return candidate.response.status;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const matched = message.match(/\((\d{3})\)/);
  return matched ? Number(matched[1]) : null;
}

/**
 * Replace embedded credentials with `***`, in place, anywhere in a string.
 *
 * Handles the `user:secret@host` URL form git prints (the `x-access-token:`
 * clone URLs this codebase builds, and any other userinfo pair), plus bare
 * GitHub token literals in case one reaches a message without a URL around it.
 * Idempotent: redacting already-redacted text is a no-op.
 */
export function redactAccessTokens(text: string): string {
  if (!text) return text;
  return (
    text
      // https://x-access-token:ghs_xxx@github.com/... → https://x-access-token:***@github.com/...
      .replace(/(:\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:***@')
      // Bare token literals (ghp_/ghs_/gho_/ghu_/ghr_ and fine-grained PATs).
      .replace(/\bgh[psour]_[A-Za-z0-9]{16,}/g, '***')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
  );
}

/**
 * The user-facing message for "this environment cannot mint a token for that
 * org" — the org is named, so a multi-org import says WHICH side failed.
 *
 * @param orgLogin - Organization the token was being minted for.
 * @param error - Whatever the provider threw.
 */
export function describeTokenMintError(orgLogin: string | null | undefined, error: unknown): string {
  const org = orgLogin || 'unknown org';
  const status = extractStatus(error);
  const rawDetail = error instanceof Error ? error.message : String(error ?? '');
  const detail =
    status !== null
      ? String(status)
      : redactAccessTokens(rawDetail).slice(0, MAX_DETAIL_LENGTH) || 'unknown error';

  return (
    `GitHub App installation for '${org}' is not accessible (${detail}) — ` +
    "this environment's GitHub App may not be installed on that org"
  );
}
