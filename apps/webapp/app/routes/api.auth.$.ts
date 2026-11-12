import { auth } from '@classmoji/auth/server';
import {
  corsPreflightResponse,
  isOAuthCorsPreflight,
  withFormBodyLimited,
  withLegacyMcpPathMapped,
  withOAuthCors,
} from '@classmoji/auth/oauth-http';
import { rejectUnsafeDynamicClientRegistration } from '@classmoji/auth/oauth-redirect';
import { withoutSessionTokens } from '@classmoji/auth/session-response';
import type { LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';

/**
 * better-auth on the webapp's origin, in this order:
 *   1. a body better-auth would parse as a form is read through the
 *      byte-counting reader with its fields counted, or refused with a 413
 *      (@classmoji/auth/oauth-http);
 *   2. a 1.4 MCP path (`/api/auth/mcp/{authorize,token,register}`) goes on to
 *      its oauth-provider path, before anything else looks at the path
 *      (@classmoji/auth/oauth-http);
 *   3. a CORS preflight for the endpoints browser-based clients call is
 *      answered here;
 *   4. a client registration naming a redirect URI the consent page would not
 *      follow is refused (@classmoji/auth/oauth-redirect);
 *   5. everything else is better-auth's, and session responses leave without
 *      their rows' `token` field (@classmoji/auth/session-response);
 *   6. those endpoints' answers carry the CORS headers, errors included (the
 *      refusal in step 1 too).
 * React Router hands GET, HEAD and OPTIONS to the loader and the rest to the
 * action; both run the same steps.
 */
async function handle(request: Request): Promise<Response> {
  const limited = await withFormBodyLimited(request);
  if (limited instanceof Response) {
    // CORS is decided on the path the request would have been sent on to,
    // which the body-less copy below gives without reading the body again.
    return withOAuthCors(await withLegacyMcpPathMapped(new Request(request.url)), limited);
  }
  const routed = await withLegacyMcpPathMapped(limited);
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
