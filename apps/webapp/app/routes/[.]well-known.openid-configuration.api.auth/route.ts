/**
 * GET /.well-known/openid-configuration/api/auth — RFC 8414 §5 / OIDC
 * path-aware discovery for clients that treat the Better Auth basePath
 * (http://host/api/auth) as the authorization-server identifier. Observed
 * live alongside the oauth-authorization-server form (see sibling route).
 * Same document at every standard location; public by spec.
 */

import { auth, oauthProviderOpenIdConfigMetadata } from '@classmoji/auth/server';
import {
  corsPreflightResponse,
  OAUTH_CORS_HEADERS,
  withoutUnsupportedMetadata,
} from '@classmoji/auth/oauth-http';
import type { LoaderFunctionArgs } from 'react-router';

// Readable from any origin, without credentials (a browser-based client's
// discovery); OPTIONS is a CORS preflight (@classmoji/auth/oauth-http).
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === 'OPTIONS') return corsPreflightResponse();
  // Without the DPoP keys: no token is DPoP-bound (@classmoji/auth/oauth-http).
  return withoutUnsupportedMetadata(
    await oauthProviderOpenIdConfigMetadata(auth, { headers: OAUTH_CORS_HEADERS })(request)
  );
}
