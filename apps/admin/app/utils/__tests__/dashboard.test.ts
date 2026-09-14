import { describe, it, expect } from 'vitest';

import {
  buildWeeklyBins,
  countByWeek,
  registrableDomain,
  collapseSchools,
  PERSONAL_EMAIL_LABEL,
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
