/**
 * GET /.well-known/openid-configuration — root-level OIDC-style discovery.
 *
 * MCP clients try several standard discovery locations in order (RFC 8414
 * oauth-authorization-server and OIDC openid-configuration, each in
 * path-aware and root form) and some versions 404 out instead of trying the
 * next form. Serve the same document better-auth publishes for the
 * authorization server at every standard location so discovery can never
 * dead-end into the RFC-default /authorize fallback.
 *
 * INTENTIONALLY PUBLIC — discovery metadata is a public document by spec
 * (RFC 8414 §3): endpoint URLs and capabilities only, no secrets.
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
