/**
 * GET /.well-known/oauth-authorization-server/api/auth — RFC 8414 §3.1
 * path-aware discovery for clients that treat the Better Auth basePath
 * (http://host/api/auth) as the authorization-server identifier. Observed
 * live: Claude Code requests exactly this form and falls back to the
 * RFC-default /authorize endpoint (which doesn't exist here) when it 404s.
 * Same document as the root form; see that route for the public-by-spec note.
 */

import { auth } from '@classmoji/auth/server';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import type { LoaderFunctionArgs } from 'react-router';

export async function loader({ request }: LoaderFunctionArgs) {
  return oAuthDiscoveryMetadata(auth)(request);
}
