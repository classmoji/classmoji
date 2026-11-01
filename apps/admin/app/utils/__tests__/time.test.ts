import { describe, it, expect } from 'vitest';

import {
  calendarPeriods,
  countPerPeriod,
  startOfDay,
  startOfWeek,
  formatWeekRange,
  relativeTime,
} from '../time.ts';

const TZ = 'America/New_York';

describe('startOfDay / startOfWeek', () => {
  it('is local midnight, not UTC midnight', () => {
    // 02:00 UTC on Oct 31 is still Oct 30 in New York (EDT, UTC-4).
    expect(startOfDay(new Date('2026-10-31T02:00:00Z'), TZ).toISOString()).toBe(
      '2026-10-30T04:00:00.000Z'
    );
  });

  it('starts weeks on Monday', () => {
    // Saturday Oct 31 2026 → Monday Oct 26.
    expect(startOfWeek(new Date('2026-10-31T18:00:00Z'), TZ).toISOString()).toBe(
      '2026-10-26T04:00:00.000Z'
    );
    // A Monday morning is its own week.
    expect(startOfWeek(new Date('2026-10-26T05:00:00Z'), TZ).toISOString()).toBe(
      '2026-10-26T04:00:00.000Z'
    );
  });
});

describe('calendarPeriods', () => {
  it('builds contiguous calendar days, last one partial', () => {
    const now = new Date('2026-10-31T18:05:00Z');
    const days = calendarPeriods(now, 'day', 3, TZ);
    expect(days.map(d => d.start.toISOString())).toEqual([
      '2026-10-29T04:00:00.000Z',
      '2026-10-30T04:00:00.000Z',
      '2026-10-31T04:00:00.000Z',
    ]);
    expect(days[0].end).toEqual(days[1].start);
    expect(days.map(d => d.partial)).toEqual([false, false, true]);
    // Loading a few minutes later gives the same boundaries.
    const later = calendarPeriods(new Date('2026-10-31T18:20:00Z'), 'day', 3, TZ);
    expect(later.map(d => d.start.getTime())).toEqual(days.map(d => d.start.getTime()));
  });

  it('handles the DST change: the week of Nov 1 2026 is 7 calendar days, 169 hours', () => {
    const weeks = calendarPeriods(new Date('2026-11-04T12:00:00Z'), 'week', 2, TZ);
    expect(weeks[1].start.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // EST
    expect(weeks[0].start.toISOString()).toBe('2026-10-26T04:00:00.000Z'); // EDT
    expect(weeks[0].end).toEqual(weeks[1].start);
    expect((weeks[0].end.getTime() - weeks[0].start.getTime()) / 3_600_000).toBe(169);
  });
});

describe('countPerPeriod', () => {
  it('counts half-open, drops outside, never double-counts a boundary', () => {
    const now = new Date('2026-10-31T18:00:00Z');
    const days = calendarPeriods(now, 'day', 2, TZ);
    const counts = countPerPeriod(
      [
        new Date('2026-10-30T04:00:00Z'), // exactly the first start
        new Date('2026-10-31T03:59:59Z'), // last instant of day 1 (local)
        new Date('2026-10-31T04:00:00Z'), // boundary → day 2 only
        new Date('2026-10-29T12:00:00Z'), // before the range
        new Date('2026-11-01T04:00:00Z'), // after the range
      ],
      days
    );
    expect(counts).toEqual([2, 1]);
  });
});

describe('formatting', () => {
  it('formats a week range across a month boundary', () => {
    expect(formatWeekRange('2026-10-26T04:00:00.000Z', '2026-11-02T05:00:00.000Z', TZ)).toBe(
      'Oct 26 – Nov 1'
    );
    expect(formatWeekRange('2026-10-19T04:00:00.000Z', '2026-10-26T04:00:00.000Z', TZ)).toBe(
      'Oct 19 – 25'
    );
  });

  it('relativeTime', () => {
    const now = new Date('2026-10-31T18:00:00Z');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('2026-10-31T17:58:00Z', now)).toBe('2 min');
    expect(relativeTime('2026-10-31T15:00:00Z', now)).toBe('3 hours');
    expect(relativeTime('2026-10-28T18:00:00Z', now)).toBe('3 days');
  });
});
