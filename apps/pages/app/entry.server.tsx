/**
 * React Router's default Node server entry (`@react-router/dev`'s
 * `entry.server.node.tsx`), plus server-side error reports: `handleError`
 * (loader, action and render errors) and streaming render errors after the
 * shell. Both log exactly what the default did, then report; with Sentry off
 * (no `SENTRY_DSN`) the reports do nothing.
 *
 * The load context (`server/loadContext.ts`) passes through untouched, as in
 * the default: `handleRequest` never reads it.
 */

import { PassThrough } from 'node:stream';

import type { EntryContext, HandleErrorFunction, RouterContextProvider } from 'react-router';
import { createReadableStreamFromReadable } from '@react-router/node';
import { ServerRouter, isRouteErrorResponse } from 'react-router';
import { isbot } from 'isbot';
import type { RenderToPipeableStreamOptions } from 'react-dom/server';
import { renderToPipeableStream } from 'react-dom/server';
import { shouldReportRouteError } from '@classmoji/utils/sentry-server';
import { captureServerException } from '@classmoji/utils/sentry-node';

export const streamTimeout = 5_000;

/**
 * Replaces React Router's default `handleError`, which logs every error
 * (a route error response's inner Error when it has one) unless the request
 * was aborted or the server runs in test mode. That log is kept as it was;
 * real failures (not aborts, not thrown 4xx responses) are then reported.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (process.env.NODE_ENV !== 'test' && !request.signal.aborted) {
    const inner = isRouteErrorResponse(error) ? (error as { error?: unknown }).error : undefined;
    console.error(inner ? inner : error);
  }
  if (shouldReportRouteError(error, request)) {
    captureServerException(error, { surface: 'react_router.handle_error' });
  }
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get('user-agent');

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? 'onAllReady' : 'onShellReady';

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set('Content-Type', 'text/html');

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
            // Reported here only: a shell error reaches handleError instead.
            if (shouldReportRouteError(error, request)) {
              captureServerException(error, { surface: 'react_router.render' });
            }
          }
        },
      }
    );
  });
}
