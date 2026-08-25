/**
 * Unit tests for the session cookie slides reads off a socket handshake.
 *
 * `server.ts` cannot be imported — it boots an Express + socket.io server as a
 * side effect — so this pins the two things that can actually drift:
 *
 *  1. the shared builder's behavior under a non-default `COOKIE_PREFIX`, and
 *  2. that `server.ts` still routes through it, by reading its source. That is
 *     the same trick `apps/pages/tests/unit/site-headers.spec.ts` uses to pin
 *     a constant it cannot import, and it is what stops someone reinstating a
 *     hardcoded `classmoji.session_token` here.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import { sessionCookieRegexFor, sessionTokenFromCookieHeader } from '@classmoji/auth/secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLIDES_ROOT = path.join(__dirname, '../..');

/**
 * Staging MUST run `COOKIE_PREFIX=classmoji-staging`: both environments live on
 * subdomains of classmoji.io, so identically-named cookies shadow each other in
 * one browser. A matcher hardcoded to `classmoji.` therefore fails BOTH ways on
 * staging — it never matches a real staging session, and it happily matches a
 * leftover PRODUCTION cookie sitting in the same browser.
 */
test.describe('the session-cookie matcher tracks COOKIE_PREFIX', () => {
  const production = sessionCookieRegexFor('classmoji');
  const staging = sessionCookieRegexFor('classmoji-staging');

  test('the default prefix matches the cookie it has always matched', () => {
    expect(production.test('classmoji.session_token=abc')).toBe(true);
    expect(production.test('theme=dark; classmoji.session_token=abc')).toBe(true);
    expect('classmoji.session_token=abc.def'.match(production)?.[1]).toBe('abc.def');
  });

  test('a staging-prefixed session cookie matches under the staging prefix', () => {
    expect(staging.test('classmoji-staging.session_token=abc')).toBe(true);
    expect(staging.test('theme=dark; classmoji-staging.session_token=abc')).toBe(true);
    expect('classmoji-staging.session_token=abc.def'.match(staging)?.[1]).toBe('abc.def');
  });

  test('the __Secure- variant matches under a custom prefix too', () => {
    expect(staging.test('__Secure-classmoji-staging.session_token=abc')).toBe(true);
  });

  test('the production cookie name does NOT match under the staging prefix', () => {
    expect(staging.test('classmoji.session_token=abc')).toBe(false);
    expect(staging.test('__Secure-classmoji.session_token=abc')).toBe(false);
    // …and the reverse, so a staging cookie cannot authenticate against prod.
    expect(production.test('classmoji-staging.session_token=abc')).toBe(false);
  });

  test('the prefix is escaped, not interpreted as regex syntax', () => {
    expect(staging.test('classmojiXstaging.session_token=abc')).toBe(false);
    expect(staging.test('classmoji-stagingXsession_token=abc')).toBe(false);
  });

  test('a lookalike cookie name still cannot smuggle a session', () => {
    expect(staging.test('not-classmoji-staging.session_token=abc')).toBe(false);
    expect(staging.test('xclassmoji-staging.session_token=abc')).toBe(false);
    expect(production.test('not-classmoji.session_token=abc')).toBe(false);
  });
});

test.describe('sessionTokenFromCookieHeader', () => {
  test('reads this process’s configured prefix and nothing else', () => {
    expect(sessionTokenFromCookieHeader('classmoji.session_token=abc')).toBe('abc');
    expect(sessionTokenFromCookieHeader('classmoji-staging.session_token=abc')).toBeNull();
    expect(sessionTokenFromCookieHeader('')).toBeNull();
  });

  /**
   * End-to-end, in a process that actually boots with the staging prefix —
   * `COOKIE_PREFIX` resolves at import time, so this is the only way to
   * exercise the real module constant rather than the exported builder.
   *
   * Run from the slides workspace so it also pins that `@classmoji/auth/secret`
   * RESOLVES from here — the reason `@classmoji/auth` is now a declared
   * dependency of this app rather than an ambient hoist.
   */
  test('a staging deployment reads staging cookies and ignores production ones', () => {
    const script = [
      "const m = await import('@classmoji/auth/secret');",
      'console.log(JSON.stringify({',
      '  prefix: m.COOKIE_PREFIX,',
      "  staging: m.sessionTokenFromCookieHeader('classmoji-staging.session_token=abc'),",
      "  secure: m.sessionTokenFromCookieHeader('__Secure-classmoji-staging.session_token=abc'),",
      "  production: m.sessionTokenFromCookieHeader('classmoji.session_token=abc'),",
      '}));',
    ].join('\n');

    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        cwd: SLIDES_ROOT,
        env: { ...process.env, COOKIE_PREFIX: 'classmoji-staging' },
        encoding: 'utf-8',
      }
    );

    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toEqual({
      prefix: 'classmoji-staging',
      staging: 'abc',
      secure: 'abc',
      production: null,
    });
  });
});

test.describe('server.ts routes through the shared builder', () => {
  const source = () => fs.readFileSync(path.join(SLIDES_ROOT, 'server.ts'), 'utf-8');

  test('no hardcoded cookie name survives in the socket auth path', () => {
    // The literal this change removed. Reinstating it is invisible in
    // production (the branch it guards is dev-only) but silently breaks socket
    // auth for anyone running a non-default prefix.
    expect(source()).not.toMatch(/classmoji\\?\.session_token/);
  });

  test('the cookie header is read via @classmoji/auth/secret', () => {
    const text = source();
    expect(text).toContain("from '@classmoji/auth/secret'");
    expect(text).toContain('sessionTokenFromCookieHeader(cookieHeader)');
  });

  test('@classmoji/auth is a declared dependency, not an ambient hoist', () => {
    // server.ts imports it directly; npm workspaces hoisting made that work
    // without a declaration, which would break the moment hoisting changed.
    const pkg = JSON.parse(fs.readFileSync(path.join(SLIDES_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@classmoji/auth']).toBeTruthy();
  });
});
