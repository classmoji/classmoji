/**
 * Server entry for Cloudflare Workers (the `workerd` export condition of
 * `@classmoji/workers/entry-server`): React Router's Node default
 * (./entry-server.node.tsx) on web streams, since workerd has no
 * `renderToPipeableStream`. Same behaviour otherwise:
 * - HEAD answers with the status and headers and no body;
 * - bots and SPA mode wait for all content (`allReady`), everyone else gets
 *   the shell as soon as it is ready;
 * - rendering is aborted `streamTimeout` + 1 s in, so rejected boundaries
 *   still flush;
 * - an error after the shell sets 500 and is logged; a shell error rejects
 *   (React Router turns it into its error response).
 */
import type { AppLoadContext, EntryContext } from 'react-router';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let shellRendered = false;
  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Shell errors reject renderToReadableStream and are logged by
        // React Router's handleDocumentRequest; log only the later ones.
        if (shellRendered) {
          console.error(error);
        }
      },
    }
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
