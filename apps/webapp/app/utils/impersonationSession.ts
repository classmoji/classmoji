/**
 * Whether the signed-in session is a platform admin viewing as another user
 * (better-auth admin impersonation). The session then belongs to the viewed
 * user, and so does the GitHub token `getAuthSession` returns for it.
 *
 * Routes that act on GitHub with the session user's own token refuse while
 * viewing as another user, since the change would be made with that user's
 * GitHub account.
 *
 * The same goes for connecting an app (MCP OAuth consent): the access token it
 * issues would act as the viewed user. That refusal is server-side in the
 * shared better-auth hook (packages/auth/src/appConnectionGuard.ts); the
 * consent page explains it and turns Approve off, reading the session both
 * ways (`isViewingAsAnotherUser`, @classmoji/auth/server) and showing the
 * message below.
 *
 * Takes the `getAuthSession` result; for a bare better-auth session
 * (`auth.api.getSession`), pass `{ session }`. Pure, so both loaders and
 * components can import it and the messages below.
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

// The same string the server-side refusal sends, from one place.
export { CONNECT_APP_VIEWING_AS_MESSAGE as CONNECT_APP_IMPERSONATION_MESSAGE } from '@classmoji/auth/app-connection';

export const GITLAB_CONNECT_IMPERSONATION_MESSAGE =
  "Connecting Gitlab isn't available while viewing as another user.";

export const CLASSROOM_REMOVE_IMPERSONATION_MESSAGE =
  "Removing a classroom isn't available while viewing as another user.";

/**
 * Settings and registration: no password, email or other account detail is
 * changed while viewing as another user, since it would be theirs. Those
 * actions check with `isViewingAsAnotherUser` (@classmoji/auth/server), which
 * reads the session from both the cookie cache and the database.
 */
export const ACCOUNT_DETAILS_IMPERSONATION_MESSAGE =
  "Changing account details isn't available while viewing as another user.";

/**
 * Billing (Settings → Billing): no checkout or billing portal is opened while
 * viewing as another user, since it would be for their plan and their Stripe
 * customer. The page still shows the plan. The actions check with
 * `isViewingAsAnotherUser` (@classmoji/auth/server), as the settings actions
 * above do.
 */
export const BILLING_IMPERSONATION_MESSAGE =
  "Billing isn't available while viewing as another user.";
