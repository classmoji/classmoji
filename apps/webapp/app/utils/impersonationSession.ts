/**
 * Whether the signed-in session is a platform admin viewing as another user
 * (better-auth admin impersonation). The session then belongs to the viewed
 * user, and so does the GitHub token `getAuthSession` returns for it.
 *
 * Routes that act on GitHub with the session user's own token refuse while
 * viewing as another user, since the change would be made with that user's
 * GitHub account.
 *
 * Takes the `getAuthSession` result. Pure, so both loaders and components can
 * import it and the messages below.
 */
export const isImpersonatingSession = (authData: unknown): boolean =>
  Boolean(
    (authData as { session?: { session?: { impersonatedBy?: string | null } } } | null | undefined)
      ?.session?.session?.impersonatedBy
  );

export const ORG_SETTINGS_IMPERSONATION_MESSAGE =
  "Changes to GitHub organization settings aren't available while viewing as another user.";

export const GITHUB_CLEANUP_IMPERSONATION_MESSAGE =
  "Deleting GitHub artifacts isn't available while viewing as another user.";

export const CLASSROOM_REMOVE_IMPERSONATION_MESSAGE =
  "Removing a classroom isn't available while viewing as another user.";
