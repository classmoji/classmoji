/**
 * The one signing secret, resolved once at import time.
 *
 * Extracted from `./server.ts` so that modules which only need to sign or verify
 * something (see `./siteReturnToken.ts`) can share the exact same value without
 * importing betterAuth, Prisma and the whole service layer along with it.
 *
 * `./server.ts` re-exports `AUTH_SECRET`, so the existing
 * `import { AUTH_SECRET } from '@classmoji/auth/server'` keeps working.
 */

// Use explicit secret for consistent session signing
// Export so test-login can use the same signing mechanism
const DEV_SECRET = 'dev-secret-change-in-production-32chars!';

if (process.env.NODE_ENV === 'production' && !process.env.BETTER_AUTH_SECRET) {
  throw new Error(
    '[SECURITY] BETTER_AUTH_SECRET environment variable is required in production. ' +
      'This secret is used to sign session tokens. Running without it would allow session forgery.'
  );
}

export const AUTH_SECRET = process.env.BETTER_AUTH_SECRET || DEV_SECRET;

/**
 * Cookie name prefix for every BetterAuth cookie (`{prefix}.session_token`, …).
 *
 * Env-driven so staging can run `COOKIE_PREFIX=classmoji-staging` and stop its
 * sessions from shadowing production's cookies on a shared parent domain.
 * Unset ⇒ `classmoji`, i.e. exactly what shipped before this was configurable.
 *
 * Anything that parses a cookie header by name MUST build the name from this
 * constant rather than hardcoding `classmoji.` — see `getAuthSession`.
 */
export const COOKIE_PREFIX = process.env.COOKIE_PREFIX || 'classmoji';
