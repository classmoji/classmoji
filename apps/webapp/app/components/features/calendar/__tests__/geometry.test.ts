import { describe, expect, it } from 'vitest';
import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  HOUR_FLOOR,
  HOUR_HEIGHT_REM,
  META_ROW_MIN_HOURS,
  MIN_DURATION_HOURS,
  fitsMetaRow,
  formatHourLabel,
  heightForDuration,
  hourLabelParts,
  hoursInWindow,
  isOutsideWindow,
  isTightBlock,
  monthDropId,
  parseDropId,
  remForHours,
  topForHour,
  weekDropId,
} from '../geometry';

describe('window constants', () => {
  it('describes the window both grids render today: 8 AM…10 PM, 15 rows', () => {
    expect(DEFAULT_START_HOUR).toBe(8);
    // Exclusive end, so the last rendered row is 22 (10 PM).
    expect(DEFAULT_END_HOUR).toBe(23);
    const hours = hoursInWindow();
    expect(hours).toHaveLength(15);
    expect(hours[0]).toBe(8);
    expect(hours[hours.length - 1]).toBe(22);
    expect(formatHourLabel(hours[0])).toBe('8 AM');
    expect(formatHourLabel(hours[hours.length - 1])).toBe('10 PM');
  });

  it('keeps one minimum-duration clamp and one row height', () => {
    // 0.75h, not 0.5h: a block draws a title line and a time line, and the
    // student block subtracts another 4px, so 0.5h clipped its own content.
    expect(MIN_DURATION_HOURS).toBe(0.75);
    expect(HOUR_HEIGHT_REM).toBe(4);
    expect(HOUR_FLOOR).toBe(6);
  });
});

describe('hoursInWindow', () => {
  it('is inclusive of the start and exclusive of the end', () => {
    expect(hoursInWindow(9, 12)).toEqual([9, 10, 11]);
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(hoursInWindow(9, 9)).toEqual([]);
    expect(hoursInWindow(12, 9)).toEqual([]);
  });

  it('can span the whole day', () => {
    expect(hoursInWindow(0, 24)).toHaveLength(24);
  });
});

describe('remForHours / topForHour / heightForDuration', () => {
  it('measures in rem, not px', () => {
    expect(remForHours(1)).toBe('4rem');
    expect(remForHours(0)).toBe('0rem');
    expect(remForHours(15)).toBe('60rem');
  });

  it('offsets a clock hour from the top of the window', () => {
    expect(topForHour(8)).toBe('0rem');
    expect(topForHour(9)).toBe('4rem');
    expect(topForHour(14.5)).toBe('26rem');
  });

  it('honours a non-default window start', () => {
    expect(topForHour(6, 6)).toBe('0rem');
    expect(topForHour(8, 6)).toBe('8rem');
  });

  it('goes negative above the window rather than clamping', () => {
    // Callers gate visibility themselves; silently clamping would stack
    // out-of-window events on the first row.
    expect(topForHour(7)).toBe('-4rem');
  });

  it('clamps a short block to the minimum duration', () => {
    expect(heightForDuration(1)).toBe('4rem');
    expect(heightForDuration(1.5)).toBe('6rem');
    expect(heightForDuration(0.75)).toBe('3rem');
    // A half-hour event is drawn at the 0.75h minimum, in both views.
    expect(heightForDuration(0.5)).toBe('3rem');
    expect(heightForDuration(0.25)).toBe('3rem');
    expect(heightForDuration(0)).toBe('3rem');
    expect(heightForDuration(-3)).toBe('3rem');
  });
});

