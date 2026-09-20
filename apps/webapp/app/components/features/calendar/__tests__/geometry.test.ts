import { describe, expect, it } from 'vitest';
import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  HOUR_FLOOR,
  HOUR_HEIGHT_REM,
  MIN_DURATION_HOURS,
  formatHourLabel,
  heightForDuration,
  hourLabelParts,
  hoursInWindow,
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
    expect(MIN_DURATION_HOURS).toBe(0.5);
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
    expect(heightForDuration(0.5)).toBe('2rem');
    expect(heightForDuration(0.25)).toBe('2rem');
    expect(heightForDuration(0)).toBe('2rem');
    expect(heightForDuration(-3)).toBe('2rem');
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
