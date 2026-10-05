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
  { request, response }: Pick<onRequestPayload, 'request' | 'response'>,
  runtime: CollabRuntime
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://collab.local');

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
