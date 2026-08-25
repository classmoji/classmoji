import { describe, expect, it } from 'vitest';

import { sessionCookieRegexFor, sessionTokenFromCookieHeader } from '../secret.ts';

/**
 * The session cookie's NAME is configurable (`COOKIE_PREFIX`), and staging must
 * run `classmoji-staging` — both environments are scoped to subdomains of
 * classmoji.io, so identically-named cookies shadow each other and a staging
 * session can silently displace a production one in the same browser.
 *
 * Every consumer that reads a cookie header by name builds its matcher here, so
 * these cases stand in for all of them: `getAuthSession`'s dev-login fallback,
 * `apps/pages`' cache-privacy check, `apps/slides`' socket handshake.
 *
 * `COOKIE_PREFIX` resolves at import time, so the exported BUILDER is the only
 * way a test can reach a prefix other than this process's.
 */
describe('sessionCookieRegexFor', () => {
  const production = sessionCookieRegexFor('classmoji');
  const staging = sessionCookieRegexFor('classmoji-staging');

  it('matches the cookie for its own prefix, anywhere in the header', () => {
    expect(production.test('classmoji.session_token=abc')).toBe(true);
    expect(production.test('theme=dark; classmoji.session_token=abc')).toBe(true);
    expect(staging.test('classmoji-staging.session_token=abc')).toBe(true);
    expect(staging.test('theme=dark; classmoji-staging.session_token=abc')).toBe(true);
  });

  it('matches the __Secure- variant under either prefix', () => {
    // better-auth prepends it whenever it sets secure cookies — i.e. in every
    // deployed environment, which is exactly where this matters.
    expect(production.test('__Secure-classmoji.session_token=abc')).toBe(true);
    expect(staging.test('__Secure-classmoji-staging.session_token=abc')).toBe(true);
  });

  it('rejects the OTHER environment’s cookie, in both directions', () => {
    // The whole point of the prefix: a leftover prod cookie must not read as a
    // staging session, and a staging cookie must not read as a prod one.
    expect(staging.test('classmoji.session_token=abc')).toBe(false);
    expect(production.test('classmoji-staging.session_token=abc')).toBe(false);
    expect(production.test('__Secure-classmoji-staging.session_token=abc')).toBe(false);
  });

  it('escapes the regex-active characters in the prefix', () => {
    // `.` and `-` both occur in real prefixes and both mean something to a
    // regex engine; unescaped, `classmoji-staging` would match `classmojiX…`.
    expect(staging.test('classmojiXstaging.session_token=abc')).toBe(false);
    expect(staging.test('classmoji-stagingXsession_token=abc')).toBe(false);
    expect(production.test('classmojiXsession_token=abc')).toBe(false);
  });

  it('cannot be smuggled by a lookalike cookie name', () => {
    // The `(?:^|;\s*)` anchor is what stops a substring match here.
    expect(production.test('not-classmoji.session_token=abc')).toBe(false);
    expect(staging.test('not-classmoji-staging.session_token=abc')).toBe(false);
    expect(staging.test('xclassmoji-staging.session_token=abc')).toBe(false);
    expect(production.test('evil=classmoji.session_token=abc')).toBe(false);
  });

  it('an unrelated cookie, or none at all, is not a session', () => {
    expect(production.test('ab_test=1; theme=dark')).toBe(false);
    expect(production.test('')).toBe(false);
  });

  it('captures the token value, stopping at the cookie separator', () => {
    expect('theme=dark; classmoji.session_token=abc.def; x=1'.match(production)?.[1]).toBe(
      'abc.def'
    );
    expect('__Secure-classmoji-staging.session_token=xyz'.match(staging)?.[1]).toBe('xyz');
  });

  /**
   * `[^;]*` rather than `[^;]+`, deliberately: a present-but-empty cookie is
   * still a session cookie the browser sent, so presence checks (apps/pages
   * decides cacheability on exactly this) must keep seeing it — while token
   * extractors get `''` and fall through their own truthiness guard, which is
   * the same outcome a non-match would have produced.
   */
  it('an empty cookie value is still PRESENT, but yields no token', () => {
    expect(production.test('classmoji.session_token=')).toBe(true);
    expect(production.test('classmoji.session_token=; theme=dark')).toBe(true);
    expect('classmoji.session_token='.match(production)?.[1]).toBe('');
  });

  it('has no /g flag — a module-level matcher must not carry lastIndex', () => {
    // A shared regex with /g would return alternating answers on repeat calls,
    // i.e. every other request would look anonymous.
    expect(production.global).toBe(false);
    const header = 'classmoji.session_token=abc';
    expect(production.test(header)).toBe(true);
    expect(production.test(header)).toBe(true);
  });
});

/**
 * The deployment-constant path: bound to THIS process's `COOKIE_PREFIX`, which
 * is unset here and therefore `classmoji`.
 */
describe('sessionTokenFromCookieHeader', () => {
  it('extracts the token for the configured prefix', () => {
    expect(sessionTokenFromCookieHeader('classmoji.session_token=abc.def')).toBe('abc.def');
    expect(sessionTokenFromCookieHeader('theme=dark; classmoji.session_token=abc')).toBe('abc');
    expect(sessionTokenFromCookieHeader('__Secure-classmoji.session_token=abc')).toBe('abc');
  });

  it('returns null rather than an empty string, so callers can guard once', () => {
    expect(sessionTokenFromCookieHeader('')).toBeNull();
    expect(sessionTokenFromCookieHeader('theme=dark')).toBeNull();
    expect(sessionTokenFromCookieHeader('classmoji.session_token=')).toBeNull();
    expect(sessionTokenFromCookieHeader('not-classmoji.session_token=abc')).toBeNull();
  });

  it('does not read another environment’s cookie', () => {
    expect(sessionTokenFromCookieHeader('classmoji-staging.session_token=abc')).toBeNull();
  });
});
