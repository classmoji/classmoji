import { describe, it, expect, afterEach } from 'vitest';
import dayjs from 'dayjs';
import { eventFetchWindow, groupByDay, startOfWeek } from '../week';

// Node re-reads process.env.TZ whenever it is assigned, so each case can run
// the same instant under a different zone: the server's (UTC on Fly) and a
// student's (America/New_York, Asia/Tokyo).
const originalTZ = process.env.TZ;
const inZone = (tz: string) => {
  process.env.TZ = tz;
};
afterEach(() => {
  process.env.TZ = originalTZ;
});

const ymd = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');

describe('startOfWeek', () => {
  it('reproduces the reported card: Wed Sep 23 14:14 EDT is the week of Sunday Sep 20', () => {
    inZone('America/New_York');
    expect(ymd(startOfWeek(dayjs('2026-09-23T18:14:00Z')))).toBe('2026-09-20');
  });

  it('gives a different week to the server and a US browser across the Saturday/Sunday boundary', () => {
    // Sun Sep 20 02:00 UTC is still Sat Sep 19 22:00 in New York.
    const instant = '2026-09-20T02:00:00Z';
    inZone('UTC');
    expect(ymd(startOfWeek(dayjs(instant)))).toBe('2026-09-20');
    inZone('America/New_York');
    expect(ymd(startOfWeek(dayjs(instant)))).toBe('2026-09-13');
  });

  it('is ahead of the server east of UTC: Sun Sep 20 08:00 in Tokyo is still Sat in UTC', () => {
    const instant = '2026-09-19T23:00:00Z';
    inZone('UTC');
    expect(ymd(startOfWeek(dayjs(instant)))).toBe('2026-09-13');
    inZone('Asia/Tokyo');
    expect(ymd(startOfWeek(dayjs(instant)))).toBe('2026-09-20');
  });

  it("parses the loader's YYYY-MM-DD as local midnight, so the first render shows that date", () => {
    inZone('America/New_York');
    const parsed = dayjs('2026-09-20');
    expect(parsed.date()).toBe(20);
    expect(parsed.hour()).toBe(0);
  });
});

describe('eventFetchWindow', () => {
  it("covers the browser's week in every zone, whichever week that is", () => {
    // Server (UTC) instants around a week boundary, and the zones either side.
    const instants = [
      '2026-09-23T18:14:00Z', // midweek
      '2026-09-20T02:00:00Z', // UTC Sunday, still Saturday in the US
      '2026-09-19T23:00:00Z', // UTC Saturday, already Sunday in Asia
      '2026-09-26T23:30:00Z', // UTC Saturday night
    ];
    const zones = [
      'Pacific/Honolulu',
      'America/Los_Angeles',
      'America/New_York',
      'Europe/London',
      'Asia/Tokyo',
      'Pacific/Kiritimati',
    ];
    for (const instant of instants) {
      inZone('UTC');
      const { from, to } = eventFetchWindow(dayjs(instant));
      for (const tz of zones) {
        inZone(tz);
        const localStart = startOfWeek(dayjs(instant));
        const localEnd = localStart.add(7, 'day');
        expect(from.valueOf(), `${instant} in ${tz}`).toBeLessThanOrEqual(localStart.valueOf());
        expect(to.valueOf(), `${instant} in ${tz}`).toBeGreaterThanOrEqual(localEnd.valueOf());
      }
    }
  });
});

describe('groupByDay', () => {
  const ev = (id: string, start_time: string) => ({ id, start_time });

  it("buckets by the browser's calendar date and drops events outside the week", () => {
    inZone('America/New_York');
    const start = dayjs('2026-09-20');
    const grid = groupByDay(
      [
        ev('prev-sat-evening', '2026-09-20T02:00:00Z'), // Sat Sep 19 22:00 local: outside
        ev('sun-morning', '2026-09-20T14:00:00Z'), // Sun Sep 20 10:00 local
        ev('wed-2pm', '2026-09-23T18:00:00Z'), // Wed Sep 23 14:00 local
        ev('sat-late', '2026-09-27T03:30:00Z'), // Sat Sep 26 23:30 local: last column
        ev('next-sun', '2026-09-27T14:00:00Z'), // Sun Sep 27 local: outside
      ],
      start
    );
    expect(grid.map(day => day.map(e => e.id))).toEqual([
      ['sun-morning'],
      [],
      [],
      ['wed-2pm'],
      [],
      [],
      ['sat-late'],
    ]);
  });

  it('keeps a Saturday 11pm event out of the following Sunday column', () => {
    inZone('America/New_York');
    const grid = groupByDay([ev('sat-2330', '2026-09-20T03:30:00Z')], dayjs('2026-09-20'));
    expect(grid.flat()).toEqual([]);
  });

  it('sorts each day by time', () => {
    inZone('UTC');
    const grid = groupByDay(
      [ev('late', '2026-09-21T15:00:00Z'), ev('early', '2026-09-21T09:00:00Z')],
      dayjs('2026-09-20')
    );
    expect(grid[1].map(e => e.id)).toEqual(['early', 'late']);
  });
});
