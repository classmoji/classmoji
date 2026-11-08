/**
 * GET /.well-known/oauth-authorization-server — root-level OAuth 2.0
 * Authorization Server discovery metadata (RFC 8414).
 *
 * better-auth's oauth-provider serves this document only in-process
 * (`getOAuthServerConfig`), and MCP clients discover the AS at the ROOT of
 * the issuer origin. Serve it here through oauth-provider's own
 * `oauthProviderAuthServerMetadata` helper.
 *
 * INTENTIONALLY PUBLIC — AS discovery metadata is a public document by spec
 * (RFC 8414 §3): it contains only endpoint URLs and supported capabilities,
 * no secrets. No auth gate.
 */

import { auth, oauthProviderAuthServerMetadata } from '@classmoji/auth/server';
import { corsPreflightResponse, OAUTH_CORS_HEADERS } from '@classmoji/auth/oauth-http';
import type { LoaderFunctionArgs } from 'react-router';

// Readable from any origin, without credentials (a browser-based client's
// discovery); OPTIONS is a CORS preflight (@classmoji/auth/oauth-http).
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === 'OPTIONS') return corsPreflightResponse();
  return oauthProviderAuthServerMetadata(auth, { headers: OAUTH_CORS_HEADERS })(request);
}
