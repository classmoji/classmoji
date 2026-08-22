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
 *    `new URL()`: percent-encoding must survive byte-for-byte. Classification
 *    is the opposite — it runs on the `new URL()`-normalized path, because that
 *    is what the adapter routes on. Raw for the rewrite, normalized for the
 *    decision; mixing the two up is how `/x/../_site/cs52` got in.
 *  - This file is loaded by `server.ts` under `node --experimental-strip-types`
 *    in BOTH dev and prod, so: type-only imports, no enums/namespaces, and no
 *    runtime dependencies.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type HostClassification =
  | { kind: 'canonical' }
  | { kind: 'site'; subdomain: string; customDomain?: string }
  | { kind: 'unknown' }
  | { kind: 'invalid' };

/**
 * Resolve an instructor-owned hostname to the tenant subdomain it serves, or
 * null when nobody claims it.
 *
 * SYNCHRONOUS by contract. The whole point of the snapshot behind this is that
 * classification does zero I/O: `Host` need not match SNI, so anyone who can
 * complete a TLS handshake against one valid hostname may then send unlimited
 * distinct `Host:` headers down it. An async lookup here would turn that into
 * one unauthenticated database round trip per request, on a path that today
 * touches nothing.
 *
 * The answer is a ROUTING HINT and nothing more. It is allowed to be stale, and
 * the request-scoped tenant resolver re-reads the claim from the database
 * before serving a byte — see `resolveSiteContext`. Without that second read a
 * domain re-pointed from one classroom to another would keep serving the old
 * classroom's content for as long as any machine held the previous map.
 */
export type CustomHostResolver = (host: string) => string | null;

export type SiteHostConfig = {
  /** Bare base domain for class sites, or null when the feature is inert. */
  siteBaseDomain: string | null;
  /** Hosts that serve the normal pages app (editor, API, health). */
  canonicalHosts: string[];
  /**
   * Custom-domain lookup, INJECTED rather than imported.
   *
   * This module is loaded by bare node under `--experimental-strip-types` and
   * deliberately has no runtime dependencies (see the header). Reaching for
   * `@classmoji/services` here would drag its whole index — octokit, cheerio,
   * the git providers — into the boot path of the request hot path. The owner
   * of the snapshot builds it and hands the closure in; this file stays pure.
   *
   * Absent ⇒ custom domains are simply off, and every unclaimed host keeps its
   * existing behaviour.
   */
  resolveCustomHost?: CustomHostResolver;
};

export type SiteRequestResolution =
  | { action: 'pass' }
  | {
      action: 'not-found';
      reason: 'unknown-host' | 'invalid-host' | 'internal-path' | 'data-request' | 'dot-segment';
    }
  | { action: 'rewrite'; url: string; subdomain: string; customDomain?: string };

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

  // A hostname we do not own, that a PRO instructor pointed at us.
  //
  // Shape-checked BEFORE the lookup: `host` is attacker-controlled and the
  // resolver is a hash lookup we would rather not perform for a single label or
  // an IP literal. Checked again AFTER, on the answer: the map is loaded from a
  // database column, and a subdomain that is not a plain DNS label would be
  // spliced straight into a rewritten URL path by `computeSiteUrl`. Two cheap
  // regexes standing between a table read and the internal route namespace.
  const resolveCustomHost = config.resolveCustomHost;
  if (resolveCustomHost && BARE_DOMAIN.test(host)) {
    const subdomain = resolveCustomHost(host);
    if (typeof subdomain === 'string' && DNS_LABEL.test(subdomain)) {
      return { kind: 'site', subdomain, customDomain: host };
    }
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

/** ACME / RFC 8615 well-known paths. Allowed on non-site hosts only. */
function isWellKnownPath(path: string): boolean {
  return path === '/.well-known' || path.startsWith('/.well-known/');
}

function isInternalPath(path: string): boolean {
  return path === SITE_ROUTE_PREFIX || path.startsWith(`${SITE_ROUTE_PREFIX}/`);
}

/** Strip the query string off a raw request target. */
function pathOf(rawUrl: string): string {
  const queryAt = rawUrl.indexOf('?');
  return queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
}

/**
 * The path React Router will actually route on.
 *
 * `@react-router/express` rebuilds the request URL with `new URL(...)`, and the
 * WHATWG parser removes `.` / `..` segments — AFTER this middleware has made
 * its decision. So classification must run on the NORMALIZED path, or
 * `/x/../_site/cs52` sails past the `/_site` guard and lands in the internal
 * namespace anyway. (The rewrite itself still uses the raw string: see
 * `computeSiteUrl` — percent-encoding must survive byte-for-byte.)
 */
function decisionPathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://x').pathname;
  } catch {
    return pathOf(rawUrl);
  }
}

