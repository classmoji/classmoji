/**
 * Host detection for class websites.
 *
 * Class sites are served by THIS app at `{subdomain}.{SITE_BASE_DOMAIN}`
 * (prod: classmoji.io, dev: lvh.me). A site request is classified from the raw
 * Host header and internally rewritten onto the `/_site/{subdomain}/...` route
 * subtree; the canonical pages host keeps serving the editor as before.
 *
 * Design notes (these are load-bearing, don't "simplify" them away):
 *  - Everything interesting is a PURE function (`classifyHost`,
 *    `resolveSiteRequest`) so it is unit-testable without a server. The Express
 *    middlewares are thin wrappers.
 *  - `@react-router/express` builds the request URL from `req.originalUrl` and
 *    honours the spoofable `X-Forwarded-Host` header. So the rewrite must set
 *    BOTH `req.url` and `req.originalUrl`, and the sanitizer must strip
 *    `X-Forwarded-Host` before anything downstream reads it.
 *  - The rewrite is a raw string-prefix operation. Never round-trip through
 *    `new URL()`: percent-encoding must survive byte-for-byte.
 *  - This file is loaded by `server.ts` under `node --experimental-strip-types`
 *    in BOTH dev and prod, so: type-only imports, no enums/namespaces, and no
 *    runtime dependencies.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type HostClassification =
  | { kind: 'canonical' }
  | { kind: 'site'; subdomain: string }
  | { kind: 'unknown' }
  | { kind: 'invalid' };

export type SiteHostConfig = {
  /** Bare base domain for class sites, or null when the feature is inert. */
  siteBaseDomain: string | null;
  /** Hosts that serve the normal pages app (editor, API, health). */
  canonicalHosts: string[];
};

export type SiteRequestResolution =
  | { action: 'pass' }
  | {
      action: 'not-found';
      reason: 'unknown-host' | 'invalid-host' | 'internal-path' | 'data-request';
    }
  | { action: 'rewrite'; url: string; subdomain: string };

/** The slice of the environment this module reads (structurally `process.env`). */
export type SiteHostEnv = {
  SITE_BASE_DOMAIN?: string | undefined;
  PAGES_URL?: string | undefined;
  [key: string]: string | undefined;
};

/** Internal route namespace the rewriter targets. Never reachable from outside. */
export const SITE_ROUTE_PREFIX = '/_site';

/**
 * One RFC 1123 DNS label: a-z0-9 with interior hyphens, 1-63 chars.
 *
 * Intentionally duplicated from `SUBDOMAIN_REGEX` in @classmoji/utils rather
 * than imported: this module is loaded by bare node (type-stripping, no
 * bundler, no workspace resolution) on the request hot path, and it is the
 * READ-side shape check. Claim-time policy — reserved labels, uniqueness —
 * lives with that helper and the DB CHECK constraint. Keep the three in sync.
 */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A bare lowercase domain: two or more DNS labels, no scheme/port/path. */
const BARE_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Printable ASCII only — rejects whitespace, control bytes and non-ASCII. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * Loopback hosts always serve the canonical app (dev + Fly health checks).
 * IPv6 literals never reach here — `parseHostHeader` rejects bracketed/
 * multi-colon hosts outright.
 */
const ALWAYS_CANONICAL = ['localhost', '127.0.0.1'];

/**
 * Strictly parse a Host header into a normalized hostname.
 *
 * Returns null for anything malformed — callers treat that as `invalid`.
 * Strips exactly one `:port` suffix and one trailing dot (in that order, so
 * `cs52.lvh.me.:7140` normalizes to `cs52.lvh.me`).
 */
export function parseHostHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 255) return null;
  if (!PRINTABLE_ASCII.test(raw)) return null;
  if (raw.includes(',') || raw.includes('@')) return null;

  const lower = raw.toLowerCase();

  // Exactly zero or one colon; anything else (header injection, IPv6 literals)
  // is rejected rather than guessed at.
  const colonCount = lower.split(':').length - 1;
  if (colonCount > 1) return null;

  let host = lower;
  if (colonCount === 1) {
    const colonAt = lower.indexOf(':');
    const port = lower.slice(colonAt + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = lower.slice(0, colonAt);
  }

  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return null;
  if (!/^[a-z0-9._-]+$/.test(host)) return null;
  if (host.split('.').some(label => label.length === 0 || label.length > 63)) return null;

  return host;
}

/**
 * Classify a Host header against the canonical hosts and the site base domain.
 *
 * Canonical wins over site: in prod `PAGES_URL=https://pages.classmoji.io` with
 * `SITE_BASE_DOMAIN=classmoji.io` also matches the site pattern, and the editor
 * host must never be treated as a class site named "pages".
 */
export function classifyHost(hostHeader: unknown, config: SiteHostConfig): HostClassification {
  const host = parseHostHeader(hostHeader);
  if (host === null) return { kind: 'invalid' };

  if (ALWAYS_CANONICAL.includes(host)) return { kind: 'canonical' };
  if (config.canonicalHosts.includes(host)) return { kind: 'canonical' };

  const base = config.siteBaseDomain;
  if (base && host.length > base.length + 1 && host.endsWith(`.${base}`)) {
    const label = host.slice(0, host.length - base.length - 1);
    // Exactly ONE label: `a.b.lvh.me` is unknown, not a site.
    if (DNS_LABEL.test(label)) return { kind: 'site', subdomain: label };
  }

  return { kind: 'unknown' };
}

