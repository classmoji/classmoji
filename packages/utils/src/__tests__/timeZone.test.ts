import { describe, expect, it } from 'vitest';
import {
  localTimeParts,
  zonedWallClockToInstant,
  addLocalTimes,
  canonicalTimeZone,
  isRealCalendarDate,
  listTimeZones,
  resolveEffectiveTimeZone,
  formatLocalDateTime,
  formatNowContext,
  localDayRange,
  localMonthGridRange,
  resolveTimeZone,
} from '../timeZone.ts';

const NY = 'America/New_York';

describe('formatLocalDateTime', () => {
  // The five deadlines Ask Moji misreported in CS52 26F, rendered the way a
  // student in New York should have been told them.
  it.each([
    ['2026-09-16T18:00:00.000Z', 'Wed Sep 16, 2026, 2:00 PM EDT'], // not "6:00 PM", not Monday
    ['2026-09-21T03:59:00.000Z', 'Sun Sep 20, 2026, 11:59 PM EDT'], // not "Sep 21 at 3:59 AM"
    ['2026-09-28T03:59:00.000Z', 'Sun Sep 27, 2026, 11:59 PM EDT'], // not "Sunday Sept 28"
    ['2026-09-25T03:59:00.000Z', 'Thu Sep 24, 2026, 11:59 PM EDT'], // closes TONIGHT, not tomorrow
  ])('renders %s as %s', (iso, expected) => {
    expect(formatLocalDateTime(iso, NY)).toBe(expected);
  });

  it('crosses the UTC/local date boundary the right way', () => {
    // 00:30Z on the 17th is still the evening of the 16th in New York...
    expect(formatLocalDateTime('2026-09-17T00:30:00Z', NY)).toBe('Wed Sep 16, 2026, 8:30 PM EDT');
    // ...and 04:00Z is the first minute of the 17th.
    expect(formatLocalDateTime('2026-09-17T04:00:00Z', NY)).toBe('Thu Sep 17, 2026, 12:00 AM EDT');
  });

  it('follows the end of US daylight time (Sun Nov 1 2026)', () => {
    // 11:59 PM the night before the change is still EDT (UTC-4)...
    expect(formatLocalDateTime('2026-11-01T03:59:00Z', NY)).toBe('Sat Oct 31, 2026, 11:59 PM EDT');
    // ...the same local wall-clock a day later is EST (UTC-5), so it is 04:59Z.
    expect(formatLocalDateTime('2026-11-02T04:59:00Z', NY)).toBe('Sun Nov 1, 2026, 11:59 PM EST');
    // The repeated 1 AM hour: first pass EDT, second pass EST.
    expect(formatLocalDateTime('2026-11-01T05:30:00Z', NY)).toBe('Sun Nov 1, 2026, 1:30 AM EDT');
    expect(formatLocalDateTime('2026-11-01T06:30:00Z', NY)).toBe('Sun Nov 1, 2026, 1:30 AM EST');
  });

  it('accepts a Date', () => {
    expect(formatLocalDateTime(new Date('2026-09-16T18:00:00Z'), NY)).toBe(
      'Wed Sep 16, 2026, 2:00 PM EDT'
    );
  });

  it('falls back to a labelled UTC time with no zone, or a bad one', () => {
    expect(formatLocalDateTime('2026-09-21T03:59:00Z', null)).toBe('Mon Sep 21, 2026, 3:59 AM UTC');
    expect(formatLocalDateTime('2026-09-21T03:59:00Z', 'Not/AZone')).toBe(
      'Mon Sep 21, 2026, 3:59 AM UTC'
    );
  });

  it('returns null for nothing or garbage', () => {
    expect(formatLocalDateTime(null, NY)).toBeNull();
    expect(formatLocalDateTime('', NY)).toBeNull();
    expect(formatLocalDateTime('not a date', NY)).toBeNull();
  });
});

describe('resolveTimeZone', () => {
  it('canonicalises the spelling and flags the fallback', () => {
    expect(resolveTimeZone('america/new_york')).toEqual({ timeZone: NY, isFallback: false });
    expect(resolveTimeZone(null)).toEqual({ timeZone: 'UTC', isFallback: true });
    expect(resolveTimeZone('  ')).toEqual({ timeZone: 'UTC', isFallback: true });
    expect(resolveTimeZone('Mars/Olympus')).toEqual({ timeZone: 'UTC', isFallback: true });
  });
});

