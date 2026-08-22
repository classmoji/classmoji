import { describe, it, expect, vi, afterEach } from 'vitest';

import { signSiteReturnToken } from '@classmoji/auth/site-return';

import {
  planSiteReturn,
  resolveSiteDestination,
  resolveSiteOrigin,
  MAX_RETURN_PATH_LENGTH,
  type SiteReturnEnv,
} from '../siteReturn.ts';

/**
 * The /site-return decision matrix. The loader itself is glue over these two
 * functions, so this is where the flow's security properties are pinned:
 *  - an unverified token never causes a sign-in bounce,
 *  - a disabled (or vanished) site never produces a redirect,
 *  - the destination is always {https|http}://{label}.{base domain} and nothing
 *    an attacker can steer.
 */

const CLASSROOM_ID = '3f7b1a2c-0000-4a00-8000-abcdefabcdef';
const BACKSLASH = String.fromCharCode(0x5c);

const DEV_ENV: SiteReturnEnv = {
  SITE_BASE_DOMAIN: 'lvh.me',
  PAGES_URL: 'http://localhost:7140',
  NODE_ENV: 'development',
};

const PROD_ENV: SiteReturnEnv = {
  SITE_BASE_DOMAIN: 'classmoji.io',
  PAGES_URL: 'https://pages.classmoji.io',
  NODE_ENV: 'production',
};

const enabledSite = { subdomain: 'cs52', is_enabled: true };

afterEach(() => {
  vi.useRealTimers();
});

describe('planSiteReturn', () => {
  it('sends a signed-in visitor to the site lookup', () => {
    const token = signSiteReturnToken({ classroomId: CLASSROOM_ID, path: '/syllabus' });
    expect(planSiteReturn(token, true)).toEqual({
      action: 'lookup',
      classroomId: CLASSROOM_ID,
      path: '/syllabus',
    });
  });

  it('bounces a signed-out visitor through the landing page, carrying the token', () => {
    const token = signSiteReturnToken({ classroomId: CLASSROOM_ID, path: '/syllabus' });
    const plan = planSiteReturn(token, false);

    expect(plan.action).toBe('sign-in');
    if (plan.action !== 'sign-in') throw new Error('unreachable');

    // A RELATIVE path, and the landing page must be able to decode it back to
    // exactly this route with exactly this token.
    expect(plan.redirectTo.startsWith('/?redirect=')).toBe(true);
    const decoded = decodeURIComponent(plan.redirectTo.slice('/?redirect='.length));
    expect(decoded).toBe(`/site-return?token=${token}`);
    expect(new URLSearchParams(decoded.split('?')[1]).get('token')).toBe(token);
  });

  it('rejects a bad token BEFORE deciding anything about the session', () => {
    // The ordering matters: a signed-out visitor must never be walked through
    // an OAuth round trip on the strength of a link we cannot vouch for.
    for (const signedIn of [true, false]) {
      expect(planSiteReturn(null, signedIn)).toEqual({ action: 'invalid-token' });
      expect(planSiteReturn('', signedIn)).toEqual({ action: 'invalid-token' });
      expect(planSiteReturn('garbage', signedIn)).toEqual({ action: 'invalid-token' });
      expect(planSiteReturn('AAAA.BBBB', signedIn)).toEqual({ action: 'invalid-token' });
    }
  });

  it('rejects a tampered token', () => {
    const token = signSiteReturnToken({ classroomId: CLASSROOM_ID, path: '/ok' });
    const at = token.indexOf('.');
    const flipped =
      token.slice(0, 3) + (token[3] === 'A' ? 'B' : 'A') + token.slice(4, at) + token.slice(at);
    expect(planSiteReturn(flipped, true)).toEqual({ action: 'invalid-token' });
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const token = signSiteReturnToken({ classroomId: CLASSROOM_ID, path: '/ok' });

    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(planSiteReturn(token, true)).toEqual({ action: 'invalid-token' });
    expect(planSiteReturn(token, false)).toEqual({ action: 'invalid-token' });
  });

  it('keeps the sign-in bounce inside the landing page length bound', () => {
    const maxPath = '/' + 'a'.repeat(511);
    const token = signSiteReturnToken({ classroomId: CLASSROOM_ID, path: maxPath });
    const plan = planSiteReturn(token, false);

    expect(plan.action).toBe('sign-in');
    if (plan.action !== 'sign-in') throw new Error('unreachable');
    const returnTo = decodeURIComponent(plan.redirectTo.slice('/?redirect='.length));
    expect(returnTo.length).toBeLessThanOrEqual(MAX_RETURN_PATH_LENGTH);
  });
});