/**
 * Build the internal URL for a site request.
 *
 * Pure string surgery on the raw request URL: the path is prefixed and the
 * query string is carried over verbatim, so percent-encoding is preserved
 * byte-for-byte (`/page%2Fname?q=a%20b` must not become `/page/name?q=a b`).
 */
export function computeSiteUrl(rawUrl: string, subdomain: string): string {
  const queryAt = rawUrl.indexOf('?');
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  const prefix = `${SITE_ROUTE_PREFIX}/${subdomain}`;
  const rewrittenPath = path === '/' || path === '' ? prefix : `${prefix}${path}`;
  return `${rewrittenPath}${query}`;
}

/** Path prefixes that bypass host handling entirely (health checks, ACME). */
function isAlwaysAllowed(path: string): boolean {
  return path === '/health' || path === '/.well-known' || path.startsWith('/.well-known/');
}

function isInternalPath(path: string): boolean {
  return path === SITE_ROUTE_PREFIX || path.startsWith(`${SITE_ROUTE_PREFIX}/`);
}

/**
 * The whole rewriter decision, as a pure function of (url, host, config).
 *
 * When `siteBaseDomain` is null the feature is inert and every request passes
 * through untouched — that is the prod-safety default.
 */
export function resolveSiteRequest(
  rawUrl: string,
  hostHeader: unknown,
  config: SiteHostConfig
): SiteRequestResolution {
  if (!config.siteBaseDomain) return { action: 'pass' };

  const queryAt = rawUrl.indexOf('?');
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);

  if (isAlwaysAllowed(path)) return { action: 'pass' };

  const classification = classifyHost(hostHeader, config);

  switch (classification.kind) {
    case 'canonical':
      // The internal namespace is reachable only via an internal rewrite.
      if (isInternalPath(path)) return { action: 'not-found', reason: 'internal-path' };
      return { action: 'pass' };

    case 'site':
      // Script-less site pages never issue React Router single-fetch requests;
      // refusing them removes a loader-serialization surface.
      if (path.endsWith('.data')) return { action: 'not-found', reason: 'data-request' };
      return {
        action: 'rewrite',
        url: computeSiteUrl(rawUrl, classification.subdomain),
        subdomain: classification.subdomain,
      };

    case 'invalid':
      return { action: 'not-found', reason: 'invalid-host' };

    default:
      // Never redirect an arbitrary Host — that is an open-redirect gadget.
      return { action: 'not-found', reason: 'unknown-host' };
  }
}

/**
 * Read the site config out of the environment.
 *
 * Throws when SITE_BASE_DOMAIN is set but malformed. The factory calls this at
 * startup, so a bad value fails the boot rather than every request.
 */
export function resolveSiteHostConfig(env: SiteHostEnv): SiteHostConfig {
  const canonicalHosts: string[] = [];

  const pagesUrl = (env.PAGES_URL ?? '').trim();
  if (pagesUrl) {
    try {
      const hostname = new URL(pagesUrl).hostname.toLowerCase();
      if (hostname) canonicalHosts.push(hostname);
    } catch {
      // A malformed PAGES_URL is not fatal here: loopback hosts still classify
      // as canonical, and the app has bigger problems if this is wrong.
    }
  }

  const raw = (env.SITE_BASE_DOMAIN ?? '').trim();
  if (!raw) return { siteBaseDomain: null, canonicalHosts };

  if (raw !== raw.toLowerCase() || !BARE_DOMAIN.test(raw)) {
    throw new Error(
      `SITE_BASE_DOMAIN must be a bare lowercase domain (e.g. "classmoji.io" or "lvh.me"), got: ${JSON.stringify(raw)}`
    );
  }

  return { siteBaseDomain: raw, canonicalHosts };
}

function sendNotFound(res: Response): void {
  res.status(404);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send('Not found\n');
}

export type SiteHostMiddleware = {
  /**
   * Mount FIRST, before vite/static/anything else: `X-Forwarded-Host` is
   * attacker-controlled and `@react-router/express` reads it.
   */
  sanitizeForwardedHost: RequestHandler;
  /**
   * Mount AFTER static/vite handlers (site hosts still need `/assets/*`) and
   * BEFORE the React Router handler.
   */
  rewriteSiteRequests: RequestHandler;
  config: SiteHostConfig;
};

/**
 * Build the two host middlewares. Throws at boot on a malformed
 * SITE_BASE_DOMAIN; a missing one leaves the rewriter a no-op.
 */
export function createSiteHostMiddleware(env: SiteHostEnv = process.env): SiteHostMiddleware {
  const config = resolveSiteHostConfig(env);

  const sanitizeForwardedHost: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction
  ) => {
    delete req.headers['x-forwarded-host'];
    next();
  };

  const rewriteSiteRequests: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    // Classify from the RAW Host header, never `req.hostname` (which consults
    // the forwarded headers once `trust proxy` is on).
    const resolution = resolveSiteRequest(req.url || '/', req.headers.host, config);

    if (resolution.action === 'not-found') {
      sendNotFound(res);
      return;
    }

    if (resolution.action === 'rewrite') {
      // Both, and in this order: the adapter reads `originalUrl`, Express
      // routing reads `url`.
      req.url = resolution.url;
      req.originalUrl = resolution.url;
    }

    next();
  };

  return { sanitizeForwardedHost, rewriteSiteRequests, config };
}
