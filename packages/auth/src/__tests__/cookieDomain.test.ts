import { describe, expect, it } from 'vitest';

import { resolveCookieDomain } from '../secret.ts';

/**
 * The resolution chain, in order: explicit COOKIE_DOMAIN override → derived
 * ".{SITE_BASE_DOMAIN}" → production fallback ".classmoji.io" → null (bare
 * development, host-only cookies). One var per environment in practice;
 * the override exists to decouple the two domains if that day ever comes.
 */
describe('resolveCookieDomain', () => {
  it('derives .{SITE_BASE_DOMAIN} — the normal case for every environment', () => {
    expect(resolveCookieDomain({ SITE_BASE_DOMAIN: 'classmoji.io', NODE_ENV: 'production' })).toBe(
      '.classmoji.io'
    );
    expect(
      resolveCookieDomain({ SITE_BASE_DOMAIN: 'staging.classmoji.io', NODE_ENV: 'production' })
    ).toBe('.staging.classmoji.io');
    expect(resolveCookieDomain({ SITE_BASE_DOMAIN: 'lvh.me', NODE_ENV: 'development' })).toBe(
      '.lvh.me'
    );
  });

  it('explicit COOKIE_DOMAIN wins over the derivation', () => {
    expect(
      resolveCookieDomain({
        COOKIE_DOMAIN: '.classmoji.io',
        SITE_BASE_DOMAIN: 'classmoji.site',
        NODE_ENV: 'production',
      })
    ).toBe('.classmoji.io');
  });

  it('production with neither var set keeps the pre-feature default', () => {
    expect(resolveCookieDomain({ NODE_ENV: 'production' })).toBe('.classmoji.io');
  });

  it('development with neither var set stays host-only (null)', () => {
    expect(resolveCookieDomain({ NODE_ENV: 'development' })).toBeNull();
    expect(resolveCookieDomain({})).toBeNull();
  });

  it('empty and whitespace strings count as unset', () => {
    expect(
      resolveCookieDomain({
        COOKIE_DOMAIN: '',
        SITE_BASE_DOMAIN: 'lvh.me',
        NODE_ENV: 'development',
      })
    ).toBe('.lvh.me');
    expect(
      resolveCookieDomain({ COOKIE_DOMAIN: '  ', SITE_BASE_DOMAIN: '', NODE_ENV: 'test' })
    ).toBeNull();
  });

  it('never doubles the leading dot when SITE_BASE_DOMAIN arrives with one', () => {
    expect(resolveCookieDomain({ SITE_BASE_DOMAIN: '.classmoji.io', NODE_ENV: 'production' })).toBe(
      '.classmoji.io'
    );
  });

  it('fails CLOSED on malformed values — falls through the chain, never emits garbage', () => {
    // A scheme, a port, a path, or a single label can never become a Domain
    // attribute (browsers would drop every Set-Cookie → silent sign-in loop).
    for (const bad of [
      'https://staging.classmoji.io',
      'lvh.me:7140',
      'classmoji.io/',
      'localhost',
      'UPPER CASE NONSENSE',
    ]) {
      // Malformed SITE_BASE_DOMAIN in production → the pre-feature default.
      expect(resolveCookieDomain({ SITE_BASE_DOMAIN: bad, NODE_ENV: 'production' })).toBe(
        '.classmoji.io'
      );
      // In development → host-only, logins keep working.
      expect(resolveCookieDomain({ SITE_BASE_DOMAIN: bad, NODE_ENV: 'development' })).toBeNull();
    }
    // A malformed OVERRIDE falls through to a valid derivation.
    expect(
      resolveCookieDomain({
        COOKIE_DOMAIN: 'http://bad',
        SITE_BASE_DOMAIN: 'lvh.me',
        NODE_ENV: 'development',
      })
    ).toBe('.lvh.me');
  });

  it('normalizes case', () => {
    expect(
      resolveCookieDomain({ SITE_BASE_DOMAIN: 'Staging.Classmoji.IO', NODE_ENV: 'test' })
    ).toBe('.staging.classmoji.io');
  });
});
