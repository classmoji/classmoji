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
 * Tie this request's errors to the signed-in user by internal id (null for
 * none). Call it inside a request only (a loader or action). Under View as
 * (`impersonating`) no id is set, neither the viewed person's nor the admin's:
 * the events carry `impersonating: 'true'` instead. No-op while Sentry is
 * off, and for a request that has no Sentry scope of its own: under the Vite
 * dev server Sentry starts in the middle of the first request, and
 * `setSentryUserId` leaves that one alone rather than set the user on the
 * scope every later request copies.
 */
export const setRequestUserId = (
  userId: string | null | undefined,
  options: { impersonating?: boolean } = {}
): void => {
  setSentryUserId(userId ?? null, options);
};

/**
 * `setRequestUserId` from what `getAuthSession` returned: its user id, and
 * View as when the better-auth session carries `impersonatedBy` (then no id
 * at all is set, see above).
 */
export const setRequestUser = (
  authData: { userId?: string | null; session?: unknown } | null | undefined
): void => {
  const session = authData?.session as { session?: { impersonatedBy?: unknown } } | null;
  setRequestUserId(authData?.userId, { impersonating: Boolean(session?.session?.impersonatedBy) });
};
