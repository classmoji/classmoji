/**
 * Server error tracking (Sentry) for the webapp: errors only, off unless
 * `SENTRY_DSN` is set (see `@classmoji/utils/sentry-node`).
 *
 * entry.server.tsx imports this module first, so Sentry starts when the
 * server build is loaded: before the first request under react-router-serve
 * (it imports the build before it listens), and during the first request under
 * `react-router dev` (Vite loads the entry then). The env is in place by then
 * either way: Fly secrets in production, the root `.env` (loaded by the root
 * scripts: `scripts/dev.sh`, or `dotenv` in `web:dev`) in development.
 *
 * `serverSentryEnabled` is exported and read by the entry, not imported for
 * its side effect alone: the webapp's package.json says `"sideEffects": false`,
 * which lets the bundler drop a bare `import './sentry.server'`.
 *
 * `.server` keeps `@sentry/node` out of the client bundle.
 */
import { initServerSentry, setSentryUserId } from '@classmoji/utils/sentry-node';

export const serverSentryEnabled = initServerSentry('webapp');

export { captureServerException } from '@classmoji/utils/sentry-node';

/**
 * Whether a request's errors may carry its user id. Each request gets its own
 * Sentry scope only when Sentry started before that request arrived. Under
 * react-router-serve it always did. Under the Vite dev server it starts in the
 * middle of the first request, whose user would then be set on the scope every
 * later request copies, so dev servers never tie errors to users.
 */
const tieUserIds = serverSentryEnabled && !import.meta.env.DEV;

/**
 * Tie this request's errors to the signed-in user by internal id (null for
 * none). Call it inside a request only (a loader or action). No-op while
 * Sentry is off and under the dev server.
 */
export const setRequestUserId = (userId: string | null | undefined): void => {
  if (tieUserIds) setSentryUserId(userId ?? null);
};
