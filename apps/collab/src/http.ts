import type { onRequestPayload } from '@hocuspocus/server';
import { COLLAB_INTERNAL_PREFIX } from '@classmoji/collab';

import { handleInternal } from './internal.ts';
import type { CollabRuntime } from './server.ts';

/**
 * Plain HTTP on the collab port. Hocuspocus runs `onRequest` for every
 * non-upgrade request and answers "Welcome to Hocuspocus!" unless a hook
 * rejects; rejecting with no error (`throw null`) means "handled, stop".
 *
 * `GET /health`, `GET /health/db` (public) and `/internal/*` (shared secret,
 * see internal.ts).
 */
export async function handleRequest(
  payload: Pick<onRequestPayload, 'request' | 'response'>,
  runtime: CollabRuntime
): Promise<void> {
  try {
    await routeRequest(payload, runtime);
  } catch (error) {
    // `throw null` is the "handled" signal for Hocuspocus; pass it through.
    if (error === null) throw null;
    // Anything else must never escape: an unhandled rejection here would end
    // the only collab process and every open room with it.
    console.error('[collab] request failed:', error);
    const { response } = payload;
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('internal error');
    } else if (!response.writableEnded) {
      response.end();
    }
    throw null;
  }
}

/**
 * The request path and query, read without `new URL(raw, base)`: a raw target
 * such as `//%2e%2e%2f.env` is taken as a host there and throws.
 */
export function parseRequestTarget(raw: string | undefined): {
  pathname: string;
  searchParams: URLSearchParams;
} {
  const target = raw && raw.startsWith('/') ? raw : '/';
  const queryAt = target.indexOf('?');
  const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
  const search = queryAt === -1 ? '' : target.slice(queryAt + 1);
  return { pathname, searchParams: new URLSearchParams(search) };
}

async function routeRequest(
  { request, response }: Pick<onRequestPayload, 'request' | 'response'>,
  runtime: CollabRuntime
): Promise<void> {
  const url = parseRequestTarget(request.url);

  // `/health` (Fly's check): always 200 while the process serves — a DB blip
  // must not unroute the only instance and drop every open editor — with the
  // database's state in the body. `/health/db` (uptime monitors): 503 when
  // the database does not answer.
  if (url.pathname === '/health' || url.pathname === '/health/db') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      throw null;
    }
    const db = await runtime.dbHealth();
    const strict = url.pathname === '/health/db';
    const status = strict && db === 'down' ? 503 : 200;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(
      request.method === 'HEAD'
        ? undefined
        : JSON.stringify({ status: db === 'down' ? 'degraded' : 'ok', db })
    );
    throw null;
  }

  if (
    url.pathname === COLLAB_INTERNAL_PREFIX ||
    url.pathname.startsWith(`${COLLAB_INTERNAL_PREFIX}/`)
  ) {
    await handleInternal(request, response, url, runtime);
    throw null;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not-found' }));
  throw null;
}
