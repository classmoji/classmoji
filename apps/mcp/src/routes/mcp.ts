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
 *
 * The bearer token is checked in the route's `onRequest` hook, which Fastify
 * runs before it reads or parses the body: a request without a valid token is
 * answered from its headers alone, and only an authenticated request has its
 * body (up to `MCP_BODY_LIMIT_BYTES`) read and parsed.
 *
 * Then the size of what was sent is bounded (the limits are in
 * mcp/inputLimits.ts): this plugin's JSON parser refuses a body
 * with more than MAX_BODY_JSON_VALUES values before parsing it, the handler
 * refuses a batch that carries more than one request other than `tools/call`
 * (batchCarriesOtherRequests), and it gates every `tools/call`
 * (toolCallGate.ts) before the SDK validates its arguments.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MCP_PUBLIC_URL, PROTECTED_RESOURCE_METADATA_PATH } from '../config.ts';
import { resolveViewer, type Viewer } from '../auth/resolveViewer.ts';
import {
  TokenStoreUnavailableError,
  UnauthorizedError,
  UnsupportedTokenFormatError,
} from '../mcp/errors.ts';
import { jsonValueBound, MAX_BODY_JSON_VALUES, ToolInputBudget } from '../mcp/inputLimits.ts';
import { toolCallBucketKey, tryConsume, TOOL_CALL_RATE_LIMIT } from '../mcp/rateLimit.ts';
import { buildMcpServer } from '../mcp/registry.ts';
import { gateToolCalls } from './toolCallGate.ts';
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

/**
 * Whether a JSON-RPC batch (an array body) carries more than one request other
 * than `tools/call`. The MCP spec (2025-06-18) dropped JSON-RPC batching; only
 * tool calls, which the gate meters, may still arrive together. A request is a
 * message with a `method` and an `id`; a message without an `id` is a
 * notification, which gets no answer, so it is not counted. A single message
 * is never a batch.
 */
export function batchCarriesOtherRequests(body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  let others = 0;
  for (const message of body) {
    if (!message || typeof message !== 'object') continue;
    const { method, id } = message as { method?: unknown; id?: unknown };
    if (method === undefined || method === 'tools/call' || id === undefined) continue;
    others += 1;
    if (others > 1) return true;
  }
  return false;
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

/** Seconds a client is asked to wait when the token could not be checked. */
export const TOKEN_STORE_RETRY_AFTER_SECONDS = 30;

/**
 * The token could not be checked at all (the token store is unavailable, or
 * the token is in a format a newer version of this server reads), so nothing
 * is known about it: a 503 asking the client to try again, and on purpose NO
 * `WWW-Authenticate` challenge, which would send it into signing in again
 * with a token that may be perfectly good.
 */
function sendTryAgain(reply: FastifyReply) {
  return reply
    .status(503)
    .header('Retry-After', String(TOKEN_STORE_RETRY_AFTER_SECONDS))
    .header('Access-Control-Expose-Headers', 'Retry-After')
    .send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Service temporarily unavailable: try again shortly' },
      id: null,
    });
}

/** What the onRequest hook learned from the headers, for the handler. */
interface Authenticated {
  headers: Headers;
  viewer: Viewer;
}

const authenticated = new WeakMap<FastifyRequest, Authenticated>();

/**
 * Resolve the bearer token from the headers alone. As an `onRequest` hook it
 * runs before Fastify reads the body, so a refused request is answered without
 * the body ever being parsed.
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    const headers = toFetchHeaders(request);
    const viewer: Viewer = {
      ...(await resolveViewer(headers)),
      timezoneHint: timezoneHintFrom(headers),
      agentSession: agentSessionFrom(headers),
    };
    authenticated.set(request, { headers, viewer });
  } catch (error) {
    if (error instanceof TokenStoreUnavailableError) {
      request.log.warn({ err: error.cause }, '[mcp] token store unavailable; answering 503');
      return sendTryAgain(reply);
    }
    if (error instanceof UnsupportedTokenFormatError) {
      request.log.info('[mcp] bearer in a newer token format; answering 503');
      return sendTryAgain(reply);
    }
    const message = error instanceof UnauthorizedError ? error.message : 'Authentication failed';
    if (!(error instanceof UnauthorizedError)) request.log.error(error);
    return sendUnauthorized(reply, message);
  }
}

/** The elements of large tool calls in flight, shared by every request. */
const sharedToolInputBudget = new ToolInputBudget();

export interface McpRoutesOptions {
  /** Tests pass their own; the server uses one budget for all requests. */
  budget?: ToolInputBudget;
}

export default async function mcpRoutes(fastify: FastifyInstance, opts: McpRoutesOptions = {}) {
  const budget = opts.budget ?? sharedToolInputBudget;
  // Resource definitions register once alongside route registration
  // (idempotent; tools register in src/index.ts via registerAllTools).
  registerAllResources();

  // This plugin's JSON parser: Fastify's own (same poisoning rules as the
  // server), after a count of the body's JSON values on the raw text. A body
  // over MAX_BODY_JSON_VALUES is refused with a 413 without being parsed; it
  // still takes a token from the sender's tools/call bucket.
  const parseJson = fastify.getDefaultJsonParser(
    fastify.initialConfig.onProtoPoisoning ?? 'error',
    fastify.initialConfig.onConstructorPoisoning ?? 'error'
  );
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = body as string;
    if (jsonValueBound(text, MAX_BODY_JSON_VALUES) > MAX_BODY_JSON_VALUES) {
      const viewer = authenticated.get(request)?.viewer;
      if (viewer) tryConsume(toolCallBucketKey(viewer.userId), TOOL_CALL_RATE_LIMIT);
      request.log.warn(
        {
          userId: viewer?.userId,
          clientId: viewer?.clientId,
          bytes: text.length,
          limit: MAX_BODY_JSON_VALUES,
        },
        '[mcp] request body over the JSON value limit'
      );
      const error = Object.assign(
        new Error(
          `The request carries more than ${MAX_BODY_JSON_VALUES} JSON values; split the change ` +
            'into several smaller calls.'
        ),
        { statusCode: 413, code: 'MCP_INPUT_TOO_LARGE' }
      );
      done(error, undefined);
      return;
    }
    parseJson(request, text, done);
  });

  fastify.post('/mcp', { onRequest: authenticate }, async (request, reply) => {
    const auth = authenticated.get(request);
    // The hook either set this or already answered; never serve without it.
    if (!auth) return sendUnauthorized(reply, 'Authentication failed');
    const { headers, viewer } = auth;

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

    // Batches: tool calls only, plus at most one other request.
    if (batchCarriesOtherRequests(request.body)) {
      request.log.warn(
        { userId: viewer.userId, clientId: viewer.clientId },
        '[mcp] batch with more than one request other than tools/call refused'
      );
      return reply.status(400).send({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message:
            'Invalid Request: a batch may carry at most one request other than tools/call; ' +
            'send the others one per POST.',
        },
        id: null,
      });
    }

    // tools/call: rate, size and room in flight, before the SDK validates.
    const gate = gateToolCalls(request.body, {
      userId: viewer.userId,
      clientId: viewer.clientId,
      log: request.log,
      budget,
    });
    if (!gate.ok) return reply.status(gate.status).send(gate.body);
    reply.raw.on('close', gate.release);

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
