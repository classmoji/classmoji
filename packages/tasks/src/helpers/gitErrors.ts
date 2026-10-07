/**
 * Github refusals that only the instructor or the org owner can fix, recognised
 * so a run can stop with words that say what to do instead of Github's own.
 * Both are permanent: retrying changes nothing until someone acts, so callers
 * end the run (AbortTaskRunError) rather than let it retry.
 */

/**
 * Github's 403 when the Classmoji app lacks a permission in the org: an update
 * to the app's permissions the org owner has not accepted yet, or an org policy
 * the app cannot override (for instance, members may not add outside
 * collaborators).
 */
export function isAppPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; message?: unknown };
  return (
    e.status === 403 &&
    typeof e.message === 'string' &&
    /resource not accessible by integration/i.test(e.message)
  );
}

/** git's answer when a remote repository does not exist or cannot be read. */
export function isRepoNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    /remote: repository not found|repository '[^']*' not found/i.test(message)
  );
}

/** What to tell the instructor when Github refused to give a student or team access. */
export const appPermissionDeniedMessage = (org: string, repoName: string): string =>
  `Github refused to give access to ${org}/${repoName}: the Classmoji app is not allowed to ` +
  `add collaborators in ${org}. An owner of ${org} should accept any pending permission ` +
  `request for the Classmoji app (Settings, then Github Apps) and allow outside ` +
  `collaborators, then run Sync on the repository.`;

/** What to tell the instructor when a repository's template cannot be read. */
export const templateNotFoundMessage = (template: string): string =>
  `The template repository ${template} was not found, or the Classmoji app cannot read it. ` +
  `Check the template set on the repository (it may have been renamed, deleted or made ` +
  `private elsewhere), then run the update again.`;
