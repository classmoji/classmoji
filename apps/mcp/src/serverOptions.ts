/**
 * The options index.ts builds the Fastify server with, in their own module so
 * a test can build the same server.
 */

import { MCP_BODY_LIMIT_BYTES } from './bodyLimit.ts';

/**
 * The longest a client may take to send one whole request, headers and body.
 * Fastify's default is no limit. Past it, Node answers 408 and closes the
 * connection, which ends the request and frees its body (and the bytes it
 * held in the in-flight body budget, mcp/bodyBudget.ts).
 *
 * It covers RECEIVING the request only: Node stops timing a request once its
 * body is complete, so a tool that takes longer to answer is not cut off. (This
 * server has no long-lived stream to protect: GET /mcp answers 405.)
 *
 * 60 seconds: the largest body (MCP_BODY_LIMIT_BYTES, 8 MiB) then needs an
 * upload of about 1.1 Mbit/s. Bodies a model writes are far smaller (one turn
 * of model output is well under 1 MiB), so only a script sending a near-limit
 * file comes close.
 */
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How often Node looks for requests past the timeout. Node's default is 30 s,
 * which would let a request run up to 30 s over; at 5 s it is cut between 60
 * and 65 s.
 */
export const MCP_CONNECTIONS_CHECKING_INTERVAL_MS = 5_000;

/** Tests pass shorter timings; the server uses the defaults. */
export function mcpServerOptions(
  requestTimeout = MCP_REQUEST_TIMEOUT_MS,
  connectionsCheckingInterval = MCP_CONNECTIONS_CHECKING_INTERVAL_MS
) {
  return {
    logger: true,
    /**
     * Bigger than Fastify's 1 MiB default so the tools that take large payloads
     * can refuse them with their own, readable errors. See `bodyLimit.ts`, which
     * page_asset_upload also derives its file cap from.
     */
    bodyLimit: MCP_BODY_LIMIT_BYTES,
    requestTimeout,
    /**
     * Node's http.createServer options. The request timeout is passed here
     * too: Node cuts a request off at the LONGER of its header timeout and its
     * request timeout, and fixes the header timeout when the server is created
     * (at most 60 s, never more than the request timeout), whereas Fastify
     * sets the request timeout only after creating it.
     */
    http: { requestTimeout, connectionsCheckingInterval },
  };
}
