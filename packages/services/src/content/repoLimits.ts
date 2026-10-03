/**
 * repoLimits.ts — GitHub's refusal of an over-sized commit, as one typed error.
 *
 * The NUMBER lives in `@classmoji/utils/repo-limits` (`REPO_REST_MAX_BYTES`),
 * because the browser needs it too. What lives here is the server half: the
 * test for "GitHub refused this because it was too big", and the one error
 * every REST write path turns that refusal into, so a caller catches one type
 * and a person reads one sentence whichever path the bytes took.
 *
 * Pure: no GitHub client, no Prisma. It reads `status` and `message` off
 * whatever was thrown, so any module can import it without dragging a network
 * layer along — `slideSource.ts` re-exports `isCommitTooLargeRefusal` from here
 * for the callers that already import it from there.
 */

import { REPO_REST_MAX_BYTES, repoFileTooLargeMessage } from '@classmoji/utils';

/**
 * Is this GitHub refusing a write because the request body was too big?
 *
 * What it buys is the sentence. GitHub's own ends "Consider creating the blob
 * in a local clone of the repository and then pushing it to GitHub" — advice
 * nobody uploading through this product can act on, and not something to put in
 * front of an instructor verbatim.
 *
 * 413 on its own is unambiguous. 422 is not — it is also the status behind
 * "not a fast forward" and every other Git Data validation failure — so it
 * counts only together with the message that came with it.
 *
 * `RepoFileTooLargeError` carries `status: 413`, so a caller that asks this
 * about an error `ContentService` has already mapped still gets `true`.
 */
export function isCommitTooLargeRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, message } = error as { status?: unknown; message?: unknown };
  if (status === 413) return true;
  return status === 422 && typeof message === 'string' && /too large/i.test(message);
}

/**
 * A file too large for a course repository — refused by us before the write,
 * or by GitHub during it. Either way the person reads the same sentence.
 *
 * `status` 413 so an HTTP route can answer with it directly, and so
 * `isCommitTooLargeRefusal` recognises an error that has already been mapped.
 */
export class RepoFileTooLargeError extends Error {
  readonly status = 413 as const;
  readonly code = 'REPO_FILE_TOO_LARGE' as const;
  readonly limitBytes = REPO_REST_MAX_BYTES;
  /** The file's name as the person knows it, when there is one to name. */
  readonly filename?: string;

  // No constructor parameter properties: this module is loaded by bare
  // `node --experimental-strip-types` in some app tests, which refuses them.
  constructor(filename?: string, options?: { cause?: unknown }) {
    super(repoFileTooLargeMessage(filename), options);
    this.name = 'RepoFileTooLargeError';
    this.filename = filename;
  }
}

/**
 * Rethrow GitHub's too-large refusal as `RepoFileTooLargeError`; anything else
 * unchanged. For a `catch` around a write: `catch (e) { throw asRepoTooLarge(e, name) }`.
 */
export function asRepoTooLarge(error: unknown, filename?: string): unknown {
  if (error instanceof RepoFileTooLargeError) return error;
  return isCommitTooLargeRefusal(error)
    ? new RepoFileTooLargeError(filename, { cause: error })
    : error;
}
