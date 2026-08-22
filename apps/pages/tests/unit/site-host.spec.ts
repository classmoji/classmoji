/**
 * Unit tests for class-site host detection (server/siteHost.ts).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test is pure (no express instance, no network). It carries the
 * security boundary of the class-sites feature:
 *  - the Host header is attacker-controlled, so classification must be strict
 *    and must never redirect;
 *  - the canonical (editor) host must never be mistaken for a class site;
 *  - the internal /_site namespace must not be reachable from outside;
 *  - the rewrite must preserve the raw URL byte-for-byte (percent-encoding);
 *  - an unset SITE_BASE_DOMAIN must leave the whole feature inert.
 */

import { test, expect } from '@playwright/test';
import type { NextFunction, Request, Response } from 'express';
import {
  classifyHost,
  computeSiteUrl,
  createSiteHostMiddleware,
  hasDotSegment,
  isHealthRequest,
  parseHostHeader,
  resolveSiteHostConfig,
  resolveSiteRequest,
  type SiteHostConfig,
} from '../../server/siteHost.ts';

/** Dev-shaped config: sites on lvh.me, editor on localhost. */
const devConfig: SiteHostConfig = {
  siteBaseDomain: 'lvh.me',
  canonicalHosts: ['localhost'],
};

/** Prod-shaped config: the canonical host ALSO matches the site pattern. */
const prodConfig: SiteHostConfig = {
  siteBaseDomain: 'classmoji.io',
  canonicalHosts: ['pages.classmoji.io'],
};

/** Feature off. */
const inertConfig: SiteHostConfig = {
  siteBaseDomain: null,
  canonicalHosts: ['localhost'],
};

// ─── classifyHost: site hosts ────────────────────────────────────────────────

test.describe('classifyHost — site hosts', () => {
  test('a single-label subdomain of the base domain is a site', () => {
    expect(classifyHost('cs52.lvh.me', devConfig)).toEqual({ kind: 'site', subdomain: 'cs52' });
  });

  test('strips exactly one :port suffix', () => {
    expect(classifyHost('cs52.lvh.me:7140', devConfig)).toEqual({
      kind: 'site',
      subdomain: 'cs52',
    });
  });

  test('strips one trailing dot (fully-qualified form)', () => {
    expect(classifyHost('cs52.lvh.me.', devConfig)).toEqual({ kind: 'site', subdomain: 'cs52' });
  });

  test('strips the port before the trailing dot', () => {
    expect(classifyHost('cs52.lvh.me.:7140', devConfig)).toEqual({
      kind: 'site',
      subdomain: 'cs52',
    });
  });

  test('case folds to a lowercase subdomain', () => {
    expect(classifyHost('CS52.LVH.ME', devConfig)).toEqual({ kind: 'site', subdomain: 'cs52' });
  });

  test('accepts interior hyphens and digits in the label', () => {
    expect(classifyHost('cs52-fall-2026.lvh.me', devConfig)).toEqual({
      kind: 'site',
      subdomain: 'cs52-fall-2026',
    });
  });
});

// ─── classifyHost: non-site hosts ────────────────────────────────────────────