describe('formatNowContext', () => {
  it('gives weekday, date, time, abbreviation and zone for a fixed clock', () => {
    // Sep 24 2026, 11:20 AM in New York is 15:20Z.
    const now = new Date('2026-09-24T15:20:00Z');
    expect(formatNowContext(now, NY)).toBe(
      'Thursday, September 24, 2026, 11:20 AM EDT (America/New_York)'
    );
  });

  it('is on the local date when UTC has already rolled over', () => {
    // 8 PM EDT on Sep 15 is already Sep 16 in UTC - the "due tonight" trap.
    expect(formatNowContext(new Date('2026-09-16T00:00:00Z'), NY)).toBe(
      'Tuesday, September 15, 2026, 8:00 PM EDT (America/New_York)'
    );
  });

  it('says so when the course has no zone', () => {
    expect(formatNowContext(new Date('2026-09-24T15:20:00Z'), null)).toBe(
      'Thursday, September 24, 2026, 3:20 PM UTC (UTC; this course has not set a time zone)'
    );
  });
});

describe('localDayRange', () => {
  it('covers whole local days, so a Sunday 11:59 PM deadline is inside the week', () => {
    const range = localDayRange('2026-09-21', '2026-09-27', NY)!;
    expect(range.start.toISOString()).toBe('2026-09-21T04:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-28T03:59:59.999Z');
    const lab2 = new Date('2026-09-28T03:59:00Z'); // Sun Sep 27 11:59 PM EDT
    expect(lab2 >= range.start && lab2 <= range.end).toBe(true);
  });

  it('spans the DST change with the right offsets at each end', () => {
    const range = localDayRange('2026-10-31', '2026-11-01', NY)!;
    expect(range.start.toISOString()).toBe('2026-10-31T04:00:00.000Z'); // EDT midnight
    expect(range.end.toISOString()).toBe('2026-11-02T04:59:59.999Z'); // EST end of day
  });

  it('is plain UTC days without a zone', () => {
    const range = localDayRange('2026-09-21', '2026-09-27', null)!;
    expect(range.start.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-27T23:59:59.999Z');
  });

  it('refuses malformed or reversed input', () => {
    expect(localDayRange('2026-9-21', '2026-09-27', NY)).toBeNull();
    expect(localDayRange('2026-09-27', '2026-09-21', NY)).toBeNull();
  });
});

describe('localMonthGridRange', () => {
  it('uses the local month on the last evening of a month', () => {
    // Sep 30 2026, 10 PM EDT is Oct 1 in UTC; the window is still September's.
    const range = localMonthGridRange(new Date('2026-10-01T02:00:00Z'), NY);
    // Sep 1 2026 is a Tuesday: grid starts Sun Aug 30, minus one day = Sat Aug 29.
    expect(range.start.toISOString()).toBe('2026-08-29T04:00:00.000Z');
    // Sep 30 is a Wednesday: grid ends Sat Oct 3, plus one day = Sun Oct 4.
    expect(range.end.toISOString()).toBe('2026-10-05T03:59:59.999Z');
  });
});

describe('addLocalTimes', () => {
  it('adds a sibling for every timestamp, and nothing else changes', () => {
    const payload = {
      title: 'Lab2',
      student_deadline: '2026-09-28T03:59:00.000Z',
      nested: [{ closes_at: '2026-09-25T03:59:00.000Z', note: 'x' }],
      count: 3,
      none: null,
    };
    const { value, count } = addLocalTimes(payload, NY);
    expect(count).toBe(2);
    expect(value).toEqual({
      title: 'Lab2',
      student_deadline: '2026-09-28T03:59:00.000Z',
      student_deadline_local: 'Sun Sep 27, 2026, 11:59 PM EDT',
      nested: [
        {
          closes_at: '2026-09-25T03:59:00.000Z',
          closes_at_local: 'Thu Sep 24, 2026, 11:59 PM EDT',
          note: 'x',
        },
      ],
      count: 3,
      none: null,
    });
    // The local key sits right after its source key.
    expect(Object.keys(value)).toEqual([
      'title',
      'student_deadline',
      'student_deadline_local',
      'nested',
      'count',
      'none',
    ]);
    // The input is not mutated.
    expect('student_deadline_local' in payload).toBe(false);
  });

  it('handles Date values and leaves them as Dates', () => {
    const due = new Date('2026-09-16T18:00:00Z');
    const { value } = addLocalTimes({ due_date: due }, NY);
    expect(value).toEqual({ due_date: due, due_date_local: 'Wed Sep 16, 2026, 2:00 PM EDT' });
  });

  it('never shifts a date-only value or a bare YYYY-MM-DD', () => {
    const { value, count } = addLocalTimes(
      { occurrence_date: '2026-09-16T00:00:00.000Z', recurrence_rule: { until: '2026-12-01' } },
      NY
    );
    expect(count).toBe(0);
    expect(value).toEqual({
      occurrence_date: '2026-09-16T00:00:00.000Z',
      recurrence_rule: { until: '2026-12-01' },
    });
  });

  it('does not overwrite an existing _local field', () => {
    const { value, count } = addLocalTimes(
      { closes_at: '2026-09-25T03:59:00Z', closes_at_local: 'already here' },
      NY
    );
    expect(count).toBe(0);
    expect(value).toEqual({ closes_at: '2026-09-25T03:59:00Z', closes_at_local: 'already here' });
  });

  it('ignores prose that merely contains a timestamp', () => {
    const { count } = addLocalTimes({ text: 'due 2026-09-25T03:59:00Z sharp' }, NY);
    expect(count).toBe(0);
  });
});

describe('canonicalTimeZone', () => {
  it('returns the canonical spelling for real zones and aliases', () => {
    expect(canonicalTimeZone('America/New_York')).toBe(NY);
    expect(canonicalTimeZone(' america/new_york ')).toBe(NY);
    expect(canonicalTimeZone('UTC')).toBe('UTC');
  });

  it('refuses junk, oversized and injection-shaped values', () => {
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
    expect(canonicalTimeZone(null)).toBeNull();
    expect(canonicalTimeZone(42)).toBeNull();
    expect(canonicalTimeZone('America/New_York\r\nX-Evil: 1')).toBeNull();
    expect(canonicalTimeZone('A'.repeat(65))).toBeNull();
  });
});

describe('resolveEffectiveTimeZone - classroom, then caller, then UTC', () => {
  it('prefers the classroom zone over the caller', () => {
    expect(resolveEffectiveTimeZone(NY, 'Europe/Paris')).toEqual({
      timeZone: NY,
      source: 'classroom',
    });
  });

  it('uses the caller zone when the classroom has none', () => {
    expect(resolveEffectiveTimeZone(null, 'Europe/Paris')).toEqual({
      timeZone: 'Europe/Paris',
      source: 'caller',
    });
  });

  it('skips an invalid classroom zone as if it were unset', () => {
    expect(resolveEffectiveTimeZone('Not/AZone', 'Europe/Paris').source).toBe('caller');
  });

  it('ignores an invalid caller zone and lands on labelled UTC', () => {
    expect(resolveEffectiveTimeZone(null, 'Not/AZone')).toEqual({
      timeZone: 'UTC',
      source: 'default',
    });
    expect(resolveEffectiveTimeZone(undefined)).toEqual({ timeZone: 'UTC', source: 'default' });
  });
});

describe('listTimeZones', () => {
  it('leads with UTC and holds only canonical spellings a save would keep', () => {
    const zones = listTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain(NY);
    expect(zones.length).toBeGreaterThan(300);
    for (const zone of zones) expect(canonicalTimeZone(zone)).toBe(zone);
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('addLocalTimes include filter', () => {
  it('renders only the keys the filter allows', () => {
    const { value, count } = addLocalTimes(
      { closes_at: '2026-09-25T03:59:00Z', created_at: '2026-09-01T12:00:00Z' },
      NY,
      { include: key => key !== 'created_at' }
    );
    expect(count).toBe(1);
    expect(value).toEqual({
      closes_at: '2026-09-25T03:59:00Z',
      closes_at_local: 'Thu Sep 24, 2026, 11:59 PM EDT',
      created_at: '2026-09-01T12:00:00Z',
    });
  });
});

describe('impossible dates', () => {
  it('refuses a date that does not exist instead of rolling it over', () => {
    expect(localDayRange('2026-02-30', '2026-03-05', NY)).toBeNull();
    expect(localDayRange('2026-02-01', '2026-13-01', NY)).toBeNull();
    expect(isRealCalendarDate('2026-02-28')).toBe(true);
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isRealCalendarDate('2026-02-29')).toBe(false);
  });
});

describe('days in zones whose DST changes AT midnight', () => {
  it('starts Santiago spring-forward day at the first instant that is actually that day', () => {
    // 2026-09-06: 23:59 -04 on the 5th is followed by 01:00 -03 on the 6th.
    const range = localDayRange('2026-09-06', '2026-09-06', 'America/Santiago')!;
    expect(range.start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(formatLocalDateTime(range.start, 'America/Santiago')).toBe(
      'Sun Sep 6, 2026, 1:00 AM GMT-3'
    );
    // ...and the day before ends one millisecond earlier, not an hour late.
    const before = localDayRange('2026-09-05', '2026-09-05', 'America/Santiago')!;
    expect(before.end.toISOString()).toBe('2026-09-06T03:59:59.999Z');
  });

  it('does the same for Havana (2026-03-08)', () => {
    const range = localDayRange('2026-03-08', '2026-03-08', 'America/Havana')!;
    expect(range.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('starts a fall-back day at its one real midnight', () => {
    // Santiago 2026-04-05: at 00:00 -03 the clock returns to 23:00 -04 on the
    // 4th, so the 5th begins at 00:00 -04 = 04:00Z.
    const range = localDayRange('2026-04-05', '2026-04-05', 'America/Santiago')!;
    expect(range.start.toISOString()).toBe('2026-04-05T04:00:00.000Z');
  });
});

describe('localTimeParts', () => {
  it('reads the wall clock of an instant in the zone', () => {
    // 18:10Z is 14:10 in New York during daylight time, 13:10 after the change.
    expect(localTimeParts(new Date('2026-09-14T18:10:00Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 9,
      day: 14,
      hour: 14,
      minute: 10,
      weekday: 1,
    });
    expect(localTimeParts(new Date('2026-11-02T18:10:00Z'), 'America/New_York')).toMatchObject({
      hour: 13,
      minute: 10,
    });
  });

  it('reads midnight as hour 0, not 24', () => {
    expect(localTimeParts(new Date('2026-09-14T04:00:00Z'), 'America/New_York')).toMatchObject({
      day: 14,
      hour: 0,
    });
  });

  it('is UTC when no zone is set', () => {
    expect(localTimeParts(new Date('2026-09-14T18:10:00Z'), null)).toMatchObject({
      hour: 18,
      minute: 10,
    });
  });
});

describe('zonedWallClockToInstant', () => {
  const nyClass = (month: number, day: number) =>
    zonedWallClockToInstant(2026, month, day, 14, 10, 'America/New_York').toISOString();

  it('keeps a 14:10 class at 14:10 across the end of daylight saving (Nov 1, 2026)', () => {
    expect(nyClass(9, 14)).toBe('2026-09-14T18:10:00.000Z');
    expect(nyClass(10, 30)).toBe('2026-10-30T18:10:00.000Z');
    expect(nyClass(11, 2)).toBe('2026-11-02T19:10:00.000Z');
    expect(nyClass(11, 16)).toBe('2026-11-16T19:10:00.000Z');
  });

  it('keeps it across the start of daylight saving (Mar 8, 2026)', () => {
    expect(nyClass(3, 6)).toBe('2026-03-06T19:10:00.000Z');
    expect(nyClass(3, 9)).toBe('2026-03-09T18:10:00.000Z');
  });

  it('reads a time the clock skips with the offset from before the change', () => {
    // 02:30 does not exist on Mar 8, 2026 in New York; it lands at 03:30 EDT.
    const instant = zonedWallClockToInstant(2026, 3, 8, 2, 30, 'America/New_York');
    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(localTimeParts(instant, 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
  });

  it('takes the first of a time the clock repeats', () => {
    // 01:30 happens twice on Nov 1, 2026; the first is still daylight time.
    expect(zonedWallClockToInstant(2026, 11, 1, 1, 30, 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z'
    );
  });

  it('rolls an overflowing day over like Date.UTC', () => {
    expect(zonedWallClockToInstant(2026, 10, 32, 12, 0, 'UTC').toISOString()).toBe(
      '2026-11-01T12:00:00.000Z'
    );
  });

  it('is plain UTC when no zone is set', () => {
    expect(zonedWallClockToInstant(2026, 11, 2, 14, 10, null).toISOString()).toBe(
      '2026-11-02T14:10:00.000Z'
    );
  });

  it('round-trips with localTimeParts across a year of days', () => {
    for (let day = 0; day < 365; day += 1) {
      const probe = new Date(Date.UTC(2026, 0, 1 + day));
      const instant = zonedWallClockToInstant(
        probe.getUTCFullYear(),
        probe.getUTCMonth() + 1,
        probe.getUTCDate(),
        14,
        10,
        'America/New_York'
      );
      expect(localTimeParts(instant, 'America/New_York')).toMatchObject({
        year: probe.getUTCFullYear(),
        month: probe.getUTCMonth() + 1,
        day: probe.getUTCDate(),
        hour: 14,
        minute: 10,
      });
    }
  });
});
