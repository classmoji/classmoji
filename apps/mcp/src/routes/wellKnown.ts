/**
 * GET /.well-known/oauth-protected-resource — RFC 9728 protected-resource
 * metadata for THIS resource server, pointing MCP clients at the webapp as
 * the authorization server.
 *
 * Deliberately NOT better-auth's `oAuthProtectedResourceMetadata(auth)`
 * helper: that helper derives `resource` from the auth instance's baseURL —
 * i.e. the WEBAPP origin (verified in better-auth 1.4.18,
 * node_modules/better-auth/dist/plugins/mcp/index.mjs:71-87) — which is the
 * wrong resource identifier for a standalone resource server. We emit the
 * document ourselves with `resource` = MCP_PUBLIC_URL. Scopes mirror the
 * mcp() plugin config in packages/auth/src/server.ts (read/write on top of
 * the fixed identity scopes).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { MCP_PUBLIC_URL, PROTECTED_RESOURCE_METADATA_PATH, WEBAPP_URL } from '../config.ts';

export default async function wellKnownRoutes(fastify: FastifyInstance) {
  const metadata = {
    resource: MCP_PUBLIC_URL,
    // better-auth serves the AS metadata under the webapp origin
    // (…/api/auth/.well-known/oauth-authorization-server) and advertises
    // the bare origin as its issuer — match that self-description here.
    authorization_servers: [new URL(WEBAPP_URL).origin],
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