test.describe('classifyHost — rejections', () => {
  test('multi-label hosts are unknown, NOT a site', () => {
    // a.b.lvh.me must not resolve to a site named "a.b" or "b".
    expect(classifyHost('a.b.lvh.me', devConfig)).toEqual({ kind: 'unknown' });
  });

  test('the bare base domain is unknown', () => {
    expect(classifyHost('lvh.me', devConfig)).toEqual({ kind: 'unknown' });
  });

  test('a host that merely ends with the base domain string is unknown', () => {
    expect(classifyHost('evillvh.me', devConfig)).toEqual({ kind: 'unknown' });
  });

  test('an unrelated host is unknown', () => {
    expect(classifyHost('evil.example.com', devConfig)).toEqual({ kind: 'unknown' });
  });

  test('labels that are not valid DNS labels are unknown', () => {
    expect(classifyHost('-lead.lvh.me', devConfig)).toEqual({ kind: 'unknown' });
    expect(classifyHost('trail-.lvh.me', devConfig)).toEqual({ kind: 'unknown' });
    expect(classifyHost('under_score.lvh.me', devConfig)).toEqual({ kind: 'unknown' });
  });

  test('commas (header smuggling) are invalid', () => {
    expect(classifyHost('cs52.lvh.me,evil.com', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('whitespace is invalid', () => {
    expect(classifyHost('cs52.lvh.me evil.com', devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost('cs52.lvh.me\t', devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost(' cs52.lvh.me', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('non-ASCII is invalid', () => {
    expect(classifyHost('cs52.lvh.mé', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('userinfo (@) is invalid', () => {
    expect(classifyHost('user@cs52.lvh.me', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('multiple colons are invalid', () => {
    expect(classifyHost('cs52.lvh.me:80:80', devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost('[::1]', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('a non-numeric port is invalid', () => {
    expect(classifyHost('cs52.lvh.me:port', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('empty labels are invalid', () => {
    expect(classifyHost('.lvh.me', devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost('cs52..lvh.me', devConfig)).toEqual({ kind: 'invalid' });
  });

  test('a missing or empty Host header is invalid', () => {
    expect(classifyHost(undefined, devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost('', devConfig)).toEqual({ kind: 'invalid' });
    expect(classifyHost(['a.lvh.me', 'b.lvh.me'], devConfig)).toEqual({ kind: 'invalid' });
  });

  test('hosts longer than 255 chars are invalid', () => {
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.lvh.me`;
    expect(long.length).toBeGreaterThan(255);
    expect(classifyHost(long, devConfig)).toEqual({ kind: 'invalid' });
  });

  test('labels longer than 63 chars are invalid', () => {
    expect(classifyHost(`${'a'.repeat(64)}.lvh.me`, devConfig)).toEqual({ kind: 'invalid' });
  });
});

// ─── classifyHost: canonical hosts ───────────────────────────────────────────

test.describe('classifyHost — canonical hosts', () => {
  test('the PAGES_URL host is canonical even though it matches the site pattern', () => {
    // pages.classmoji.io is a valid single label under classmoji.io — canonical
    // MUST win, or the editor host becomes a class site named "pages".
    expect(classifyHost('pages.classmoji.io', prodConfig)).toEqual({ kind: 'canonical' });
  });

  test('another single-label host under the same base domain is still a site', () => {
    expect(classifyHost('cs52.classmoji.io', prodConfig)).toEqual({
      kind: 'site',
      subdomain: 'cs52',
    });
  });

  test('localhost and 127.0.0.1 are always canonical', () => {
    expect(classifyHost('localhost', devConfig)).toEqual({ kind: 'canonical' });
    expect(classifyHost('localhost:7140', devConfig)).toEqual({ kind: 'canonical' });
    expect(classifyHost('127.0.0.1:7140', devConfig)).toEqual({ kind: 'canonical' });
  });

  test('parseHostHeader normalizes to a bare lowercase hostname', () => {
    expect(parseHostHeader('CS52.LVH.ME.:7140')).toBe('cs52.lvh.me');
    expect(parseHostHeader('localhost:3000')).toBe('localhost');
  });
});

// ─── rewrite path computation ────────────────────────────────────────────────

test.describe('computeSiteUrl', () => {
  test('root becomes the bare site prefix', () => {
    expect(computeSiteUrl('/', 'cs52')).toBe('/_site/cs52');
  });

  test('root with a query keeps the query on the bare prefix', () => {
    expect(computeSiteUrl('/?q=1', 'cs52')).toBe('/_site/cs52?q=1');
  });

  test('a nested path is prefixed verbatim', () => {
    expect(computeSiteUrl('/syllabus/week-1', 'cs52')).toBe('/_site/cs52/syllabus/week-1');
  });

  test('percent-encoding and query strings survive byte-for-byte', () => {
    expect(computeSiteUrl('/page%2Fname?q=a%20b', 'cs52')).toBe('/_site/cs52/page%2Fname?q=a%20b');
    expect(computeSiteUrl('/a+b?x=1&y=%26%3D', 'cs52')).toBe('/_site/cs52/a+b?x=1&y=%26%3D');
    expect(computeSiteUrl('/caf%C3%A9', 'cs52')).toBe('/_site/cs52/caf%C3%A9');
  });

  test('trailing slashes and empty queries are untouched', () => {
    expect(computeSiteUrl('/docs/', 'cs52')).toBe('/_site/cs52/docs/');
    expect(computeSiteUrl('/docs?', 'cs52')).toBe('/_site/cs52/docs?');
  });
});

// ─── resolveSiteRequest ──────────────────────────────────────────────────────

test.describe('resolveSiteRequest — site hosts', () => {
  test('rewrites onto the internal namespace', () => {
    expect(resolveSiteRequest('/about', 'cs52.lvh.me:7140', devConfig)).toEqual({
      action: 'rewrite',
      url: '/_site/cs52/about',
      subdomain: 'cs52',
    });
  });

  test('rewrites the root request', () => {
    expect(resolveSiteRequest('/', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52',
    });
  });

  test('preserves the raw URL byte-for-byte through the rewrite', () => {
    expect(resolveSiteRequest('/page%2Fname?q=a%20b', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/page%2Fname?q=a%20b',
    });
  });

  test('refuses React Router single-fetch (.data) requests', () => {
    expect(resolveSiteRequest('/about.data', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'data-request',
    });
  });

  test('refuses .data even with a query string', () => {
    expect(resolveSiteRequest('/about.data?_routes=root', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'data-request',
    });
  });

  test('does not refuse paths that merely contain ".data"', () => {
    expect(resolveSiteRequest('/about.data.html', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
    });
  });

  /**
   * `/health` no longer bypasses classification in the resolver — the
   * middleware answers it first (see the express-wrapper describe below), so
   * from the resolver's point of view a tenant host asking for `/health` is
   * just another site path. `.well-known` is allowed on non-site hosts ONLY:
   * on a tenant host it must not serve the editor app.
   */
  test('.well-known does NOT escape the rewrite on a site host', () => {
    expect(resolveSiteRequest('/.well-known/zzz', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'rewrite',
      url: '/_site/cs52/.well-known/zzz',
      subdomain: 'cs52',
    });
    expect(
      resolveSiteRequest('/.well-known/acme-challenge/token', 'cs52.lvh.me', devConfig)
    ).toMatchObject({ action: 'rewrite' });
  });

  test('.well-known still passes on the canonical host and on unknown hosts', () => {
    expect(resolveSiteRequest('/.well-known/zzz', 'localhost:7140', devConfig)).toEqual({
      action: 'pass',
    });
    expect(
      resolveSiteRequest('/.well-known/acme-challenge/token', 'totally-unknown.example', devConfig)
    ).toEqual({ action: 'pass' });
    // …but an invalid Host header still gets nothing.
    expect(resolveSiteRequest('/.well-known/zzz', 'a,b', devConfig)).toEqual({
      action: 'not-found',
      reason: 'invalid-host',
    });
  });

  test('the resolver no longer special-cases /health', () => {
    expect(resolveSiteRequest('/health', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/health',
    });
    expect(resolveSiteRequest('/health', 'totally-unknown.example', devConfig)).toEqual({
      action: 'not-found',
      reason: 'unknown-host',
    });
  });
});

// ─── dot-segment traversal ───────────────────────────────────────────────────

/**
 * `@react-router/express` rebuilds the request URL with `new URL(originalUrl)`,
 * and the WHATWG parser removes `.` / `..` segments — AFTER this middleware has
 * classified and rewritten. So `/../../api/pages/x` on a TENANT host normalizes
 * straight back into the canonical route tree with none of the site's headers,
 * and `/x/../_site/cs52` on the CANONICAL host walks into the internal
 * namespace past the `/_site` guard. Both were reproduced over raw sockets.
 */
test.describe('dot-segment traversal', () => {
  test('hasDotSegment flags plain and single-encoded dot segments', () => {
    for (const path of [
      '/../../health',
      '/..',
      '/./x',
      '/a/../b',
      '/%2e%2e/x',
      '/%2E%2E/x',
      '/%2e/x',
      '/x/%2E/y',
    ]) {
      expect(hasDotSegment(path), `${path} should be flagged`).toBe(true);
    }
  });

  /**
   * The WHATWG URL parser treats `\` as a path separator for http(s) and
   * STRIPS tab/LF/CR before parsing at all — so `/..\..\api/pages/x` and
   * `/.<TAB>./x` both collapse exactly like `/../../…` does. A dot-segment
   * check that only split on `/` saw one innocent-looking segment and waved
   * them through, which put the tenant→canonical escape right back.
   */
  const BACKSLASH = String.fromCharCode(92);

  test('hasDotSegment flags the separators the URL parser also honours', () => {
    for (const path of [
      `/..${BACKSLASH}..${BACKSLASH}api/pages/x`,
      `/x/..${BACKSLASH}_site/cs52`,
      `/%2e%2e${BACKSLASH}%2e%2e/api/x`,
      '/.\t./x',
      '/.\n./x',
      '/.\r./x',
    ]) {
      expect(hasDotSegment(path), `${JSON.stringify(path)} should be flagged`).toBe(true);
      // …and every one of them really does collapse, which is why it matters.
      expect(new URL(path, 'http://x').pathname).not.toBe(path);
    }
  });

  test('a backslash traversal cannot escape a tenant host into the canonical tree', () => {
    const url = `/..${BACKSLASH}..${BACKSLASH}api/pages/x`;
    // Without the refusal this rewrites to `/_site/cs52/..\..\api/pages/x`,
    // which the adapter re-parses as `/api/pages/x` — the editor's API, served
    // off a class-site domain.
    expect(new URL(`/_site/cs52${url}`, 'http://x').pathname).toBe('/api/pages/x');
    expect(resolveSiteRequest(url, 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
  });

  test('hasDotSegment leaves legitimate slugs alone', () => {
    for (const path of [
      '/',
      '/syllabus',
      '/%252e',
      '/foo.bar',
      '/...',
      '/..a',
      '/a..',
      '/.well-known/acme-challenge/token',
      '/caf%C3%A9',
      '/page%2Fname',
      '/.hidden',
      // The parser does not decode these, so they stay literal text.
      '/%5c../x',
      '/.%09./x',
    ]) {
      expect(hasDotSegment(path), `${path} should NOT be flagged`).toBe(false);
      // The negatives are only safe because they do not collapse either.
      expect(new URL(path, 'http://x').pathname, `${path} unexpectedly collapsed`).toBe(path);
    }
  });

  const traversals = [
    '/../../health',
    '/../../',
    '/../../api/pages/x',
    '/../dali/page',
    '/%2e%2e/%2e%2e/health',
    '/%2E%2E/x',
    '/a/../_site/cs52/x',
  ];

  for (const url of traversals) {
    test(`site host refuses ${url}`, () => {
      expect(resolveSiteRequest(url, 'cs52.lvh.me:7140', devConfig)).toEqual({
        action: 'not-found',
        reason: 'dot-segment',
      });
    });

    test(`canonical host refuses ${url}`, () => {
      expect(resolveSiteRequest(url, 'localhost:7140', devConfig)).toEqual({
        action: 'not-found',
        reason: 'dot-segment',
      });
    });
  }

  test('the canonical host cannot walk into /_site through a dot segment', () => {
    for (const url of [
      '/./_site/cs52',
      '/x/../_site/cs52/secret',
      '/%2e/_site/cs52',
      '/./_site/cs52/syllabus.data',
    ]) {
      expect(resolveSiteRequest(url, 'localhost:7140', devConfig), url).toMatchObject({
        action: 'not-found',
      });
    }
  });

  test('a site host cannot smuggle a .data request through a dot segment', () => {
    expect(resolveSiteRequest('/./syllabus.data', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
    expect(resolveSiteRequest('/x/../syllabus.data', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
  });

  test('a dot segment cannot borrow the /health or /.well-known bypass', () => {
    expect(resolveSiteRequest('/health/../_site/cs52', 'localhost:7140', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
    expect(resolveSiteRequest('/.well-known/../_site/cs52', 'localhost:7140', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
  });

  test('query strings do not hide a traversal, and are not searched for one', () => {
    expect(resolveSiteRequest('/../x?a=1', 'cs52.lvh.me', devConfig)).toEqual({
      action: 'not-found',
      reason: 'dot-segment',
    });
    // A `..` inside the QUERY is just data.
    expect(resolveSiteRequest('/syllabus?next=/../x', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/syllabus?next=/../x',
    });
  });

  test('legitimate slugs that merely look like traversal still resolve, byte-for-byte', () => {
    expect(resolveSiteRequest('/%252e', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/%252e',
    });
    expect(resolveSiteRequest('/foo.bar', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/foo.bar',
    });
    expect(resolveSiteRequest('/...', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/...',
    });
    expect(resolveSiteRequest('/syllabus', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/syllabus',
    });
    expect(resolveSiteRequest('/caf%C3%A9?q=a%20b', 'cs52.lvh.me', devConfig)).toMatchObject({
      action: 'rewrite',
      url: '/_site/cs52/caf%C3%A9?q=a%20b',
    });
    // And the canonical host keeps serving its own traffic.
    expect(resolveSiteRequest('/cs52/page-id?edit=1', 'localhost:7140', devConfig)).toEqual({
      action: 'pass',
    });
  });

  test('inert config stays inert — traversal included', () => {
    expect(resolveSiteRequest('/../../health', 'cs52.lvh.me', inertConfig)).toEqual({
      action: 'pass',
    });
  });
});

test.describe('resolveSiteRequest — canonical hosts', () => {
  test('blocks the internal namespace', () => {
    expect(resolveSiteRequest('/_site/cs52', 'localhost:7140', devConfig)).toEqual({
      action: 'not-found',
      reason: 'internal-path',
    });
    expect(resolveSiteRequest('/_site', 'localhost:7140', devConfig)).toEqual({
      action: 'not-found',
      reason: 'internal-path',
    });
  });

  test('does not block paths that merely start with the same characters', () => {
    expect(resolveSiteRequest('/_sitemap.xml', 'localhost:7140', devConfig)).toEqual({
      action: 'pass',
    });
  });

  test('passes normal editor traffic through untouched', () => {
    expect(resolveSiteRequest('/cs52/page-id?edit=1', 'localhost:7140', devConfig)).toEqual({
      action: 'pass',
    });
    expect(resolveSiteRequest('/cs52/page-id.data', 'localhost:7140', devConfig)).toEqual({
      action: 'pass',
    });
  });
});

test.describe('resolveSiteRequest — unknown and invalid hosts', () => {
  test('unknown hosts 404 (never redirect)', () => {
    expect(resolveSiteRequest('/', 'evil.example.com', devConfig)).toEqual({
      action: 'not-found',
      reason: 'unknown-host',
    });
  });

  test('invalid hosts 404', () => {
    expect(resolveSiteRequest('/', 'cs52.lvh.me,evil.com', devConfig)).toEqual({
      action: 'not-found',
      reason: 'invalid-host',
    });
    expect(resolveSiteRequest('/', undefined, devConfig)).toEqual({
      action: 'not-found',
      reason: 'invalid-host',
    });
  });
});

test.describe('resolveSiteRequest — inert (SITE_BASE_DOMAIN unset)', () => {
  test('every request passes through, whatever the host', () => {
    expect(resolveSiteRequest('/foo', 'cs52.lvh.me', inertConfig)).toEqual({ action: 'pass' });
    expect(resolveSiteRequest('/foo', 'evil.example.com', inertConfig)).toEqual({ action: 'pass' });
    expect(resolveSiteRequest('/foo', undefined, inertConfig)).toEqual({ action: 'pass' });
    expect(resolveSiteRequest('/_site/cs52', 'localhost', inertConfig)).toEqual({ action: 'pass' });
  });
});

// ─── config resolution / boot behaviour ──────────────────────────────────────

test.describe('resolveSiteHostConfig', () => {
  test('unset or blank SITE_BASE_DOMAIN leaves the feature inert', () => {
    expect(resolveSiteHostConfig({}).siteBaseDomain).toBeNull();
    expect(resolveSiteHostConfig({ SITE_BASE_DOMAIN: '' }).siteBaseDomain).toBeNull();
    expect(resolveSiteHostConfig({ SITE_BASE_DOMAIN: '   ' }).siteBaseDomain).toBeNull();
    expect(resolveSiteHostConfig({ SITE_BASE_DOMAIN: undefined }).siteBaseDomain).toBeNull();
  });

  test('derives the canonical host from PAGES_URL', () => {
    expect(
      resolveSiteHostConfig({
        PAGES_URL: 'https://pages.classmoji.io',
        SITE_BASE_DOMAIN: 'classmoji.io',
      })
    ).toEqual({ siteBaseDomain: 'classmoji.io', canonicalHosts: ['pages.classmoji.io'] });

    expect(resolveSiteHostConfig({ PAGES_URL: 'http://localhost:7140' }).canonicalHosts).toEqual([
      'localhost',
    ]);
  });

  test('a malformed PAGES_URL is tolerated (loopback stays canonical)', () => {
    expect(resolveSiteHostConfig({ PAGES_URL: 'not a url' }).canonicalHosts).toEqual([]);
    expect(classifyHost('localhost', resolveSiteHostConfig({ PAGES_URL: 'not a url' }))).toEqual({
      kind: 'canonical',
    });
  });

  test('accepts bare lowercase domains', () => {
    expect(resolveSiteHostConfig({ SITE_BASE_DOMAIN: 'lvh.me' }).siteBaseDomain).toBe('lvh.me');
    expect(resolveSiteHostConfig({ SITE_BASE_DOMAIN: ' classmoji.io ' }).siteBaseDomain).toBe(
      'classmoji.io'
    );
  });

  test('a malformed SITE_BASE_DOMAIN throws (fail closed at boot)', () => {
    const bad = [
      'https://classmoji.io',
      'Classmoji.io',
      'classmoji.io:443',
      '.classmoji.io',
      'classmoji.io.',
      'classmoji',
      'classmoji.io/pages',
      'class moji.io',
      '*.classmoji.io',
    ];
    for (const value of bad) {
      expect(
        () => resolveSiteHostConfig({ SITE_BASE_DOMAIN: value }),
        `expected ${value} to be rejected`
      ).toThrow(/SITE_BASE_DOMAIN/);
    }
  });

  test('createSiteHostMiddleware throws at construction, not per-request', () => {
    expect(() => createSiteHostMiddleware({ SITE_BASE_DOMAIN: 'https://classmoji.io' })).toThrow(
      /SITE_BASE_DOMAIN/
    );
    expect(() => createSiteHostMiddleware({})).not.toThrow();
  });
});

// ─── express wrappers ────────────────────────────────────────────────────────

type FakeRes = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string | null;
  status(code: number): FakeRes;
  setHeader(name: string, value: string): void;
  send(body: string): void;
};

const fakeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: null,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    send(body) {
      res.body = body;
    },
  };
  return res;
};

const fakeReq = (url: string, headers: Record<string, string> = {}): Request =>
  ({ url, originalUrl: url, headers }) as unknown as Request;

test.describe('createSiteHostMiddleware', () => {
  test('the sanitizer always drops X-Forwarded-Host', () => {
    const { sanitizeForwardedHost } = createSiteHostMiddleware({});
    const req = fakeReq('/', { host: 'localhost', 'x-forwarded-host': 'cs52.lvh.me' });
    let nexted = false;

    sanitizeForwardedHost(
      req,
      fakeRes() as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(req.headers['x-forwarded-host']).toBeUndefined();
    expect(nexted).toBe(true);
  });

  test('a site request rewrites BOTH req.url and req.originalUrl', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      SITE_BASE_DOMAIN: 'lvh.me',
      PAGES_URL: 'http://localhost:7140',
    });
    const req = fakeReq('/syllabus?week=1', { host: 'cs52.lvh.me:7140' });
    let nexted = false;

    rewriteSiteRequests(
      req,
      fakeRes() as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(req.url).toBe('/_site/cs52/syllabus?week=1');
    expect(req.originalUrl).toBe('/_site/cs52/syllabus?week=1');
    expect(nexted).toBe(true);
  });

  test('an unknown host gets a no-store, noindex 404 and never reaches the app', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({ SITE_BASE_DOMAIN: 'lvh.me' });
    const req = fakeReq('/', { host: 'evil.example.com' });
    const res = fakeRes();
    let nexted = false;

    rewriteSiteRequests(
      req,
      res as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toBeTruthy();
    expect(req.url).toBe('/');
  });

  test('the canonical host cannot reach /_site', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      SITE_BASE_DOMAIN: 'lvh.me',
      PAGES_URL: 'http://localhost:7140',
    });
    const req = fakeReq('/_site/cs52/secret', { host: 'localhost:7140' });
    const res = fakeRes();
    let nexted = false;

    rewriteSiteRequests(
      req,
      res as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
  });

  /**
   * `/health` is answered by the middleware itself, before classification.
   * Routing it into the app would serve the editor document — with its
   * hydration payload and root.tsx's session/user/membership lookup — off every
   * tenant domain, which is what the old `isAlwaysAllowed` bypass did.
   */
  test('isHealthRequest matches the exact raw path only', () => {
    expect(isHealthRequest('/health')).toBe(true);
    expect(isHealthRequest('/health?verbose=1')).toBe(true);
    expect(isHealthRequest('/healthz')).toBe(false);
    expect(isHealthRequest('/health/x')).toBe(false);
    // Matched RAW, so the normalized form never gets a 200 (see below).
    expect(isHealthRequest('/../../health')).toBe(false);
  });

  test('/health answers 200 text/plain on ANY host, without reaching the app', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      SITE_BASE_DOMAIN: 'lvh.me',
      PAGES_URL: 'http://localhost:7140',
    });

    for (const host of ['localhost:7140', 'cs52.lvh.me', 'evil.example.com', 'a,b']) {
      const res = fakeRes();
      let nexted = false;
      rewriteSiteRequests(
        fakeReq('/health', { host }),
        res as unknown as Response,
        (() => {
          nexted = true;
        }) as NextFunction
      );

      expect(nexted, `host ${host} leaked /health into the app`).toBe(false);
      expect(res.statusCode, `host ${host}`).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe('ok\n');
    }
  });

  test('a traversal that normalizes to /health gets a 404, not a 200', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      SITE_BASE_DOMAIN: 'lvh.me',
      PAGES_URL: 'http://localhost:7140',
    });
    const req = fakeReq('/../../health', { host: 'cs52.lvh.me' });
    const res = fakeRes();
    let nexted = false;

    rewriteSiteRequests(
      req,
      res as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(req.url).toBe('/../../health');
  });

  test('a tenant-host traversal never reaches the canonical route tree', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      SITE_BASE_DOMAIN: 'lvh.me',
      PAGES_URL: 'http://localhost:7140',
    });
    const req = fakeReq('/../../api/pages/cs52', { host: 'cs52.lvh.me' });
    const res = fakeRes();
    let nexted = false;

    rewriteSiteRequests(
      req,
      res as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(404);
    // Untouched: nothing downstream gets a chance to normalize it.
    expect(req.url).toBe('/../../api/pages/cs52');
    expect(req.originalUrl).toBe('/../../api/pages/cs52');
  });

  test('with SITE_BASE_DOMAIN unset the rewriter is a no-op', () => {
    const { rewriteSiteRequests } = createSiteHostMiddleware({
      PAGES_URL: 'http://localhost:7140',
    });
    const req = fakeReq('/cs52/page-id', { host: 'cs52.lvh.me' });
    let nexted = false;

    rewriteSiteRequests(
      req,
      fakeRes() as unknown as Response,
      (() => {
        nexted = true;
      }) as NextFunction
    );

    expect(nexted).toBe(true);
    expect(req.url).toBe('/cs52/page-id');
    expect(req.originalUrl).toBe('/cs52/page-id');
  });
});