describe('hourLabelParts / formatHourLabel', () => {
  it('prints 12 AM for midnight and for hour 24, never 0 AM', () => {
    expect(formatHourLabel(0)).toBe('12 AM');
    expect(formatHourLabel(24)).toBe('12 AM');
    expect(hourLabelParts(0)).toEqual({ hour: 12, suffix: 'AM' });
    expect(hourLabelParts(24)).toEqual({ hour: 12, suffix: 'AM' });
  });

  it('prints noon as 12 PM', () => {
    expect(formatHourLabel(12)).toBe('12 PM');
    expect(hourLabelParts(12)).toEqual({ hour: 12, suffix: 'PM' });
  });

  it('prints morning and evening hours', () => {
    expect(formatHourLabel(1)).toBe('1 AM');
    expect(formatHourLabel(8)).toBe('8 AM');
    expect(formatHourLabel(11)).toBe('11 AM');
    expect(formatHourLabel(13)).toBe('1 PM');
    expect(formatHourLabel(22)).toBe('10 PM');
    expect(formatHourLabel(23)).toBe('11 PM');
  });

  it('truncates a fractional hour to the hour it sits in', () => {
    expect(formatHourLabel(13.75)).toBe('1 PM');
  });

  it('wraps hours outside a single day', () => {
    expect(formatHourLabel(25)).toBe('1 AM');
    expect(formatHourLabel(-1)).toBe('11 PM');
  });
});

describe('droppable ids', () => {
  // Local time, deliberately: the grid is drawn in the browser's timezone, and
  // a UTC-based key would put an evening event on the wrong day west of GMT.
  const jan5 = new Date(2026, 0, 5, 23, 30);
  const dec31 = new Date(2025, 11, 31, 0, 0);

  it('builds month ids as month-YYYY-MM-DD with zero padding', () => {
    expect(monthDropId(jan5)).toBe('month-2026-01-05');
    expect(monthDropId(dec31)).toBe('month-2025-12-31');
  });

  it('builds week ids as week-YYYY-MM-DD-HH with the ABSOLUTE clock hour', () => {
    expect(weekDropId(jan5, 8)).toBe('week-2026-01-05-08');
    expect(weekDropId(jan5, 22)).toBe('week-2026-01-05-22');
    expect(weekDropId(dec31, 0)).toBe('week-2025-12-31-00');
  });

  it('round-trips a month id back to the same local day', () => {
    const parsed = parseDropId(monthDropId(jan5));
    expect(parsed).not.toBeNull();
    expect(parsed!.view).toBe('month');
    expect(parsed!.date.getFullYear()).toBe(2026);
    expect(parsed!.date.getMonth()).toBe(0);
    expect(parsed!.date.getDate()).toBe(5);
    // Parsing yields midnight local; the drop handlers set the time themselves.
    expect(parsed!.date.getHours()).toBe(0);
  });

  it('round-trips a week id back to the same local day and hour', () => {
    const parsed = parseDropId(weekDropId(jan5, 14));
    expect(parsed).not.toBeNull();
    expect(parsed!.view).toBe('week');
    expect(parsed!.date.getDate()).toBe(5);
    expect(parsed!.view === 'week' && parsed!.hour).toBe(14);
  });

  it('parses the hours at both ends of a full-day window', () => {
    // Midnight and 11 PM only exist once the window widens, but the id format
    // has to carry them, and "00" must not be mistaken for a missing hour.
    expect(parseDropId('week-2026-01-05-00')).toMatchObject({ view: 'week', hour: 0 });
    expect(parseDropId('week-2026-01-05-23')).toMatchObject({ view: 'week', hour: 23 });

    const midnight = parseDropId(weekDropId(dec31, 0));
    expect(midnight).toMatchObject({ view: 'week', hour: 0 });
    expect(midnight!.date.getDate()).toBe(31);

    const lateEvening = parseDropId(weekDropId(jan5, 23));
    expect(lateEvening).toMatchObject({ view: 'week', hour: 23 });
    expect(lateEvening!.date.getDate()).toBe(5);
  });

  it('parses the exact strings the grid produced before geometry.ts existed', () => {
    expect(parseDropId('month-2026-01-05')).toMatchObject({ view: 'month' });
    expect(parseDropId('week-2026-01-05-08')).toMatchObject({ view: 'week', hour: 8 });
    // The old parser used parseInt, so unpadded ids were accepted too.
    expect(parseDropId('week-2026-1-5-8')).toMatchObject({ view: 'week', hour: 8 });
  });

  it('does not confuse a week id for a month id', () => {
    const parsed = parseDropId('week-2026-01-05-08');
    expect(parsed!.view).toBe('week');
  });

  it('returns null for anything that is not a drop target', () => {
    expect(parseDropId('event-abc-123')).toBeNull();
    expect(parseDropId('month-2026-01')).toBeNull();
    expect(parseDropId('week-2026-01-05')).toBeNull();
    expect(parseDropId('month-2026-01-05-08')).toBeNull();
    expect(parseDropId('')).toBeNull();
    expect(parseDropId('month-abcd-01-05')).toBeNull();
    expect(parseDropId('MONTH-2026-01-05')).toBeNull();
  });
});

