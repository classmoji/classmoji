/**
 * GET /.well-known/openid-configuration/api/auth — RFC 8414 §5 / OIDC
 * path-aware discovery for clients that treat the Better Auth basePath
 * (http://host/api/auth) as the authorization-server identifier. Observed
 * live alongside the oauth-authorization-server form (see sibling route).
 * Same document at every standard location; public by spec.
 */

import { auth } from '@classmoji/auth/server';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import type { LoaderFunctionArgs } from 'react-router';

export async function loader({ request }: LoaderFunctionArgs) {
  return oAuthDiscoveryMetadata(auth)(request);
}
