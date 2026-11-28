/**
 * The server's final error handler (S5): anything that escapes a route
 * handler becomes a clean JSON response, never a hung request or a crashed
 * process. Fastify's own 4xx errors (e.g. malformed JSON body → 400 parse
 * error) pass through with their status.
 *
 * A 5xx is logged and handed to the error reporter (Sentry when the server
 * started it; nothing otherwise). A 4xx is the caller's mistake and is never
 * reported.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { reportError } from '@classmoji/utils/error-report';

/** The status an escaped error is answered with: its own 4xx, else 500. */
const answeredStatus = (error: FastifyError): number =>
  error.statusCode && error.statusCode < 500 ? error.statusCode : 500;

/**
 * Report an escaped error that is answered 5xx; never a 4xx. Also called by a
 * route's own error handler before it hands an error on (routes/mcp.ts); one
 * error object is reported once, whichever sees it first.
 */
export function reportServerError(error: FastifyError): void {
  const status = answeredStatus(error);
  if (status >= 500) reportError(error, { surface: 'mcp.http', tags: { status }, handled: false });
}

export function mcpErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const statusCode = answeredStatus(error);
  if (statusCode >= 500) {
    request.log.error(error, '[mcp] unhandled error');
    reportServerError(error);
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  }
  return reply
    .status(statusCode)
    .send({ error: error.code ?? 'bad_request', message: error.message });
}