/**
 * Does this path contain a `.` or `..` segment, encoded or not?
 *
 * Normalizing and classifying would be enough for the routes we know about, but
 * a request that needs normalizing is a request trying to be two paths at once
 * — so it is refused outright rather than silently rewritten into whatever it
 * collapses to. That also keeps the always-allowed prefixes honest:
 * `/health/../_site/cs52` must not borrow `/health`'s bypass.
 *
 * Three details, each of which is a bypass on its own if you skip it:
 *
 *  - **`%2e`.** One level of decoding is exactly right. `new URL` does not
 *    decode `%25`, so `%252e` stays the literal text `%252e` downstream — a
 *    legitimate (if odd) slug, not a traversal.
 *  - **Backslash.** For special schemes the URL parser treats `\` as a path
 *    separator, so `/..\..\api/pages/x` collapses to `/api/pages/x` while a
 *    `split('/')` sees one harmless-looking segment. Verified against
 *    `new URL`.
 *  - **Tab, LF, CR.** The parser STRIPS these before parsing anything, so
 *    `/.<TAB>./x` is `/../x` to it. Node's HTTP parser rejects them in a
 *    request target today, which makes this insurance rather than a live hole
 *    — but it is one line of insurance against a lenient front end.
 *
 * Percent-encoded forms of the separators (`%5c`, `%09`) are NOT decoded by the
 * parser either, so they stay literal and are deliberately left alone here.
 */
export function hasDotSegment(path: string): boolean {
  for (const segment of path.replace(/[\t\n\r]/g, '').split(/[/\\]/)) {
    const decoded = segment.replace(/%2e/gi, '.');
    if (decoded === '.' || decoded === '..') return true;
  }
  return false;
}

/**
 * The container/probe health path, matched on the RAW target.
 *
 * Deliberately not the normalized one: `/../../health` normalizes to `/health`,
 * and answering that 200 would hand a traversal attempt a success signal and
 * bypass the dot-segment refusal below.
 */
export function isHealthRequest(rawUrl: string): boolean {
  return pathOf(rawUrl) === '/health';
}

/**
 * The whole rewriter decision, as a pure function of (url, host, config).
 *
 * When `siteBaseDomain` is null the feature is inert and every request passes
 * through untouched — that is the prod-safety default, and it stays FIRST so
 * an off switch is genuinely off.
 *
 * `/health` is not handled here at all: the middleware answers it before it
 * ever reaches classification (see `rewriteSiteRequests`).
 */
