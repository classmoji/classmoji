/**
 * Unit tests for the custom-domain routing snapshot and the two SEO decisions
 * that hang off it.
 *
 * The snapshot's loader is injected, so nothing here touches a database — what
 * is under test is the refresh discipline, and specifically what happens when a
 * refresh FAILS. That is the interesting case: a database blip must not
 * un-route every custom domain at once, which would take every instructor's
 * site offline for a transient error the sites themselves never depended on.
 *
 * The canonical-flip matrix is here rather than in site-host.spec.ts because it
 * is a decision about what a page CALLS ITSELF, not about where a request goes.
 * Both hostnames have to reach the same answer or they become competing copies
 * of the same course.
 */

import { test, expect } from '@playwright/test';

import { createCustomDomainSnapshot } from '../../server/customDomains.ts';
import { lapsedCustomDomainRedirect, seoOriginFor } from '~/site/tenant.server.ts';

/** Wait for the snapshot's in-flight refresh to settle. */
const settle = (snapshot: { refresh: () => Promise<void> }) => snapshot.refresh();

test.describe('custom-domain snapshot', () => {
  test('resolves a claimed hostname once the first load lands', async () => {
    const snapshot = createCustomDomainSnapshot({
      load: async () => [['cs52.me', 'cs52'] as const],
    });
    await settle(snapshot);

    expect(snapshot.resolve('cs52.me')).toBe('cs52');
    expect(snapshot.resolve('unclaimed.example')).toBeNull();
    snapshot.stop();
  });

  test('starts EMPTY, so nothing routes before the first load', async () => {
    // Failing closed at boot: the cost is a brief 404 on a custom domain, and
    // the alternative — routing on a map we have not loaded — cannot happen.
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const snapshot = createCustomDomainSnapshot({
      load: async () => {
        await gate;
        return [['cs52.me', 'cs52'] as const];
      },
    });

    expect(snapshot.resolve('cs52.me')).toBeNull();
    expect(snapshot.size()).toBe(0);

    release!();
    await settle(snapshot);
    expect(snapshot.resolve('cs52.me')).toBe('cs52');
    snapshot.stop();
  });

  test('normalizes hostnames on the way IN, so lookups stay a bare Map hit', async () => {
    // parseHostHeader has already lowercased and dot-stripped the request side;
    // the two forms have to meet somewhere, and it is cheaper here.
    const snapshot = createCustomDomainSnapshot({
      load: async () => [['  CS52.ME  ', 'cs52'] as const, ['Cs61.Example', 'cs61'] as const],
    });
    await settle(snapshot);

    expect(snapshot.resolve('cs52.me')).toBe('cs52');
    expect(snapshot.resolve('cs61.example')).toBe('cs61');
    snapshot.stop();
  });

  test('FAILS CLOSED to the last good map when a refresh throws', async () => {
    let attempt = 0;
    const snapshot = createCustomDomainSnapshot({
      load: async () => {
        attempt += 1;
        if (attempt === 1) return [['cs52.me', 'cs52'] as const];
        throw new Error('database unreachable');
      },
    });
    await settle(snapshot);
    expect(snapshot.resolve('cs52.me')).toBe('cs52');

    await snapshot.refresh();

    // Still serving. A transient failure must not un-route live sites.
    expect(snapshot.resolve('cs52.me')).toBe('cs52');
    expect(snapshot.size()).toBe(1);
    snapshot.stop();
  });

  test('a successful refresh REPLACES the map, dropping released hostnames', async () => {
    // The other half of fail-closed: a domain that was cleared must actually
    // stop routing, or a re-claim by someone else would serve the old tenant.
    let rows: Array<readonly [string, string]> = [
      ['cs52.me', 'cs52'],
      ['old.example', 'cs61'],
    ];
    const snapshot = createCustomDomainSnapshot({ load: async () => rows });
    await settle(snapshot);
    expect(snapshot.size()).toBe(2);

    rows = [['cs52.me', 'cs52']];
    await snapshot.refresh();

    expect(snapshot.resolve('old.example')).toBeNull();
    expect(snapshot.size()).toBe(1);
    snapshot.stop();
  });

  test('collapses concurrent refreshes into one load', async () => {
    let loads = 0;
    const snapshot = createCustomDomainSnapshot({
      load: async () => {
        loads += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return [['cs52.me', 'cs52'] as const];
      },
    });

    // The constructor already kicked one off; three more while it is in flight.
    await Promise.all([snapshot.refresh(), snapshot.refresh(), snapshot.refresh()]);

    expect(loads).toBe(1);
    snapshot.stop();
  });

  test('the refresh timer never holds the process open', async () => {
    // A routing cache must not be the reason a container refuses to exit.
    const snapshot = createCustomDomainSnapshot({ refreshMs: 10, load: async () => [] });
    await settle(snapshot);
    snapshot.stop();
  });
});

