import type { onRequestPayload } from '@hocuspocus/server';
import { COLLAB_INTERNAL_PREFIX } from '@classmoji/collab';

import { handleInternal } from './internal.ts';
import type { CollabRuntime } from './server.ts';

/**
 * Plain HTTP on the collab port. Hocuspocus runs `onRequest` for every
 * non-upgrade request and answers "Welcome to Hocuspocus!" unless a hook
 * rejects; rejecting with no error (`throw null`) means "handled, stop".
 *
 * `GET /health` (public) and `/internal/*` (shared secret, see internal.ts).
 */
export async function handleRequest(
  { request, response }: Pick<onRequestPayload, 'request' | 'response'>,
  runtime: CollabRuntime
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://collab.local');

  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    }
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
