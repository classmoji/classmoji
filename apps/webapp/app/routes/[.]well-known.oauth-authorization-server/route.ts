/**
 * GET /.well-known/oauth-authorization-server — root-level OAuth 2.0
 * Authorization Server discovery metadata (RFC 8414).
 *
 * better-auth's mcp() plugin serves this document only under its basePath
 * (/api/auth/.well-known/oauth-authorization-server), but MCP clients
 * discover the AS at the ROOT of the issuer origin. Serve the identical
 * document here via better-auth's own oAuthDiscoveryMetadata helper so the
 * two endpoints can never diverge.
 *
 * INTENTIONALLY PUBLIC — AS discovery metadata is a public document by spec
 * (RFC 8414 §3): it contains only endpoint URLs and supported capabilities,
 * no secrets. No auth gate, matching better-auth's own basePath endpoint.
 */

import { auth } from '@classmoji/auth/server';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import type { LoaderFunctionArgs } from 'react-router';

export async function loader({ request }: LoaderFunctionArgs) {
  return oAuthDiscoveryMetadata(auth)(request);
}
