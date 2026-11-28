/**
 * Server-side error tracking, started before anything else in server.ts runs.
 *
 * Imported first by server.ts (ESM evaluates imports in order, so this runs
 * before Express, Socket.IO, React Router or the database client are loaded).
 * Reads `SENTRY_DSN` from the environment, which is already set when node
 * starts: Fly secrets in production, `dotenv -e .env` around
 * `turbo run slides:dev` locally. Without it Sentry stays off and this does
 * nothing.
 */
import { initServerSentry } from '@classmoji/utils/sentry-node';

export const sentryEnabled = initServerSentry('slides');
