/**
 * Unit tests for class-site response headers.
 *
 * The two failures these exist to prevent are both silent:
 *
 *  1. A signed-in member's page landing in a SHARED cache, where the next
 *     anonymous visitor is served their members-only content.
 *  2. A leaf route's `headers` export replacing the parent's and taking the
 *     CSP with it. React Router does not merge headers across the route
 *     chain, and a site with no CSP looks exactly like a site with one.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  DARK_MODE_SCRIPT_HASH,
  hasSessionCookie,
  routeSiteHeaders,
  siteHeaders,
} from '~/site/headers.server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const request = (headers: Record<string, string> = {}): Request =>
  new Request('http://cs52.lvh.me/syllabus', { headers });

const anonymous = () => request();
const signedIn = () => request({ cookie: 'classmoji.session_token=abc123' });

test.describe('cache policy', () => {
  test('a public page for an anonymous visitor is shared-cacheable for 60s', () => {
    const headers = siteHeaders({ request: anonymous(), cacheable: true });
    expect(headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(headers.get('Vary')).toBe('Cookie');
  });

  test('no stale-while-revalidate — a page turned private must stop serving promptly', () => {
    const headers = siteHeaders({ request: anonymous(), cacheable: true });
    expect(headers.get('Cache-Control')).not.toContain('stale-while-revalidate');
  });

  test('a session cookie forces private, no-store even when the caller asked to cache', () => {
    const headers = siteHeaders({ request: signedIn(), cacheable: true });
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(headers.get('Vary')).toBe('Cookie');
  });

  test('a non-cacheable anonymous response is no-store', () => {
    const headers = siteHeaders({ request: anonymous(), cacheable: false });
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  test('the secure cookie variant counts as a session', () => {
    expect(hasSessionCookie(request({ cookie: '__Secure-classmoji.session_token=x' }))).toBe(true);
  });

  test('an unrelated cookie is not a session', () => {
    expect(hasSessionCookie(request({ cookie: 'ab_test=1; theme=dark' }))).toBe(false);
    // Guards against a substring match on a lookalike cookie name.
    expect(hasSessionCookie(request({ cookie: 'not-classmoji.session_token=x' }))).toBe(false);
  });

  test('no cookie header at all is anonymous', () => {
    expect(hasSessionCookie(anonymous())).toBe(false);
  });
});

test.describe('security headers', () => {
  test('every response carries the full baseline', () => {
    const headers = siteHeaders({ request: anonymous(), cacheable: true });
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  test('CSP locks the page down to exactly one hashed script', () => {
    const csp = siteHeaders({ request: anonymous() }).get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src ${DARK_MODE_SCRIPT_HASH}`);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'none'");
  });

  test('frame-ancestors names first-party origins, never a tenant wildcard', () => {
    const csp = siteHeaders({ request: anonymous() }).get('Content-Security-Policy') ?? '';
    const clause = csp.split('; ').find(part => part.startsWith('frame-ancestors')) ?? '';
    expect(clause).not.toContain('*');
    // Whatever the environment resolves to, it must be explicit origins.
    expect(clause.length).toBeGreaterThan('frame-ancestors '.length);
  });

  test('noindex is opt-in', () => {
    expect(siteHeaders({ request: anonymous() }).get('X-Robots-Tag')).toBeNull();
    expect(siteHeaders({ request: anonymous(), noindex: true }).get('X-Robots-Tag')).toBe('noindex');
  });
});

test.describe('the CSP script hash tracks root.tsx', () => {
  /**
   * `root.tsx` is owned by another workstream and does not export its inline
   * dark-mode script, so the hash in headers.server.ts is a constant. This
   * re-derives it from the source: editing that script without updating the
   * constant breaks a test here, rather than breaking the CSP in production
   * (where the symptom is "dark mode stopped working", days later).
   */
  test('the hardcoded hash matches the script root.tsx actually inlines', () => {
    const rootPath = path.join(__dirname, '../../app/root.tsx');
    const source = fs.readFileSync(rootPath, 'utf-8');

    const match = source.match(/const DARK_MODE_SCRIPT = `([\s\S]*?)`;/);
    expect(match, 'DARK_MODE_SCRIPT not found in root.tsx — has it been renamed?').toBeTruthy();

    const derived = crypto.createHash('sha256').update(match![1], 'utf8').digest('base64');
    expect(`'sha256-${derived}'`).toBe(DARK_MODE_SCRIPT_HASH);
  });

  test('root.tsx still inlines exactly one script in the site document', () => {
    const rootPath = path.join(__dirname, '../../app/root.tsx');
    const source = fs.readFileSync(rootPath, 'utf-8');

    // Just the SiteDocument component — the declaration that follows it (and
    // the app's own error boundary) legitimately render <Scripts/>.
    const start = source.indexOf('const SiteDocument');
    expect(start, 'SiteDocument not found in root.tsx').toBeGreaterThan(-1);
    const end = source.indexOf('const Root', start);
    expect(end, 'Root not found after SiteDocument').toBeGreaterThan(start);
    const siteDocument = source.slice(start, end);

    const inlineScripts = siteDocument.match(/dangerouslySetInnerHTML/g) ?? [];
    expect(inlineScripts.length, 'site document must inline exactly one script').toBe(1);
    // A script bundle on a site page would defeat the whole design.
    expect(siteDocument).not.toContain('<Scripts');
    expect(siteDocument).not.toContain('<ScrollRestoration');
  });
});

