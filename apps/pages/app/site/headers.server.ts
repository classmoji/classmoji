import { COOKIE_PREFIX } from '@classmoji/auth/secret';

import { frameAncestorOrigins } from './env.server.ts';

/**
 * The ONE place class-site response headers are built.
 *
 * React Router's `headers` export does not inherit: a child route that exports
 * `headers` REPLACES whatever the parent produced. So a leaf route that only
 * wanted to say "don't cache this" would silently drop the entire CSP. Every
 * site route therefore builds its headers here, and the layout's export merges
 * `parentHeaders`/`errorHeaders` on top rather than assuming it ran at all.
 *
 * The caching rule is deliberately coarse:
 *  - a request carrying a session cookie is `private, no-store` — the response
 *    is viewer-specific (member-only pages, the user chip, staff edit pills)
 *    and must never reach a shared cache;
 *  - an anonymous request for a public page gets a 60s shared cache with
 *    `Vary: Cookie`, so a signed-in member is never served the anonymous copy;
 *  - everything else (redirects, 403/404/503, disabled sites) is `no-store`.
 *
 * `stale-while-revalidate` is deliberately absent: a page flipped from public
 * to members-only must stop being served promptly, and SWR would keep handing
 * out the public copy while it revalidated.
 */

/**
 * SHA-256 of the flash-free dark-mode script inlined by `SiteDocument` in
 * `app/root.tsx` — the ONLY script a class-site document contains.
 *
 * Hardcoded because root.tsx does not export the string (and is owned by
 * another workstream). `tests/unit/site-headers.spec.ts` re-derives this hash
 * from root.tsx's source and fails on drift, so editing that script without
 * updating this constant breaks a test rather than the site's CSP.
 */
export const DARK_MODE_SCRIPT_HASH = "'sha256-zE9lMCBH7j47LO0x2JTz3HAviU8juJhY/nTgMO3guIQ='";

/**
 * Match the session cookie better-auth sets for a given `cookiePrefix`.
 *
 * Built from the prefix rather than hardcoded, because it is configurable:
 * staging runs `COOKIE_PREFIX=classmoji-staging` so its sessions do not shadow
 * production's on a shared parent domain. A hardcoded `classmoji.` here would
 * mean a real staging session looks ANONYMOUS to `siteHeaders`, and a
 * signed-in member's members-only page would go out `public, max-age=60` — a
 * cache poisoning of personalized content, invisible until someone else is
 * served it.
 *
 * Escaping matches `packages/auth/src/server.ts` exactly: both `.` and `-` are
 * regex-active and both occur in real prefixes.
 *
 * Exported so drift is testable — `COOKIE_PREFIX` resolves at import time, so
 * a test cannot get at other prefixes any other way.
 */
export function sessionCookieRegexFor(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?:^|;\\s*)(?:__Secure-)?${escaped}\\.session_token=`);
}

/** Session cookie name(s) better-auth sets, for THIS deployment's prefix. */
const SESSION_COOKIE = sessionCookieRegexFor(COOKIE_PREFIX);

/** Does this request carry a Classmoji session? */
export function hasSessionCookie(request: Request): boolean {
  return SESSION_COOKIE.test(request.headers.get('cookie') || '');
}

/**
 * Content-Security-Policy for every class-site response.
 *
 * `script-src` allows exactly one hash and nothing else — class sites ship no
 * bundle, no hydration and no third-party tags, so anything that executes on
 * one is by definition something we did not put there. `style-src` needs
 * `'unsafe-inline'` because BlockNote's serializer emits inline `style`
 * attributes (image widths, column ratios) and Google Fonts' stylesheet is
 * loaded from `fonts.googleapis.com` by the shared document head.
 */
function contentSecurityPolicy(): string {
  const frameAncestors = frameAncestorOrigins();
  return [
    "default-src 'none'",
    `script-src ${DARK_MODE_SCRIPT_HASH}`,
    // Author content routinely embeds images from anywhere; `https:` + `data:`
    // is the narrowest policy that does not break existing pages.
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "media-src 'self' https:",
    'frame-src https:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'"}`,
  ].join('; ');
}

export type SiteHeaderOptions = {
  request: Request;
  /** May a shared cache hold this for 60s? Only ever true for public content. */
  cacheable?: boolean;
  /** Add `X-Robots-Tag: noindex` (errors, private sites, member-only paths). */
  noindex?: boolean;
  /** Override the content type (resource routes: robots.txt). */
  contentType?: string;
};

/**
 * Build the full header set for a class-site response.
 *
 * Returns a `Headers` so callers can hand it straight to `new Response(...)`
 * or spread it into a `headers` export.
 */
export function siteHeaders({
  request,
  cacheable = false,
  noindex = false,
  contentType,
}: SiteHeaderOptions): Headers {
  const headers = new Headers();

  // A session cookie makes the response viewer-specific — never cacheable,
  // whatever the caller asked for.
  const isPrivate = hasSessionCookie(request);
  if (cacheable && !isPrivate) {
    headers.set('Cache-Control', 'public, max-age=60');
    headers.set('Vary', 'Cookie');
  } else if (isPrivate) {
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Vary', 'Cookie');
  } else {
    headers.set('Cache-Control', 'no-store');
  }

  headers.set('Content-Security-Policy', contentSecurityPolicy());
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (noindex) headers.set('X-Robots-Tag', 'noindex');
  if (contentType) headers.set('Content-Type', contentType);

  return headers;
}

/** Headers to use when there is no request to inspect (error paths). */
function fallbackSiteHeaders(): Headers {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', contentSecurityPolicy());
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('X-Robots-Tag', 'noindex');
  return headers;
}

/** Header names whose value must come from the winning source verbatim. */
const DECISION_HEADERS = ['Cache-Control', 'Vary', 'X-Robots-Tag', 'Content-Type'];

export type RouteHeaderArgs = {
  loaderHeaders?: Headers;
  errorHeaders?: Headers;
  parentHeaders?: Headers;
};

/**
 * THE body of every site route's `headers` export.
 *
 * Loaders build their real header set with `siteHeaders` (they have the
 * request, so they can see the session cookie) and return it alongside their
 * data; this picks the freshest of those and guarantees the security baseline
 * is present even when the winning source is an error response nobody
 * decorated. That "even when" is the whole point: React Router drops parent
 * headers on a child `headers` export, so a route that got this wrong would
 * serve a class site with no CSP at all — and nothing would look broken.
 */
export function routeSiteHeaders({
  loaderHeaders,
  errorHeaders,
  parentHeaders,
}: RouteHeaderArgs): Headers {
  const merged = fallbackSiteHeaders();

  // Least → most specific, so the nearest decision wins.
  for (const source of [parentHeaders, loaderHeaders, errorHeaders]) {
    if (!source) continue;
    for (const name of DECISION_HEADERS) {
      const value = source.get(name);
      if (value) merged.set(name, value);
    }
    // An error response that never went through `siteHeaders` has no
    // X-Robots-Tag of its own; the fallback already says noindex, and a
    // successful public page's loaderHeaders simply omits the header — so
    // clear it when the winning source deliberately said nothing.
    if (source === loaderHeaders && !source.get('X-Robots-Tag') && !errorHeaders) {
      merged.delete('X-Robots-Tag');
    }
  }

  return merged;
}
