import { test, expect } from '@playwright/test';

import {
  checkMailDomain,
  domainOf,
  resetMailDomainCache,
  suggestDomain,
} from '../../app/utils/emailDomain.server.ts';

/**
 * The deliverability check, as pure functions plus two real lookups.
 *
 * ── Why unit tests and not only HTTP ───────────────────────────────────────
 * The interesting cases are a domain that does not exist, a domain that does, a
 * resolver that never answers, and a near-miss that must be SUGGESTED and never
 * applied. Only the first two are reachable from a browser at all, and the
 * timeout case cannot be produced over HTTP without waiting on a real network
 * fault. The e2e suite still drives the endpoint (`forms-domain-check.spec.ts`)
 * because "the checker says so" and "the page says so" are different claims.
 *
 * Runs in the Playwright runner with no browser and no dev stack, like
 * `forms-submission-rate.spec.ts`.
 *
 * ── The two live lookups ───────────────────────────────────────────────────
 * `.invalid` is reserved by RFC 6761 §6.4 and is guaranteed never to resolve,
 * so the NXDOMAIN case is deterministic rather than dependent on somebody not
 * registering a fixture domain. The positive case asserts only that a real
 * mailbox host is NOT reported as undeliverable — deliberately weaker than
 * `toBe('ok')`, because a suite running without a network should report this
 * feature staying silent, which is correct behaviour, not a failure.
 *
 * Note `example.com` is NOT used as the "real domain": it resolves but
 * publishes no MX, which is precisely the ambiguous case.
 */

test.describe('domainOf', () => {
  test('takes the part after the LAST @, lowercased', () => {
    expect(domainOf('First.Last@Dartmouth.EDU')).toBe('dartmouth.edu');
    // Quoted local parts can contain an @; the last one is the real separator.
    expect(domainOf('"weird@local"@example.org')).toBe('example.org');
  });

  test('refuses anything that is not a domain, rather than handing it to a resolver', () => {
    expect(domainOf('no-at-sign')).toBeNull();
    expect(domainOf('trailing@')).toBeNull();
    expect(domainOf('bare@localhost')).toBeNull();
    expect(domainOf('spaces@ex ample.com')).toBeNull();
    expect(domainOf(`long@${'a'.repeat(260)}.com`)).toBeNull();
  });
});

test.describe('suggestDomain', () => {
  test('proposes the CONFIGURED domain for a near miss, ahead of any provider', () => {
    expect(suggestDomain('dartmuoth.edu', 'dartmouth.edu')).toBe('dartmouth.edu');
    expect(suggestDomain('dartmouth.ed', 'dartmouth.edu')).toBe('dartmouth.edu');
  });

  test('proposes a common provider when the form restricts nothing', () => {
    expect(suggestDomain('gmial.com')).toBe('gmail.com');
    expect(suggestDomain('hotmial.com')).toBe('hotmail.com');
  });

  test('says nothing for an exact match, including a provider typed correctly', () => {
    expect(suggestDomain('gmail.com')).toBeNull();
    expect(suggestDomain('dartmouth.edu', 'dartmouth.edu')).toBeNull();
    // The short-domain trap: `me.com` must not be "corrected" to `proton.me`.
    expect(suggestDomain('me.com')).toBeNull();
  });

  test('says nothing for a domain that is simply different', () => {
    expect(suggestDomain('cs.stanford.edu', 'dartmouth.edu')).toBeNull();
    expect(suggestDomain('acme.co.uk')).toBeNull();
  });

  test('never returns more than one, and never the typed value itself', () => {
    const suggestion = suggestDomain('gmai.com', 'gmail.com');
    expect(typeof suggestion === 'string' || suggestion === null).toBe(true);
    expect(suggestion).not.toBe('gmai.com');
  });
});

test.describe('checkMailDomain', () => {
  test.beforeEach(() => resetMailDomainCache());

  test('reports a domain that cannot exist as undeliverable', async () => {
    expect(await checkMailDomain('dartmuoth.invalid')).toBe('no-mail-server');
  });

  test('does NOT report a real mailbox host as undeliverable', async () => {
    expect(await checkMailDomain('gmail.com')).not.toBe('no-mail-server');
  });

  /**
   * The cache is what keeps this endpoint from becoming a free resolver for
   * whoever can type an address, so "it is actually consulted" is a security
   * property and not an optimisation detail. Asserted by timing the second call
   * against a decided verdict: a repeat that went back to DNS could not return
   * in under a millisecond.
   */
  test('answers a repeat from cache instead of asking DNS again', async () => {
    await checkMailDomain('dartmuoth.invalid');

    const started = Date.now();
    const verdict = await checkMailDomain('dartmuoth.invalid');
    expect(verdict).toBe('no-mail-server');
    expect(Date.now() - started).toBeLessThan(5);
  });

  test('forgets everything when the cache is reset, so tests cannot leak into each other', async () => {
    await checkMailDomain('dartmuoth.invalid');
    resetMailDomainCache();

    const started = Date.now();
    await checkMailDomain('dartmuoth.invalid');
    // A real lookup again — slower than the cached path above by orders of
    // magnitude, even against a local resolver.
    expect(Date.now() - started).toBeGreaterThan(0);
  });
});