test.describe('route headers export', () => {
  test('CSP survives when only a leaf loader produced headers', () => {
    const loaderHeaders = siteHeaders({ request: anonymous(), cacheable: true });
    const merged = routeSiteHeaders({ loaderHeaders });

    expect(merged.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(merged.get('Cache-Control')).toBe('public, max-age=60');
    expect(merged.get('Vary')).toBe('Cookie');
    expect(merged.get('X-Robots-Tag')).toBeNull();
  });

  test('CSP is present even when nothing supplied headers at all', () => {
    const merged = routeSiteHeaders({});
    expect(merged.get('Content-Security-Policy')).toContain("default-src 'none'");
    // With no information about the request, refuse to cache and refuse to index.
    expect(merged.get('Cache-Control')).toBe('no-store');
    expect(merged.get('X-Robots-Tag')).toBe('noindex');
  });

  test('an undecorated error response still gets the security baseline', () => {
    const errorHeaders = new Headers({ 'Cache-Control': 'no-store' });
    const merged = routeSiteHeaders({ errorHeaders });

    expect(merged.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(merged.get('X-Content-Type-Options')).toBe('nosniff');
    expect(merged.get('Cache-Control')).toBe('no-store');
    expect(merged.get('X-Robots-Tag')).toBe('noindex');
  });

  test('an error overrides a cacheable loader decision', () => {
    const loaderHeaders = siteHeaders({ request: anonymous(), cacheable: true });
    const errorHeaders = siteHeaders({ request: anonymous(), cacheable: false, noindex: true });
    const merged = routeSiteHeaders({ loaderHeaders, errorHeaders });

    expect(merged.get('Cache-Control')).toBe('no-store');
    expect(merged.get('X-Robots-Tag')).toBe('noindex');
  });

  test('a leaf decision beats the parent shell', () => {
    const parentHeaders = siteHeaders({ request: anonymous(), cacheable: false });
    const loaderHeaders = siteHeaders({ request: anonymous(), cacheable: true });
    const merged = routeSiteHeaders({ parentHeaders, loaderHeaders });

    expect(merged.get('Cache-Control')).toBe('public, max-age=60');
  });

  test('a resource route content type survives the merge', () => {
    const loaderHeaders = siteHeaders({
      request: anonymous(),
      cacheable: true,
      contentType: 'text/plain; charset=utf-8',
    });
    const merged = routeSiteHeaders({ loaderHeaders });
    expect(merged.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });
});
