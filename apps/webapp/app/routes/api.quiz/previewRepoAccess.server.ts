/**
 * Whether a teaching-team member's own GitHub account can open a repository
 * in the classroom's GitHub organization: the check a code-aware quiz preview
 * makes before it stores the repository it tests with (api.quiz restartQuiz).
 *
 * The chat runtime explores a preview's repository with the GitHub App's
 * installation token, which reaches every repository the app is installed
 * on. The legacy start read it with the member's own token instead, so a
 * preview only ever read what that person could open on GitHub. Asking GitHub
 * with the member's own token before the name is stored keeps that boundary.
 *
 * The token is a GitHub App user token: GitHub answers with what both the
 * person and the app can reach.
 */
import { Octokit } from '@octokit/rest';

/**
 * - `readable`: the member's account opens the repository.
 * - `unreadable`: it does not (GitHub answers 404 or 403), or the name is not a
 *   repository name at all.
 * - `sign_in`: no usable GitHub token for the member (none stored, or GitHub
 *   refuses it).
 * - `unavailable`: GitHub could not be asked (rate limit, an error, a timeout).
 */
export type PreviewRepoAccess = 'readable' | 'unreadable' | 'sign_in' | 'unavailable';

/** A GitHub repository name. `.` and `..` match the characters but name nothing. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** How long GitHub gets to answer before the check gives up. */
const CHECK_TIMEOUT_MS = 10_000;

export async function previewRepoAccess({
  token,
  owner,
  repo,
}: {
  /** The member's own GitHub user token (their session's). */
  token: string | null | undefined;
  /** The classroom's GitHub organization login, never a caller-supplied value. */
  owner: string | null | undefined;
  repo: string;
}): Promise<PreviewRepoAccess> {
  if (!owner || !REPO_NAME.test(repo) || repo === '.' || repo === '..') return 'unreadable';
  if (!token) return 'sign_in';
  try {
    await new Octokit({ auth: token }).rest.repos.get({
      owner,
      repo,
      request: { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
    });
    return 'readable';
  } catch (error: unknown) {
    const { status, response } = (error ?? {}) as {
      status?: unknown;
      response?: { headers?: Record<string, unknown> };
    };
    if (status === 401) return 'sign_in';
    if (status === 404) return 'unreadable';
    if (status === 403) {
      // GitHub also answers 403 when the rate limit is spent.
      return response?.headers?.['x-ratelimit-remaining'] === '0' ? 'unavailable' : 'unreadable';
    }
    return 'unavailable';
  }
}
