import { describe, it, expect } from 'vitest';

import {
  canToggleSiteEnabled,
  homePageNotice,
  suggestSubdomainFromSlug,
  timezoneOptions,
  COMMON_TIMEZONES,
  type SitePageOption,
} from '../siteSettings.ts';

/**
 * The Website tab's four judgements. @classmoji/utils is deliberately NOT
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

describe('timezoneOptions', () => {
  it('offers the curated shortlist when nothing is stored', () => {
    const options = timezoneOptions(null);
    expect(options).toHaveLength(COMMON_TIMEZONES.length);
    expect(options.map(option => option.value)).toEqual([...COMMON_TIMEZONES]);
  });

  it('leads with UTC, which is what an unset schedule falls back to', () => {
    expect(timezoneOptions(undefined)[0]).toEqual({ value: 'UTC', label: 'UTC' });
  });

  it('carries a stored zone that is not on the list', () => {
    // The reason this is a function at all. An antd Select whose value matches
    // no option renders the bare string and reads as broken — so a zone set by
    // an MCP tool, a script, or a release that trimmed this list would present
    // a working configuration as corrupt.
    const options = timezoneOptions('Antarctica/Troll');
    expect(options.map(option => option.value)).toContain('Antarctica/Troll');
    expect(options).toHaveLength(COMMON_TIMEZONES.length + 1);
  });

  it('does not duplicate a stored zone that is already on the list', () => {
    const values = timezoneOptions('America/New_York').map(option => option.value);
    expect(values.filter(value => value === 'America/New_York')).toHaveLength(1);
  });

  it('adds nothing for a blank stored value', () => {
    expect(timezoneOptions('   ')).toHaveLength(COMMON_TIMEZONES.length);
  });

  it('labels a zone by its IANA name with the underscores spaced out', () => {
    // Not a hand-written display name per zone: that is a second list to keep
    // in sync with the first, and the IANA name is what is actually stored.
    const option = timezoneOptions(null).find(entry => entry.value === 'America/New_York');
    expect(option).toEqual({ value: 'America/New_York', label: 'America/New York' });
  });

  it('offers only zones this runtime can actually format with', () => {
    // The list is not a validation boundary — upsertSiteSettings is — but an
    // option the service would reject is a control that cannot be used. This is
    // the same Intl check the service makes, run over every entry.
    for (const zone of COMMON_TIMEZONES) {
      expect(() => new Intl.DateTimeFormat(undefined, { timeZone: zone })).not.toThrow();
    }
  });

  it('offers each zone in its canonical spelling', () => {
    // A non-canonical entry (`US/Eastern`, `Asia/Calcutta`) would be stored by
    // the service as something else, and the Select would then fail to match
    // its own option against the saved value.
    for (const zone of COMMON_TIMEZONES) {
      const resolved = new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions()
        .timeZone;
      expect(resolved).toBe(zone);
    }
  });
});