export function resolveSiteRequest(
  rawUrl: string,
  hostHeader: unknown,
  config: SiteHostConfig
): SiteRequestResolution {
  if (!config.siteBaseDomain) return { action: 'pass' };

  const rawPath = pathOf(rawUrl);

  // Above every allowance, for every host class: a dot segment means the path
  // this middleware sees and the path React Router sees are different strings.
  if (hasDotSegment(rawPath)) return { action: 'not-found', reason: 'dot-segment' };

  // Classify on what the adapter will route on, never on the raw bytes.
  const path = decisionPathOf(rawUrl);

  const classification = classifyHost(hostHeader, config);

  switch (classification.kind) {
    case 'canonical':
      // ACME and friends belong to the canonical deployment.
      if (isWellKnownPath(path)) return { action: 'pass' };
      // The internal namespace is reachable only via an internal rewrite.
      if (isInternalPath(path)) return { action: 'not-found', reason: 'internal-path' };
      return { action: 'pass' };

    case 'site':
      // NOTE: no `.well-known` allowance on a site host. It falls through to
      // the rewrite and 404s inside the _site tree, rather than serving the
      // editor app (hydration payload, none of the site's security headers)
      // off a tenant domain.
      //
      // Script-less site pages never issue React Router single-fetch requests;
      // refusing them removes a loader-serialization surface.
      //
      // A RESOLVED CUSTOM DOMAIN lands here too, and gets this branch verbatim
      // — the same `.data` refusal, the same absence of a `.well-known`
      // allowance. Grafting custom domains onto the `unknown` branch instead
      // would have inherited its `.well-known` pass and dropped the `.data`
      // refusal, which together mean the editor app served off a tenant's own
      // domain. The ACME question that allowance exists for does not arise:
      // Fly answers certificate challenges at its proxy (TLS-ALPN, or DNS-01),
      // for issuance AND for the 90-day renewal, so no
      // `/.well-known/acme-challenge/` request ever reaches this app. An
      // UNCLAIMED hostname still falls through to `default` below and keeps
      // that pass, which is what a domain pointed here before it is connected
      // needs.
      if (path.endsWith('.data')) return { action: 'not-found', reason: 'data-request' };
      return {
        action: 'rewrite',
        url: computeSiteUrl(rawUrl, classification.subdomain),
        subdomain: classification.subdomain,
        ...(classification.customDomain ? { customDomain: classification.customDomain } : {}),
      };

    case 'invalid':
      return { action: 'not-found', reason: 'invalid-host' };

    default:
      // A domain pointed at us but not yet configured still needs to be able to
      // answer an ACME challenge; everything else on it is a 404.
      if (isWellKnownPath(path)) return { action: 'pass' };
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

function sendHealthy(res: Response): void {
  res.status(200);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send('ok\n');
}

/**
 * Where the middleware records "this request arrived on a custom domain".
 *
 * A property on the Express request, NEVER a header. An inbound header would be
 * forgeable by anyone — and forging this one is not a small thing: it flips the
 * `rel=canonical` and `og:url` of a shared-cacheable response, so a single
 * crafted request could poison 60 seconds of a public page with an attacker's
 * chosen canonical URL. This whole file exists in part to strip exactly that
 * class of input (see `sanitizeForwardedHost`).
 *
 * A plain string key rather than a `Symbol`, because in DEV this module is
 * loaded twice — by bare node for the middleware, and again through Vite for
 * `server/app.ts` — and two `Symbol()` calls in two module instances are two
 * different keys. A string survives the boundary.
 */
export const CUSTOM_DOMAIN_REQUEST_KEY = '__classmojiCustomDomain';

/** The load context every class-site loader receives. */
export type SiteLoadContext = {
  /** The custom hostname this request arrived on, or null for every other host. */
  customDomain: string | null;
};

/**
 * Build the React Router load context from a request the middleware has seen.
 *
 * Wired into `createRequestHandler` in BOTH `server.ts` (prod) and
 * `server/app.ts` (dev) — the two entry points construct their own handlers, so
 * a marker wired into only one of them is a marker that silently does nothing
 * in the other environment.
 *
 * Reads only what the middleware stamped. A request that never passed through
 * `rewriteSiteRequests` — which cannot happen for a routed request, but can for
 * a hand-built one in a test — reads as "not a custom domain", the safe answer.
 */
export function buildSiteLoadContext(req: unknown): SiteLoadContext {
  const marker =
    req && typeof req === 'object'
      ? (req as Record<string, unknown>)[CUSTOM_DOMAIN_REQUEST_KEY]
      : undefined;

  return { customDomain: typeof marker === 'string' && marker.length > 0 ? marker : null };
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
 *
 * `options.resolveCustomHost` is how custom domains are switched on. It is a
 * parameter rather than an import so this module keeps its "no runtime
 * dependencies" property — see the file header — and so tests can drive the
 * whole rewriter off a `Map` with no database anywhere near it.
 */
export function createSiteHostMiddleware(
  env: SiteHostEnv = process.env,
  options: { resolveCustomHost?: CustomHostResolver } = {}
): SiteHostMiddleware {
  const config: SiteHostConfig = {
    ...resolveSiteHostConfig(env),
    ...(options.resolveCustomHost ? { resolveCustomHost: options.resolveCustomHost } : {}),
  };

  const sanitizeForwardedHost: RequestHandler = (
    req: Request,
    _res: Response,
    next: NextFunction
  ) => {
    delete req.headers['x-forwarded-host'];
    next();
  };

  /** Stamp (or clear) the custom-domain marker on a request. */
  const markCustomDomain = (req: Request, customDomain: string | null): void => {
    // Written unconditionally, including the null case. Express hands every
    // request a fresh object so there is nothing to inherit today, but a marker
    // that is only ever SET is one middleware reorder away from being sticky,
    // and this one decides what a page calls itself.
    (req as unknown as Record<string, unknown>)[CUSTOM_DOMAIN_REQUEST_KEY] = customDomain;
  };

  const rewriteSiteRequests: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    // Answered HERE, before any host classification: the probe has to work on
    // whatever Host the platform sends, and letting it into the app would serve
    // the editor document — hydration payload, no site headers, a session and
    // membership lookup per probe — off every tenant domain.
    if (isHealthRequest(req.url || '/')) {
      sendHealthy(res);
      return;
    }

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
      markCustomDomain(req, resolution.customDomain ?? null);
    } else {
      markCustomDomain(req, null);
    }

    next();
  };

  return { sanitizeForwardedHost, rewriteSiteRequests, config };
}
