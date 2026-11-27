/**
 * The server entry: React Router's default on Node (Fly), web streams on
 * Cloudflare Workers (the `workerd` condition). See
 * packages/workers/src/entry-server.*.tsx.
 *
 * `handleError` replaces React Router's default one, so it first logs exactly
 * what the default logs, then reports real failures (not aborts, not 4xx) to
 * whatever reporter the runtime registered: Sentry from server/sentry.ts on
 * Node, from workers/app.ts on a Worker; nothing when Sentry is off. It uses
 * only the isomorphic reporter, so one entry serves both runtimes.
 */
import { isRouteErrorResponse, type HandleErrorFunction } from 'react-router';
import { reportError } from '@classmoji/utils/error-report';
import { shouldReportRouteError } from '@classmoji/utils/sentry-server';

export { default, streamTimeout } from '@classmoji/workers/entry-server';

export const handleError: HandleErrorFunction = (error, { request }) => {
  // React Router's default (server-runtime/server.js), minus its test-mode
  // check, which a production build never meets.
  if (!request.signal.aborted) {
    const inner = isRouteErrorResponse(error) ? (error as { error?: unknown }).error : undefined;
    console.error(inner ? inner : error);
  }
  if (shouldReportRouteError(error, request)) {
    reportError(error, { surface: 'react_router.handle_error', handled: false });
  }
};
