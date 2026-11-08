/**
 * GET /.well-known/oauth-authorization-server/api/auth — RFC 8414 §3.1
 * path-aware discovery for clients that treat the Better Auth basePath
 * (http://host/api/auth) as the authorization-server identifier. Observed
 * live: Claude Code requests exactly this form and falls back to the
 * RFC-default /authorize endpoint (which doesn't exist here) when it 404s.
 * Same document as the root form; see that route for the public-by-spec note.
 */

import { auth, oauthProviderAuthServerMetadata } from '@classmoji/auth/server';
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
    await oauthProviderAuthServerMetadata(auth, { headers: OAUTH_CORS_HEADERS })(request)
  );
}
