import { auth } from '@classmoji/auth/server';
import { rejectUnsafeDynamicClientRegistration } from '@classmoji/auth/oauth-redirect';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * better-auth handler for this origin.
 *
 * Needed because `authClient` sets `baseURL` to `window.location.origin`, so
 * calls from this app (notably `admin.impersonateUser`) post here rather than to
 * the webapp. It is the same `auth` instance over the same database, secret and
 * cookie prefix, so sessions minted here are immediately valid on the webapp —
 * that is what makes cross-app impersonation work.
 *
 * `ADMIN_URL` must be in better-auth's `trustedOrigins` (see
 * packages/auth/src/server.ts) or every request here is rejected on origin.
 *
 * The DCR guard is NOT optional: this handler inherits the mcp plugin's
 * `/mcp/register` and `/oauth2/register` endpoints, so without it this origin
 * reopens the `javascript:` redirect_uri XSS the webapp closed.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return auth.handler(request);
}

export async function action({ request }: ActionFunctionArgs) {
  const rejection = await rejectUnsafeDynamicClientRegistration(request);
  if (rejection) return rejection;
  return auth.handler(request);
}
