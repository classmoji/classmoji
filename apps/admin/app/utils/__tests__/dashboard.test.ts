import { describe, it, expect } from 'vitest';

import {
  buildWeeklyBins,
  countByWeek,
  registrableDomain,
  collapseSchools,
  PERSONAL_EMAIL_LABEL,
  countryForDomain,
  rollupCountries,
  bucketClassSizes,
  median,
  formatHours,
  UNKNOWN_COUNTRY,
} from '../dashboard.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('buildWeeklyBins / countByWeek', () => {
  it('builds contiguous 7-day bins ending now, oldest first', () => {
    const now = new Date('2026-09-14T12:00:00Z');
    const bins = buildWeeklyBins(now, 3);
    expect(bins).toHaveLength(3);
    expect(bins[2].end).toEqual(now);
    expect(bins[0].end).toEqual(bins[1].start);
    expect(bins[1].end.getTime() - bins[1].start.getTime()).toBe(7 * DAY);
  });

  it('counts into the right bin and drops anything outside the window', () => {
    const now = new Date('2026-09-14T12:00:00Z');
    const bins = buildWeeklyBins(now, 2);
    const counts = countByWeek(
      [
        new Date(now.getTime() - 1 * DAY), // this week
        new Date(now.getTime() - 8 * DAY), // last week
        new Date(now.getTime() - 9 * DAY), // last week
        new Date(now.getTime() - 30 * DAY), // out of window
        new Date(now.getTime() + 1 * DAY), // future
      ],
      bins
    );
    expect(counts).toEqual([2, 1]);
  });
});

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
    expect(formatHours(0.4)).toBe('<1h');
    expect(formatHours(30)).toBe('30h');
    expect(formatHours(24 * 5)).toBe('5d');
    expect(formatHours(24 * 35)).toBe('5w');
  });
});
