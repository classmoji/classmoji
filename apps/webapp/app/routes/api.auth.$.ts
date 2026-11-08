import { auth } from '@classmoji/auth/server';
import {
  corsPreflightResponse,
  isOAuthCorsPreflight,
  withLegacyMcpPathMapped,
  withOAuthCors,
} from '@classmoji/auth/oauth-http';
import { rejectUnsafeDynamicClientRegistration } from '@classmoji/auth/oauth-redirect';
import { withoutSessionTokens } from '@classmoji/auth/session-response';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * better-auth on the webapp's origin, in this order:
 *   1. a 1.4 MCP path (`/api/auth/mcp/{authorize,token,register}`) goes on to
 *      its oauth-provider path, before anything else looks at the path
 *      (@classmoji/auth/oauth-http);
 *   2. a CORS preflight for the endpoints browser-based clients call is
 *      answered here;
 *   3. a client registration naming a redirect URI the consent page would not
 *      follow is refused (@classmoji/auth/oauth-redirect);
 *   4. everything else is better-auth's, and session responses leave without
 *      their rows' `token` field (@classmoji/auth/session-response);
 *   5. those endpoints' answers carry the CORS headers, errors included.
 * React Router hands GET, HEAD and OPTIONS to the loader and the rest to the
 * action; both run the same steps.
 */
async function handle(request: Request): Promise<Response> {
  const routed = await withLegacyMcpPathMapped(request);
  if (isOAuthCorsPreflight(routed)) return corsPreflightResponse();
  const refused = await rejectUnsafeDynamicClientRegistration(routed);
  const response = refused ?? (await withoutSessionTokens(routed, await auth.handler(routed)));
  return withOAuthCors(routed, response);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}
