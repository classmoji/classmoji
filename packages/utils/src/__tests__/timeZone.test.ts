import { describe, expect, it } from 'vitest';
import {
  addLocalTimes,
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
