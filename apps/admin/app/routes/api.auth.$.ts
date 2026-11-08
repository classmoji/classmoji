import { auth } from '@classmoji/auth/server';
import { withoutSessionTokens } from '@classmoji/auth/session-response';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * better-auth on this origin, for the calls apps/admin makes itself and
 * nothing else.
 *
 * `authClient` sets `baseURL` to `window.location.origin`, so this app's auth
 * calls post here rather than to the webapp. It is the same `auth` instance
 * over the same database, secret and cookie prefix, so a session started here
 * is valid on the webapp at once: that is what makes cross-app "View as"
 * work. `ADMIN_URL` must be in better-auth's `trustedOrigins` (see
 * packages/auth/src/server.ts) or every request here is refused on origin.
 *
 * The calls, exactly as the client sends them (@classmoji/auth/client):
 *   - POST /api/auth/admin/impersonate-user: View as (hooks/useViewAs.ts);
 *   - POST /api/auth/sign-out: Sign out and Switch account (routes/_shell,
 *     root.tsx).
 * Nothing here reads the session over HTTP (no `useSession`; the loaders
 * read it in process), and View as is stopped on the webapp
 * (ImpersonationBanner). Every other path, and these paths by another
 * method, answers 404 before better-auth runs: the authorization server's
 * endpoints, its discovery documents and the rest of better-auth are served
 * on the webapp only. The match is on the URL's path as better-auth would
 * route it (exact, case-sensitive; `..` is already resolved by the URL), so
 * no spelling of another path gets through.
 *
 * Session responses leave without their rows' `token` field (see
 * @classmoji/auth/session-response).
 */
const ADMIN_AUTH_CALLS: ReadonlyMap<string, string> = new Map([
  ['/api/auth/admin/impersonate-user', 'POST'],
  ['/api/auth/sign-out', 'POST'],
]);

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (ADMIN_AUTH_CALLS.get(pathname) !== request.method) {
    return new Response('Not Found', { status: 404 });
  }
  return withoutSessionTokens(request, await auth.handler(request));
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}
