/**
 * Classmoji MCP server — standalone OAuth-protected MCP resource server.
 *
 * Topology (plan §3): the webapp is the OAuth 2.1 authorization server
 * (better-auth mcp() plugin at /api/auth); this service is the resource
 * server. Bearer tokens are validated in-process and DB-backed via the
 * resolveViewer seam (src/auth/resolveViewer.ts), so revocation is
 * immediate (S2).
 *
 * Endpoints:
 *   POST /mcp                                   — stateless Streamable HTTP MCP endpoint
 *   GET  /health                                — liveness check
 *   GET  /.well-known/oauth-protected-resource  — RFC 9728 metadata
 *   POST /dev/mint-token                        — dev-only, double-gated (S8)
 */

import Fastify, { type FastifyError } from 'fastify';
import { MCP_PORT, MCP_PUBLIC_URL, WEBAPP_URL } from './config.ts';
import { registerProcessSafetyNets } from './processSafety.ts';
import devMintRoutes from './routes/devMint.ts';
import mcpRoutes from './routes/mcp.ts';
import wellKnownRoutes from './routes/wellKnown.ts';
import { registerAllTools } from './tools/index.ts';

// Register tool definitions once at startup (validates the manifest).
registerAllTools();

const fastify = Fastify({
  logger: true,
});

// S5 process-level safety nets: a stray detached promise rejection (e.g. the
// fire-and-forget token reversal on grade_remove) must not crash the server.
// unhandledRejection → log + keep serving; uncaughtException → log, best-effort
// close, exit(1) (state may be corrupt; the process manager restarts clean).
registerProcessSafetyNets(fastify.log, {
  onFatal: code => {
    fastify
      .close()
      .catch(() => {})
      // eslint-disable-next-line no-process-exit
      .finally(() => process.exit(code));
  },
});

fastify.get('/health', async (_request, reply) => {
  return reply.status(200).send({ status: 'ok', service: 'classmoji-mcp' });
});

await fastify.register(wellKnownRoutes);
await fastify.register(mcpRoutes);

// S8: dev token mint is double-gated — same idiom as the webapp's test-login
// route (apps/webapp/app/routes/test-login/route.tsx). Never registered
// unless BOTH flags are set; asserted below.
const DEV_MINT_ENABLED =
  process.env.NODE_ENV === 'development' && process.env.ENABLE_TEST_LOGIN === 'true';
if (DEV_MINT_ENABLED) {
  await fastify.register(devMintRoutes);
  fastify.log.warn('[mcp] dev token-mint endpoint ENABLED (POST /dev/mint-token)');
}
// Startup assertion: the mint route must not exist when the gates are off.
if (!DEV_MINT_ENABLED && fastify.hasRoute({ method: 'POST', url: '/dev/mint-token' })) {
  throw new Error('[mcp] SECURITY: dev mint route registered while gates are off');
}

// S5 final error hook: anything that escapes route handlers becomes a clean
// JSON response — never a hung request or a crashed process. Fastify's own
// 4xx errors (e.g. malformed JSON body → 400 parse error) pass through.
fastify.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  if (statusCode >= 500) {
    request.log.error(error, '[mcp] unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  }
  return reply
    .status(statusCode)
    .send({ error: error.code ?? 'bad_request', message: error.message });
});

try {
  await fastify.listen({ port: MCP_PORT, host: '0.0.0.0' });
  console.log(
    `🔌 Classmoji MCP server listening on port ${MCP_PORT} ` +
      `(public: ${MCP_PUBLIC_URL}, authorization server: ${WEBAPP_URL})`
  );
} catch (err: unknown) {
  fastify.log.error(err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}
