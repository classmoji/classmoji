import type { onRequestPayload } from '@hocuspocus/server';

/**
 * Plain HTTP on the collab port. Hocuspocus runs `onRequest` for every
 * non-upgrade request and answers "Welcome to Hocuspocus!" unless a hook
 * rejects; rejecting with no error (`throw null`) means "handled, stop".
 *
 * Today: `GET /health` (public). Slice A adds `/internal/*`.
 */
export async function handleRequest({ request, response }: onRequestPayload): Promise<void> {
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

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not-found' }));
  throw null;
}
