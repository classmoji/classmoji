/**
 * Server-side Sentry for admin on Fly (Node). Imported FIRST by server.ts, so
 * it runs before Express exists. Off (registers nothing) without `SENTRY_DSN`;
 * the env is already in `process.env` (Fly secrets in production, the root
 * scripts' dotenv locally). The Worker build starts its own in workers/app.ts.
 */
import { initServerSentry } from '@classmoji/utils/sentry-node';

export const sentryEnabled = initServerSentry('admin');
