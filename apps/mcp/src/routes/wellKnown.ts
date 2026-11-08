/**
 * GET /.well-known/oauth-protected-resource — RFC 9728 protected-resource
 * metadata for THIS resource server, pointing MCP clients at the webapp as
 * the authorization server.
 *
 * Written here rather than taken from the OAuth server, which describes the
 * webapp's origin: the resource is MCP_RESOURCE (`<MCP_PUBLIC_URL>/mcp`, the
 * URL clients connect to and the `aud` the OAuth server issues tokens for),
 * and the authorization server is AUTH_ISSUER, the webapp's origin and the
 * issuer it signs with. Both come from packages/auth/src/mcpResource.ts, the
 * same values the OAuth server uses. Scopes are the two this server checks;
 * the identity scopes and `offline_access` are the OAuth server's own.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { AUTH_ISSUER, MCP_RESOURCE, PROTECTED_RESOURCE_METADATA_PATH } from '../config.ts';

export default async function wellKnownRoutes(fastify: FastifyInstance) {
  const metadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [AUTH_ISSUER],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
  };
  const serve = async (_request: unknown, reply: FastifyReply) => {
    return reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Cache-Control', 'public, max-age=300')
      .send(metadata);
  };
  fastify.get(PROTECTED_RESOURCE_METADATA_PATH, serve);
  // RFC 9728 path-aware location for the /mcp resource: clients that treat
  // the endpoint path as part of the resource identifier request
  // /.well-known/oauth-protected-resource/mcp FIRST (the installed MCP SDK
  // does exactly this and only falls back to the root form on 404 — some
  // client versions don't fall back). Serve the same document at both.
  fastify.get(`${PROTECTED_RESOURCE_METADATA_PATH}/mcp`, serve);
}
