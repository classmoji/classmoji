import { describe, it, expect } from 'vitest';

import {
  canToggleSiteEnabled,
  homePageNotice,
  suggestSubdomainFromSlug,
  type SitePageOption,
} from '../siteSettings.ts';

/**
 * The Website tab's three judgements. @classmoji/utils is deliberately NOT
 * mocked: the subdomain regex and the reserved registry are exactly what
 * suggestSubdomainFromSlug is asking about, and a stub would test the stub.
 */

describe('suggestSubdomainFromSlug', () => {
  it('offers a DNS-shaped slug as-is', () => {
    expect(suggestSubdomainFromSlug('dartmouth-cs52-26f')).toBe('dartmouth-cs52-26f');
  });

  it('normalizes case and surrounding space before judging it', () => {
    expect(suggestSubdomainFromSlug('  CS52  ')).toBe('cs52');
  });

  it('offers nothing for a reserved label', () => {
    // A class really can be slugged `docs`; pre-filling it would put a
    // rejection in the box before the instructor typed anything.
    expect(suggestSubdomainFromSlug('docs')).toBe('');
    expect(suggestSubdomainFromSlug('app')).toBe('');
  });

  it('offers nothing for a slug that is not a DNS label', () => {
    expect(suggestSubdomainFromSlug('cs 52')).toBe('');
    expect(suggestSubdomainFromSlug('-leading-hyphen')).toBe('');
    expect(suggestSubdomainFromSlug('trailing-hyphen-')).toBe('');
    expect(suggestSubdomainFromSlug('a'.repeat(64))).toBe('');
  });

  it('offers nothing for an absent slug', () => {
    expect(suggestSubdomainFromSlug(null)).toBe('');
    expect(suggestSubdomainFromSlug(undefined)).toBe('');
    expect(suggestSubdomainFromSlug('')).toBe('');
  });
});

describe('canToggleSiteEnabled', () => {
  it('refuses a classroom with no site row', () => {
    expect(canToggleSiteEnabled(null)).toBe(false);
  });

  it('refuses a disabled site with no home page', () => {
    expect(canToggleSiteEnabled({ is_enabled: false, home_page_id: null })).toBe(false);
  });

  it('allows a disabled site once a home page is chosen', () => {
    expect(canToggleSiteEnabled({ is_enabled: false, home_page_id: 'page-1' })).toBe(true);
  });

  it('keeps an ENABLED site operable even with no home page', () => {
    // The FK is ON DELETE SET NULL, so deleting the home page leaves exactly
    // this shape. Disabling is always permitted; locking the switch here would
    // strand a live site with no way to take it down.
    expect(canToggleSiteEnabled({ is_enabled: true, home_page_id: null })).toBe(true);
  });
});

describe('homePageNotice', () => {
  const pages: SitePageOption[] = [
    { id: 'public-1', title: 'Syllabus', is_public: true },
    { id: 'members-1', title: 'Grading policy', is_public: false },
  ];

  it('warns when the chosen home page is members-only', () => {
    expect(homePageNotice(pages, 'members-1')).toMatch(/members-only/);
  });

  it('says nothing about a public home page', () => {
    expect(homePageNotice(pages, 'public-1')).toBeNull();
  });

  it('says nothing when no home page is chosen', () => {
    expect(homePageNotice(pages, null)).toBeNull();
    expect(homePageNotice(pages, undefined)).toBeNull();
  });

  it('says nothing about a page it cannot find rather than guessing', () => {
    expect(homePageNotice(pages, 'deleted-page')).toBeNull();
  });
});
