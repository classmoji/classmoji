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
 * Like the Node entry, an error after the shell also goes to
 * `reportRenderError` (not for a client that went away or the timeout's
 * abort; a no-op unless the Worker registered a reporter). Such an error
 * comes after the response was returned, and so after `@sentry/cloudflare`'s
 * own end-of-request flush (the Workers classify no response as streaming):
 * its send is flushed under the request's `waitUntil`, or the runtime could
 * cancel it once the body ends.
 */

/** Keep a report made after the response alive until it is sent (at most 2 s). */
function flushLateReport(loadContext: RouterContextProvider | undefined): void {
  const flushing = flushErrorReports(2000);
  // The documented way (the request's ctx.waitUntil, found through the
  // request's async context)...
  waitUntil(flushing);
  // ...and the same ctx from the load context, in case React runs this
  // callback outside that async context. Handing it the same promise twice
  // is harmless.
  try {
    loadContext?.get(cloudflareContext)?.ctx.waitUntil(flushing);
  } catch {
    // No Worker context (a test, a Node build): nothing to keep alive.
  }
}
import type { EntryContext, RouterContextProvider } from 'react-router';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import { waitUntil } from '@classmoji/database';
import { flushErrorReports } from '@classmoji/utils/error-report';
import { reportRenderError } from '@classmoji/utils/sentry-server';
import { cloudflareContext } from './context.ts';

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider
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
  // Kept, so its own reason (what React hands onError when it fires) is
  // known: our timeout is not a failure, an upstream TimeoutError is.
  const timeout = AbortSignal.timeout(streamTimeout + 1000);

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: timeout,
      onError(error: unknown) {
        responseStatusCode = 500;
        // Shell errors reject renderToReadableStream and are logged by
        // React Router's handleDocumentRequest; log only the later ones.
        if (shellRendered) {
          console.error(error);
          const ourTimeout = timeout.aborted && error === timeout.reason;
          if (!ourTimeout && reportRenderError(error, request)) flushLateReport(loadContext);
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
