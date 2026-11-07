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
import type { LoaderFunctionArgs } from 'react-router';

export async function loader({ request }: LoaderFunctionArgs) {
  return oauthProviderOpenIdConfigMetadata(auth)(request);
}