describe('isOutsideWindow', () => {
  const event = (startHour: number, startMinute: number, endHour: number, endMinute = 0) => ({
    start_time: new Date(2026, 8, 22, startHour, startMinute).toISOString(),
    end_time: new Date(2026, 8, 22, endHour, endMinute).toISOString(),
  });

  it('keeps an event inside the rendered hours in the grid', () => {
    expect(isOutsideWindow(event(10, 0, 11))).toBe(false);
    expect(isOutsideWindow(event(8, 0, 9))).toBe(false);
    expect(isOutsideWindow(event(21, 30, 22, 30))).toBe(false);
  });

  it('sends every deadline to the strip, whatever time it is', () => {
    expect(isOutsideWindow({ ...event(10, 0, 11), is_deadline: true })).toBe(true);
  });

  it('sends an event that starts before the window to the strip', () => {
    // 7:45 AM: the staff grid compared whole hours (7 < 8, out) and the student
    // grid compared floats (7.75 < 8, out) — they agreed here but not on 8:00
    // vs 8:30 boundaries, which is why there is now one implementation.
    expect(isOutsideWindow(event(7, 45, 9))).toBe(true);
    expect(isOutsideWindow(event(6, 0, 7))).toBe(true);
  });

  it('sends an event that starts in the last row to the strip', () => {
    // A 10 PM row IS rendered; an event starting in it is still exiled. That is
    // the bound both grids drew, kept exactly so this refactor moves nothing.
    expect(isOutsideWindow(event(22, 0, 23))).toBe(true);
    expect(isOutsideWindow(event(23, 30, 23, 45))).toBe(true);
  });

  it('sends an event that has already finished by 8 AM to the strip', () => {
    expect(isOutsideWindow(event(6, 0, 8))).toBe(true);
  });

  it('takes an explicit window when a caller has one', () => {
    expect(isOutsideWindow(event(7, 0, 8), 6, 22)).toBe(false);
  });
});

describe('fitsMetaRow', () => {
  it('gives a 50-minute block its second line', () => {
    // The x-hour is the most common short slot here, and it is the length the
    // threshold was placed to keep: 3.333rem of block, less 0.25 of gap and
    // 0.5 of `py-1`, leaves 2.583rem for 2.375rem of content.
    expect(fitsMetaRow(50 / 60)).toBe(true);
    expect(fitsMetaRow(1)).toBe(true);
    expect(fitsMetaRow(1.5)).toBe(true);
  });

  it('withholds it from a 45-minute block', () => {
    // 3rem, less the gap and the roomier `p-2` it keeps, leaves 1.75rem: the
    // title and half of the row, which is worse than no row at all.
    expect(fitsMetaRow(0.75)).toBe(false);
    expect(fitsMetaRow(0.5)).toBe(false);
  });

  it('measures the block that will be DRAWN, not the raw duration', () => {
    // Everything shorter than the clamp draws at the clamp — still under the
    // threshold, but the rule goes through the same clamp the height does
    // rather than second-guessing it.
    expect(fitsMetaRow(0.1)).toBe(false);
    expect(META_ROW_MIN_HOURS).toBeGreaterThan(MIN_DURATION_HOURS);
    expect(META_ROW_MIN_HOURS).toBeLessThan(50 / 60);
  });
});

describe('isTightBlock', () => {
  it('tightens the padding of anything under an hour', () => {
    expect(isTightBlock(50 / 60)).toBe(true);
    expect(isTightBlock(0.75)).toBe(true);
  });

  it('leaves an hour or more alone', () => {
    expect(isTightBlock(1)).toBe(false);
    expect(isTightBlock(2)).toBe(false);
  });

  it('is where the room for a 50-minute meta row comes from', () => {
    // The two rules meet here: a block can be short enough to need the tighter
    // padding AND long enough to keep its row. That window is the x-hour.
    expect(isTightBlock(50 / 60) && fitsMetaRow(50 / 60)).toBe(true);
  });
});
