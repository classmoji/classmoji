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
 * constant rather than hardcoding `classmoji.` — use `sessionCookieRegexFor`
 * or `sessionTokenFromCookieHeader` below rather than rolling another one.
 */
export const COOKIE_PREFIX = process.env.COOKIE_PREFIX || 'classmoji';

/**
 * Match the session cookie better-auth sets for a given `cookiePrefix`, and
 * capture its value.
 *
 * THE one place the cookie name becomes a pattern. It lives in this
 * dependency-free module so every consumer can reach it without dragging
 * betterAuth and Prisma along: `./server.ts`'s dev-login fallback,
 * `apps/pages`' cache-privacy check, and `apps/slides`' socket handshake each
 * carried their own copy of this expression — three chances to hardcode
 * `classmoji.`, and one `COOKIE_PREFIX=classmoji-staging` deploy away from
 * three different answers to "is this request signed in?".
 *
 * The prefix is escaped because it comes from the environment and both `.` and
 * `-` are regex-active: an unescaped `classmoji-staging` would happily match
 * `classmojiXstaging`.
 *
 * `__Secure-` is optional because better-auth prepends it whenever it sets
 * secure cookies — i.e. in every deployed environment, but not in local dev.
 *
 * The value group is `[^;]*`, not `[^;]+`, on purpose: a present-but-empty
 * cookie still means a session cookie was sent, so presence checks keep seeing
 * it, while callers extracting a token get `''` and fall through their own
 * truthiness guard exactly as a non-match would.
 */
export function sessionCookieRegexFor(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?:^|;\\s*)(?:__Secure-)?${escaped}\\.session_token=([^;]*)`);
}

/** The session-cookie matcher for THIS deployment's configured prefix. */
const SESSION_COOKIE = sessionCookieRegexFor(COOKIE_PREFIX);

/**
 * The session token carried by a raw `Cookie` header, or null.
 *
 * Takes the header string rather than a `Request` because the socket.io
 * handshake in `apps/slides/server.ts` only ever has the string.
 */
export function sessionTokenFromCookieHeader(cookieHeader: string): string | null {
  return cookieHeader.match(SESSION_COOKIE)?.[1] || null;
}

/**
 * The domain the session cookie spans, or null for a host-only cookie.
 *
 * Resolution order:
 *   1. `COOKIE_DOMAIN` — explicit override. Kept as an escape hatch for two
 *      real cases: local devs who set SITE_BASE_DOMAIN but want to keep
 *      logging in at localhost (a cookie can't be set for a domain the request
 *      host isn't under), and a future where tenant sites move to a separate
 *      TLD from the auth domain (the github.com / github.io pattern).
 *   2. `.{SITE_BASE_DOMAIN}` — the normal case. The cookie's entire job is to
 *      span the webapp and the class-site subdomains, and those live under
 *      SITE_BASE_DOMAIN by definition, so the two values are in lockstep in
 *      every real environment (classmoji.io / staging.classmoji.io / lvh.me).
 *      Deriving removes the set-one-forget-the-other failure mode, which
 *      presents as members silently appearing anonymous on sites.
 *   3. Production fallback `.classmoji.io` — exactly what shipped before any
 *      of this was configurable, for a prod deploy with neither var set.
 *   4. null — development default: host-only cookies, localhost keeps working.
 */
/** Same shape the other SITE_BASE_DOMAIN consumers enforce (see
 * apps/pages/server.ts boot assert and siteReturn.ts's BARE_DOMAIN): a bare
 * lowercase registrable domain — at least two labels, no scheme/port/path. */
const BARE_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize one candidate into a `.domain` cookie attribute, or null.
 *
 * Fails CLOSED on malformed values (loudly — a bad domain attribute makes
 * browsers drop every Set-Cookie, which presents as a silent sign-in loop
 * with green health checks). Falling through to the next candidate in the
 * chain is the recovery, never a mangled attribute.
 */
function asCookieDomain(raw: string | undefined, source: string): string | null {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^\.+/, '');
  if (!BARE_DOMAIN.test(bare)) {
    console.error(
      `[auth] ${source}=${JSON.stringify(raw)} is not a bare domain; ` +
        'ignoring it for the session-cookie domain.'
    );
    return null;
  }
  return `.${bare}`;
}

export function resolveCookieDomain(env: Record<string, string | undefined>): string | null {
  return (
    asCookieDomain(env.COOKIE_DOMAIN, 'COOKIE_DOMAIN') ??
    asCookieDomain(env.SITE_BASE_DOMAIN, 'SITE_BASE_DOMAIN') ??
    (env.NODE_ENV === 'production' ? '.classmoji.io' : null)
  );
}

export const COOKIE_DOMAIN: string | null = resolveCookieDomain(process.env);
