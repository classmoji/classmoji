/**
 * The webapp's server entry: React Router 8.5.1's default Node entry
 * (`@react-router/dev/dist/config/defaults/entry.server.node.tsx`), which the
 * webapp ran with no entry of its own before, plus server error reporting:
 *
 * - `./utils/sentry.server` comes first, so Sentry starts when the build loads
 *   (off without `SENTRY_DSN`);
 * - `handleError` logs exactly as React Router's default did, then reports
 *   the error when it is a real failure (not an abort, not a 4xx);
 * - a streaming render error after the shell is logged as before and reported.
 *
 * Everything else is the default, unchanged: when React Router's default
 * changes, copy the change here.
 */
import { serverSentryEnabled, captureServerException } from './utils/sentry.server';
import { PassThrough } from 'node:stream';

import type { EntryContext, HandleErrorFunction, RouterContextProvider } from 'react-router';
import { createReadableStreamFromReadable } from '@react-router/node';
import { ServerRouter, isRouteErrorResponse } from 'react-router';
import { isbot } from 'isbot';
import type { RenderToPipeableStreamOptions } from 'react-dom/server';
import { renderToPipeableStream } from 'react-dom/server';
import { shouldReportRouteError } from '@classmoji/utils/sentry-server';

export const streamTimeout = 5_000;

/**
 * React Router calls this for every error a loader, action or render throws.
 * The logging is the default's (react-router's server runtime): nothing in
 * test mode or for an aborted request, a route error response's inner error
 * when it has one. React Router's mode is `NODE_ENV` under react-router-serve.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (process.env.NODE_ENV !== 'test' && !request.signal.aborted) {
    // React Router's ErrorResponseImpl carries the error it wraps; the public
    // ErrorResponse type does not declare it.
    const inner = isRouteErrorResponse(error) ? (error as { error?: unknown }).error : undefined;
    console.error(inner ? inner : error);
  }
  if (serverSentryEnabled && shouldReportRouteError(error, request)) {
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
            // Reported here for the same reason: an error before the shell
            // reaches handleError above.
            if (serverSentryEnabled && shouldReportRouteError(error, request)) {
              captureServerException(error, { surface: 'react_router.render' });
            }
          }
        },
      }
    );
  });
}
