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
import type { HandleErrorFunction } from 'react-router';
import { reportRouteError } from '@classmoji/utils/sentry-server';

export { default, streamTimeout } from '@classmoji/workers/entry-server';

/**
 * React Router's mode is the build's: workers/app.ts creates its handler with
 * `import.meta.env.MODE`, and on Fly `@react-router/express` reads `NODE_ENV`,
 * which is the same mode the Fly image was built in (production, or
 * development under the dev server).
 */
export const handleError: HandleErrorFunction = (error, { request }) =>
  reportRouteError(error, request, { mode: import.meta.env.MODE });