describe('resolveSiteOrigin', () => {
  it('is https with no port in production', () => {
    expect(resolveSiteOrigin('cs52', PROD_ENV)).toBe('https://cs52.classmoji.io');
  });

  it('carries the pages port in development', () => {
    expect(resolveSiteOrigin('cs52', DEV_ENV)).toBe('http://cs52.lvh.me:7140');
  });

  it('drops the port when PAGES_URL has none, or cannot be parsed', () => {
    expect(resolveSiteOrigin('cs52', { ...DEV_ENV, PAGES_URL: 'http://localhost' })).toBe(
      'http://cs52.lvh.me'
    );
    expect(resolveSiteOrigin('cs52', { ...DEV_ENV, PAGES_URL: 'not a url' })).toBe(
      'http://cs52.lvh.me'
    );
    expect(resolveSiteOrigin('cs52', { ...DEV_ENV, PAGES_URL: undefined })).toBe(
      'http://cs52.lvh.me'
    );
  });

  it('normalizes the stored label', () => {
    expect(resolveSiteOrigin('  CS52  ', PROD_ENV)).toBe('https://cs52.classmoji.io');
  });

  it('fails closed when SITE_BASE_DOMAIN is unset or malformed', () => {
    // Unset is the pre-launch state of every environment: it must not produce
    // `https://cs52.undefined`.
    expect(resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: undefined })).toBeNull();
    expect(resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: '' })).toBeNull();
    expect(resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: '   ' })).toBeNull();
    expect(resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: 'localhost' })).toBeNull();
    expect(
      resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: 'https://classmoji.io' })
    ).toBeNull();
    expect(
      resolveSiteOrigin('cs52', { ...PROD_ENV, SITE_BASE_DOMAIN: 'evil.com/classmoji.io' })
    ).toBeNull();
  });

  it('fails closed on a subdomain that is not a DNS label', () => {
    // Defense in depth — the column has a CHECK constraint, but this value is
    // one string concatenation away from a Location header.
    for (const label of [
      '',
      'not a label',
      'evil.com/',
      'a.b',
      'sub' + BACKSLASH + 'evil',
      '-leading',
      'x'.repeat(64),
    ]) {
      expect(resolveSiteOrigin(label, PROD_ENV)).toBeNull();
    }
  });
});

describe('resolveSiteDestination', () => {
  it('returns the visitor to the site they came from', () => {
    expect(resolveSiteDestination(enabledSite, '/syllabus', PROD_ENV)).toEqual({
      action: 'return',
      url: 'https://cs52.classmoji.io/syllabus',
    });
    expect(resolveSiteDestination(enabledSite, '/', DEV_ENV)).toEqual({
      action: 'return',
      url: 'http://cs52.lvh.me:7140/',
    });
  });

  it('preserves query strings and encoding in the path', () => {
    expect(resolveSiteDestination(enabledSite, '/notes/week%201?tab=a', PROD_ENV)).toEqual({
      action: 'return',
      url: 'https://cs52.classmoji.io/notes/week%201?tab=a',
    });
  });

  it('refuses when the site row is gone or switched off', () => {
    expect(resolveSiteDestination(null, '/', PROD_ENV)).toEqual({ action: 'site-unavailable' });
    expect(resolveSiteDestination({ subdomain: 'cs52', is_enabled: false }, '/', PROD_ENV)).toEqual(
      { action: 'site-unavailable' }
    );
  });

  it('refuses when the platform has no site base domain configured', () => {
    expect(
      resolveSiteDestination(enabledSite, '/', { ...PROD_ENV, SITE_BASE_DOMAIN: undefined })
    ).toEqual({ action: 'site-unavailable' });
  });

  it('refuses an unsafe path at the sink, even though the token carried it', () => {
    for (const path of ['//evil.com', '/' + BACKSLASH + 'evil.com', 'https://evil.com', '']) {
      expect(resolveSiteDestination(enabledSite, path, PROD_ENV)).toEqual({
        action: 'site-unavailable',
      });
    }
  });
});