test.describe('canonical hostname (seoOriginFor)', () => {
  const SUB = 'https://cs52.classmoji.io';
  const base = {
    subdomainOrigin: SUB,
    customDomain: 'cs52.me',
    verified: true,
    proActive: true,
    servingOnCustomDomain: false,
  };

  test.beforeEach(() => {
    // customDomainOrigin reads scheme/port off PAGES_URL at call time.
    process.env.PAGES_URL = 'https://pages.classmoji.io';
  });

  test('a verified, active domain is canonical from BOTH hostnames', () => {
    expect(seoOriginFor(base)).toBe('https://cs52.me');
    expect(seoOriginFor({ ...base, servingOnCustomDomain: true })).toBe('https://cs52.me');
  });

  test('an UNVERIFIED claim does not flip the subdomain', () => {
    // Nothing has proved the hostname works yet; pointing the world at it would
    // name a URL that may never resolve.
    expect(seoOriginFor({ ...base, verified: false })).toBe(SUB);
  });

  test('serving ON the custom domain IS the verification', () => {
    // The request only exists because a certificate for this hostname completed
    // a handshake, so the flip happens on the first hit rather than a page view
    // later, once the lazy stamp has landed.
    expect(seoOriginFor({ ...base, verified: false, servingOnCustomDomain: true })).toBe(
      'https://cs52.me'
    );
  });

  test('a LAPSED subscription drops both hostnames back to the subdomain', () => {
    // The custom host is 302ing visitors to the subdomain; a subdomain canonical
    // pointing back at it would name a URL that redirects away.
    expect(seoOriginFor({ ...base, proActive: false })).toBe(SUB);
    expect(seoOriginFor({ ...base, proActive: false, servingOnCustomDomain: true })).toBe(SUB);
  });

  test('a site with no custom domain is unaffected', () => {
    expect(seoOriginFor({ ...base, customDomain: null })).toBe(SUB);
  });

  test('carries the dev scheme and port through, so a canonical is reachable', () => {
    process.env.PAGES_URL = 'http://localhost:7140';
    expect(seoOriginFor(base)).toBe('http://cs52.me:7140');
  });
});

test.describe('lapsed custom domain', () => {
  const request = () => new Request('https://cs52.me/_site/cs52/syllabus?week=1');

  test('is a 302 — never a 301', async () => {
    // A lapse is REVERSIBLE. Browsers and search engines cache a permanent
    // redirect indefinitely, so a 301 would make "upgrade restores it
    // instantly" false for everyone who already followed one.
    const response = lapsedCustomDomainRedirect(
      request(),
      'https://cs52.classmoji.io',
      '/syllabus?week=1'
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://cs52.classmoji.io/syllabus?week=1');
  });

  test('is never cached and never indexed', () => {
    const response = lapsedCustomDomainRedirect(request(), 'https://cs52.classmoji.io', '/');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  test('carries the full path and query to the canonical host', () => {
    // A redirect that drops `?page=2` is a broken link.
    const response = lapsedCustomDomainRedirect(
      request(),
      'https://cs52.classmoji.io',
      '/week-1/lab?tab=setup'
    );
    expect(response.headers.get('Location')).toBe('https://cs52.classmoji.io/week-1/lab?tab=setup');
  });
});
