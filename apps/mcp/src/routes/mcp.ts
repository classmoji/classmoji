/**
 * POST /mcp — the Streamable HTTP endpoint.
 *
 * STATELESS by locked decision 3: a fresh McpServer + transport per request,
 * `sessionIdGenerator: undefined`, bearer token only; nothing is kept per
 * session and S3 (session binding) is N/A by construction. The one exception
 * is an identity hint: an `initialize` answer carries a fresh Mcp-Session-Id,
 * which clients send back on every later request (MCP spec), and that id
 * tells one person's agent sessions apart in live editing (presence, colour,
 * label). It authorizes nothing; see agentSessionFrom.
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
import { canonicalTimeZone } from '@classmoji/utils';
import { normalizeAgentSession } from '@classmoji/collab';
import { ASK_MOJI_CLIENT_ID } from '@classmoji/auth/mcp-token';
import type { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parseRoleCeiling, ROLE_CEILING_VALUES } from '../authz/pure.ts';

/**
 * The caller's rendering-zone hint. Validated against Intl and dropped when
 * invalid — never an error, since the only thing it can change is how a date
 * is labelled, and only for a classroom that has no zone of its own.
 */
export const TIMEZONE_HEADER = 'x-classmoji-timezone';

export function timezoneHintFrom(headers: Headers): string | null {
  return canonicalTimeZone(headers.get(TIMEZONE_HEADER));
}

/**
 * Ask Moji's role ceiling: the view (`viewAs`) the chat was opened in, so a
 * user who holds several roles resolves at or below it. Read only from the
 * Ask Moji client; every other client's header is ignored, whatever its value.
 * Unlike the zone hint it changes authorization, so a value from Ask Moji
 * that is not exactly one role is refused instead of dropped.
 */
export const ROLE_CEILING_HEADER = 'x-classmoji-role-ceiling';

export type RoleCeilingResult = { ok: true; ceiling: Role | null } | { ok: false; message: string };

export function roleCeilingFrom(headers: Headers, clientId: string | null): RoleCeilingResult {
  if (clientId !== ASK_MOJI_CLIENT_ID) return { ok: true, ceiling: null };
  const value = headers.get(ROLE_CEILING_HEADER);
  if (value === null) return { ok: true, ceiling: null };
  const ceiling = parseRoleCeiling(value);
  if (ceiling) return { ok: true, ceiling };
  return {
    ok: false,
    message: `Invalid X-Classmoji-Role-Ceiling header: expected one of ${ROLE_CEILING_VALUES.join(', ')}`,
  };
}

/**
 * Who is viewing as the user, when an Ask Moji conversation runs under
 * impersonation: the actor's user id, which the Ask Moji task sends on every
 * request of such a conversation. Read only from the Ask Moji client, like the
 * role ceiling; every other client's header is ignored, whatever its value.
 * It is written into audit rows, so a value from Ask Moji that is not a plain
 * id is refused instead of dropped.
 */
export const IMPERSONATED_BY_HEADER = 'x-classmoji-impersonated-by';

const IMPERSONATED_BY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ImpersonatedByResult =
  | { ok: true; impersonatedBy: string | null }
  | { ok: false; message: string };

export function impersonatedByFrom(
  headers: Headers,
  clientId: string | null
): ImpersonatedByResult {
  if (clientId !== ASK_MOJI_CLIENT_ID) return { ok: true, impersonatedBy: null };
  const value = headers.get(IMPERSONATED_BY_HEADER);
  if (value === null) return { ok: true, impersonatedBy: null };
  if (IMPERSONATED_BY_PATTERN.test(value)) return { ok: true, impersonatedBy: value };
  return {
    ok: false,
    message: 'Invalid X-Classmoji-Impersonated-By header: expected a user id',
  };
}

/** The Streamable HTTP session header. */
export const SESSION_HEADER = 'mcp-session-id';

/**
 * The agent session a request belongs to: the Mcp-Session-Id it carries, when
 * that is a plain token (else null — the caller's sessions then share one
 * presence). Client-supplied and never trusted: it only keys the caller's OWN
 * agent presence, under the user the bearer token resolved to.
 */
export function agentSessionFrom(headers: Headers): string | null {
  return normalizeAgentSession(headers.get(SESSION_HEADER));
}

/** A JSON-RPC body (or batch) that opens a session. */
export function isInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    message =>
      Boolean(message) &&
      typeof message === 'object' &&
      (message as { method?: unknown }).method === 'initialize'
  );
}

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
    let headers: Headers;
    let viewer;
    try {
      headers = toFetchHeaders(request);
      viewer = {
        ...(await resolveViewer(headers)),
        timezoneHint: timezoneHintFrom(headers),
        agentSession: agentSessionFrom(headers),
      };
    } catch (error) {
      const message = error instanceof UnauthorizedError ? error.message : 'Authentication failed';
      if (!(error instanceof UnauthorizedError)) request.log.error(error);
      return sendUnauthorized(reply, message);
    }

    // The ceiling and the impersonation actor depend on which client the
    // token was issued to, so they are read after the token is resolved.
    const roleCeiling = roleCeilingFrom(headers, viewer.clientId);
    if (!roleCeiling.ok) {
      return reply.status(400).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: roleCeiling.message },
        id: null,
      });
    }
    viewer.roleCeiling = roleCeiling.ceiling;
    const impersonatedBy = impersonatedByFrom(headers, viewer.clientId);
    if (!impersonatedBy.ok) {
      return reply.status(400).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: impersonatedBy.message },
        id: null,
      });
    }
    viewer.impersonatedBy = impersonatedBy.impersonatedBy;

    const server = buildMcpServer(viewer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses (no SSE stream needed per-request)
    });

    // Hand the raw streams to the SDK transport; Fastify must not touch the reply.
    reply.hijack();
    // A new session's id (the transport's own writeHead keeps it).
    if (isInitializeRequest(request.body)) reply.raw.setHeader(SESSION_HEADER, randomUUID());
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
