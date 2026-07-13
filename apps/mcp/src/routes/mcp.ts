/**
 * POST /mcp — the Streamable HTTP endpoint.
 *
 * STATELESS by locked decision 3: a fresh McpServer + transport per request,
 * `sessionIdGenerator: undefined` (no Mcp-Session-Id is ever issued or
 * accepted), bearer token only. S3 (session binding) is N/A by construction.
 *
 * The SDK's StreamableHTTPServerTransport works on Node's raw
 * IncomingMessage/ServerResponse, so we `reply.hijack()` and hand it the raw
 * streams plus Fastify's already-parsed JSON body (malformed JSON is rejected
 * by Fastify with a 400 before this handler runs).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MCP_PUBLIC_URL, PROTECTED_RESOURCE_METADATA_PATH } from '../config.ts';
import { resolveViewer } from '../auth/resolveViewer.ts';
import { UnauthorizedError } from '../mcp/errors.ts';
import { buildMcpServer } from '../mcp/registry.ts';
import { registerAllResources } from '../resources/index.ts';

/** RFC 9728 §5.1: challenge advertises where our protected-resource metadata lives. */
const WWW_AUTHENTICATE_VALUE = `Bearer resource_metadata="${MCP_PUBLIC_URL}${PROTECTED_RESOURCE_METADATA_PATH}"`;

function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return headers;
}

function sendUnauthorized(reply: FastifyReply, message: string) {
  // Same shape better-auth's withMcpAuth returns (JSON-RPC error + challenge).
  return reply
    .status(401)
    .header('WWW-Authenticate', WWW_AUTHENTICATE_VALUE)
    .header('Access-Control-Expose-Headers', 'WWW-Authenticate')
    .send({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Unauthorized: ${message}` },
      id: null,
    });
}

export default async function mcpRoutes(fastify: FastifyInstance) {
  // Resource definitions register once alongside route registration
  // (idempotent; tools register in src/index.ts via registerAllTools).
  registerAllResources();

  fastify.post('/mcp', async (request, reply) => {
    let viewer;
    try {
      viewer = await resolveViewer(toFetchHeaders(request));
    } catch (error) {
      const message = error instanceof UnauthorizedError ? error.message : 'Authentication failed';
      if (!(error instanceof UnauthorizedError)) request.log.error(error);
      return sendUnauthorized(reply, message);
    }

    const server = buildMcpServer(viewer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses (no SSE stream needed per-request)
    });

    // Hand the raw streams to the SDK transport; Fastify must not touch the reply.
    reply.hijack();
    const cleanup = () => {
      void transport.close();
      void server.close();
    };
    reply.raw.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      // S5: a transport/server failure must never hang the request.
      request.log.error(error, '[mcp] transport error');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      cleanup();
    }
  });

  // Stateless server: no SSE notification stream, no sessions to delete.
  // Per the Streamable HTTP spec, unsupported methods return 405 + Allow.
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed — stateless server, POST only' },
        id: null,
      });
  fastify.get('/mcp', methodNotAllowed);
  fastify.delete('/mcp', methodNotAllowed);
}
