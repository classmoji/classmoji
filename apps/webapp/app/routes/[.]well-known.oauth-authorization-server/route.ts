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
import type { LoaderFunctionArgs } from 'react-router';

export async function loader({ request }: LoaderFunctionArgs) {
  return oauthProviderAuthServerMetadata(auth)(request);
}
