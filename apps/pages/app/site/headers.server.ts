import { COOKIE_PREFIX, sessionCookieRegexFor } from '@classmoji/auth/secret';

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
 * `app/root.tsx` — the one inline script a class-site document contains
 * (a reader document also loads the island's module from `/assets/`).
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
 * The builder now lives in `@classmoji/auth/secret` — the same dependency-free
 * module this already imports `COOKIE_PREFIX` from — so that slides' socket
 * handshake and auth's own dev-login fallback share ONE escape rule with this.
 * Three private copies meant three chances to hardcode `classmoji.`, and a
 * hardcoded prefix here is the nastiest of the three: a real staging session
 * looks ANONYMOUS to `siteHeaders`, so a signed-in member's members-only page
 * goes out `public, max-age=60` — personalized content poisoned into a shared
 * cache, invisible until someone else is served it.
 *
 * Re-exported rather than merely used, because `COOKIE_PREFIX` resolves at
 * import time: `tests/unit/site-headers.spec.ts` cannot reach other prefixes
 * any other way.
 */
export { sessionCookieRegexFor };

/** Session cookie name(s) better-auth sets, for THIS deployment's prefix. */
const SESSION_COOKIE = sessionCookieRegexFor(COOKIE_PREFIX);

/** Does this request carry a Classmoji session? */
export function hasSessionCookie(request: Request): boolean {
  return SESSION_COOKIE.test(request.headers.get('cookie') || '');
}

/**
 * What a document that mounts the reader island needs from the policy
 * (`page.tsx`, `home.tsx`). Absent for every other site response.
 */
export type SiteReaderPolicy = {
  /**
   * The document's own origin in a build: `script-src` admits exactly its
   * `/assets/` path (the island's entry, its chunks and the lazily loaded
   * Shiki grammars, all hashed module scripts; `modulepreload` is governed by
   * `script-src` too). Null in dev, where Vite serves modules from other paths
   * and `'self'` is kept.
   */
  assetsOrigin: string | null;
  /**
   * Whether the reader may call this origin's API (`connect-src 'self'`): a
   * member's ticks, unlocks, comments and the payload after an unlock, all
   * passed through on the class SUBDOMAIN only (`server/siteHost.ts`). False on
   * a custom domain, where no session exists and nothing may be called.
   */
  connect: boolean;
};

/**
 * Content-Security-Policy for every class-site response.
 *
 * `script-src`: the dark-mode script's hash, and — only on a document that
 * mounts the reader island — this origin's `/assets/` path (`'self'` in dev).
 * Nothing else executes on a class site: no inline script but the dark-mode
 * one, no third-party tags. (The old static render's inline copy script is
 * gone: the reader handles Copy itself.)
 *
 * `connect-src 'none'` everywhere except a reader document on the class
 * subdomain (`'self'`), where a member's reader calls the passed-through API.
 * `style-src` needs `'unsafe-inline'` because BlockNote and Mantine set inline
 * styles (image widths, column ratios, Shiki's colour variables) and inject
 * <style>, and Google Fonts' stylesheet is loaded by the shared document head.
 */
export function contentSecurityPolicy(reader?: SiteReaderPolicy | null): string {
  const frameAncestors = frameAncestorOrigins();
  const scripts = reader
    ? `${reader.assetsOrigin ? `${reader.assetsOrigin.replace(/\/+$/, '')}/assets/` : "'self'"} ${DARK_MODE_SCRIPT_HASH}`
    : DARK_MODE_SCRIPT_HASH;
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    // Author content routinely embeds images from anywhere; `https:` + `data:`
    // is the narrowest policy that does not break existing pages.
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "media-src 'self' https:",
    'frame-src https:',
    `connect-src ${reader?.connect ? "'self'" : "'none'"}`,
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
  /** This document mounts the reader island (`SiteReaderPolicy`). */
  reader?: SiteReaderPolicy | null;
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
  reader = null,
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

  headers.set('Content-Security-Policy', contentSecurityPolicy(reader));
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

/**
 * Header names whose value must come from the winning source verbatim. The
 * CSP is one of them: a reader document's policy (scripts from `/assets/`,
 * `connect-src 'self'` on the subdomain) is decided by its loader, and an
 * error response's narrower one by `siteHeaders` where it was thrown. A source
 * that carries none leaves the fallback's narrow policy in place.
 */
const DECISION_HEADERS = [
  'Cache-Control',
  'Vary',
  'X-Robots-Tag',
  'Content-Type',
  'Content-Security-Policy',
];

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
