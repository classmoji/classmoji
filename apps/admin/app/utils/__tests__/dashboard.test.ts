import { describe, it, expect } from 'vitest';

import {
  registrableDomain,
  collapseSchools,
  PERSONAL_EMAIL_LABEL,
  OTHER_DOMAINS_LABEL,
  countryForDomain,
  rollupCountries,
  bucketClassSizes,
  median,
  formatHours,
  UNKNOWN_COUNTRY,
} from '../dashboard.ts';

describe('registrableDomain', () => {
  it('collapses subdomains to the institution', () => {
    expect(registrableDomain('ift.ulaval.ca')).toBe('ulaval.ca');
    expect(registrableDomain('dali.dartmouth.edu')).toBe('dartmouth.edu');
    expect(registrableDomain('Dartmouth.EDU')).toBe('dartmouth.edu');
  });

  it('keeps three labels for two-letter TLDs with a public second label', () => {
    expect(registrableDomain('cs.ox.ac.uk')).toBe('ox.ac.uk');
    expect(registrableDomain('ox.ac.uk')).toBe('ox.ac.uk');
    expect(registrableDomain('mail.example.co.jp')).toBe('example.co.jp');
  });

  it('keeps US school districts apart instead of collapsing them to "ca.us"', () => {
    expect(registrableDomain('lausd.k12.ca.us')).toBe('lausd.k12.ca.us');
    expect(registrableDomain('mail.sfusd.k12.ca.us')).toBe('sfusd.k12.ca.us');
    expect(registrableDomain('ci.boston.ma.us')).toBe('boston.ma.us');
  });
});

describe('collapseSchools', () => {
  it('merges subdomains, sorts by users, caps, and folds mailbox providers last', () => {
    const rows = collapseSchools(
      [
        { domain: 'ift.ulaval.ca', users: 30, instructors: 2 },
        { domain: 'ulaval.ca', users: 20, instructors: 1 },
        { domain: 'dartmouth.edu', users: 40, instructors: 3 },
        { domain: 'gmail.com', users: 9, instructors: 1 },
        { domain: 'outlook.com', users: 1, instructors: 0 },
        { domain: 'small.edu', users: 1, instructors: 1 },
      ],
      2
    );
    expect(rows).toEqual([
      { school: 'ulaval.ca', users: 50, instructors: 3 },
      { school: 'dartmouth.edu', users: 40, instructors: 3 },
      { school: OTHER_DOMAINS_LABEL, users: 1, instructors: 1 },
      { school: PERSONAL_EMAIL_LABEL, users: 10, instructors: 1 },
    ]);
  });

  it('omits the personal row when there are no mailbox providers', () => {
    expect(collapseSchools([{ domain: 'x.edu', users: 1, instructors: 0 }], 5)).toEqual([
      { school: 'x.edu', users: 1, instructors: 0 },
    ]);
  });
});

describe('countryForDomain / rollupCountries', () => {
  it('reads the country off the TLD, treats .edu as US, and shrugs at .com', () => {
    expect(countryForDomain('ulaval.ca')).toBe('Canada');
    expect(countryForDomain('ox.ac.uk')).toBe('United Kingdom');
    expect(countryForDomain('dartmouth.edu')).toBe('United States');
    expect(countryForDomain('example.com')).toBe(UNKNOWN_COUNTRY);
    expect(countryForDomain('school.xx')).toBe('XX');
  });

  it('rolls schools up by country, drops mailbox providers, keeps Unknown last', () => {
    expect(
      rollupCountries([
        { domain: 'ift.ulaval.ca', users: 30, instructors: 2 },
        { domain: 'mcgill.ca', users: 5, instructors: 1 },
        { domain: 'dartmouth.edu', users: 40, instructors: 3 },
        { domain: 'gmail.com', users: 99, instructors: 9 },
        { domain: 'startup.com', users: 1, instructors: 0 },
      ])
    ).toEqual([
      { country: 'United States', users: 40, instructors: 3 },
      { country: 'Canada', users: 35, instructors: 3 },
      { country: UNKNOWN_COUNTRY, users: 1, instructors: 0 },
    ]);
  });
});

describe('bucketClassSizes / median / formatHours', () => {
  it('buckets sizes on the documented edges', () => {
    expect(bucketClassSizes([0, 1, 10, 11, 30, 31, 100, 101, 500])).toEqual([1, 2, 2, 2, 2]);
  });

  it('computes medians and formats durations', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(formatHours(null)).toBe('—');
    expect(formatHours(-3)).toBe('—');
    expect(formatHours(0.4)).toBe('<1h');
    expect(formatHours(30)).toBe('30h');
    expect(formatHours(24 * 5)).toBe('5d');
    expect(formatHours(24 * 35)).toBe('5w');
  });
});
