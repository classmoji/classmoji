import { describe, expect, it } from 'vitest';
import {
  CHIP_BOX_REM,
  CHIP_GAP_REM,
  CHIP_LINE_MIN_HOURS,
  CHIP_WRAP_MIN_HOURS,
  META_WITH_CHIP_MIN_HOURS,
  chipAreaRem,
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  HOUR_FLOOR,
  HOUR_HEIGHT_REM,
  META_ROW_MIN_HOURS,
  MIN_DURATION_HOURS,
  blockLayout,
  crossesMidnight,
  fitsMetaRow,
  formatHourLabel,
  heightForBlock,
  heightForDuration,
  hourLabelParts,
  hourRange,
  hoursInWindow,
  isOutsideWindow,
  isTightBlock,
  monthDropId,
  parseDropId,
  remForHours,
  selectionRange,
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

  it('keeps an event that starts in the LAST rendered row in the grid', () => {
    // There is one bound now, and it is the window the grid draws. A 10:30 PM
    // class used to be exiled to the strip above a 10 PM row with room for it.
    expect(isOutsideWindow(event(22, 0, 23))).toBe(false);
    expect(isOutsideWindow(event(22, 30, 23))).toBe(false);
  });

  it('sends an event that starts past the end of the window to the strip', () => {
    // 11 PM is outside the DEFAULT window; it is inside a window that a late
    // event has widened, which is what `hourRange` is for.
    expect(isOutsideWindow(event(23, 30, 23, 45))).toBe(true);
    expect(isOutsideWindow(event(23, 30, 23, 45), 8, 24)).toBe(false);
  });

  it('sends an event that has already finished by 8 AM to the strip', () => {
    expect(isOutsideWindow(event(6, 0, 8))).toBe(true);
  });

  it('sends a zero-length or inverted timed event to the strip', () => {
    // Otherwise it is drawn at the minimum-duration clamp, which says the
    // event runs for 45 minutes when nothing says it runs at all.
    expect(isOutsideWindow(event(10, 0, 10))).toBe(true);
    expect(isOutsideWindow(event(11, 0, 10))).toBe(true);
  });

  it('draws an event that crosses midnight, rather than exiling it', () => {
    // Its end reads as hour 0.5 — EARLIER than its start — so every
    // comparison between the two clock times has to ask about the day first.
    const crossing = {
      start_time: new Date(2026, 8, 22, 23, 0).toISOString(),
      end_time: new Date(2026, 8, 23, 0, 30).toISOString(),
    };
    expect(crossesMidnight(crossing)).toBe(true);
    expect(isOutsideWindow(crossing, 8, 24)).toBe(false);
  });

  it('takes an explicit window when a caller has one', () => {
    expect(isOutsideWindow(event(7, 0, 8), 6, 22)).toBe(false);
  });
});

describe('crossesMidnight', () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

  it('is false for an event that starts and ends on one local day', () => {
    expect(crossesMidnight({ start_time: at(22, 9), end_time: at(22, 10, 30) })).toBe(false);
    // 11:59 PM is still the same day.
    expect(crossesMidnight({ start_time: at(22, 23), end_time: at(22, 23, 59) })).toBe(false);
  });

  it('is true the moment the end lands on the next day', () => {
    expect(crossesMidnight({ start_time: at(22, 23), end_time: at(23, 0) })).toBe(true);
    expect(crossesMidnight({ start_time: at(22, 20), end_time: at(23, 2) })).toBe(true);
  });

  it('says no rather than guessing when a date cannot be read', () => {
    expect(crossesMidnight({ start_time: 'nonsense', end_time: at(23, 0) })).toBe(false);
  });
});

describe('hourRange', () => {
  const timed = (startHour: number, endHour: number, day = 22) => ({
    start_time: new Date(2026, 8, day, Math.trunc(startHour), (startHour % 1) * 60).toISOString(),
    end_time: new Date(2026, 8, day, Math.trunc(endHour), (endHour % 1) * 60).toISOString(),
  });
  const due = (hour: number, minute = 0, day = 22) => ({
    is_deadline: true,
    start_time: new Date(2026, 8, day, hour, minute).toISOString(),
    end_time: new Date(2026, 8, day, hour, minute).toISOString(),
  });

  it('falls back to the default window when there is nothing to fit', () => {
    expect(hourRange([])).toEqual({ startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR });
  });

  it('leaves the window alone for a day that already fits inside it', () => {
    expect(hourRange([timed(10, 11.5), timed(14, 16)])).toEqual({ startHour: 8, endHour: 23 });
  });

  it('widens down to midnight for an 11:59 PM deadline', () => {
    // The whole point: the due line needs the 11 PM row to exist.
    expect(hourRange([due(23, 59)])).toEqual({ startHour: 8, endHour: 24 });
  });

  it('gives a deadline the row it falls IN, not the one after it', () => {
    expect(hourRange([due(14)]).endHour).toBe(23);
    expect(hourRange([due(23)]).endHour).toBe(24);
  });

  it('never widens UP for a deadline', () => {
    // A 2 AM due time keeps its all-day chip and gets no line. Opening the
    // grid to the floor for it would buy two hours of empty night.
    expect(hourRange([due(2)])).toEqual({ startHour: 8, endHour: 23 });
    expect(hourRange([due(0, 0)])).toEqual({ startHour: 8, endHour: 23 });
  });

  it('widens down to cover the end of a late event', () => {
    expect(hourRange([timed(21, 22.5)]).endHour).toBe(23);
    expect(hourRange([timed(22, 23.5)]).endHour).toBe(24);
    expect(hourRange([timed(22, 23)]).endHour).toBe(23);
  });

  it('gives an event that runs past midnight the rest of the day', () => {
    const crossing = {
      start_time: new Date(2026, 8, 22, 23, 0).toISOString(),
      end_time: new Date(2026, 8, 23, 1, 0).toISOString(),
    };
    expect(hourRange([crossing]).endHour).toBe(24);
  });

  it('widens up to an early event, and no further than the floor', () => {
    expect(hourRange([timed(7, 8.5)]).startHour).toBe(7);
    expect(hourRange([timed(HOUR_FLOOR, 8)]).startHour).toBe(HOUR_FLOOR);
    expect(hourRange([timed(6.5, 8)]).startHour).toBe(HOUR_FLOOR);
  });

  it('does not move at all for an event that starts before the floor', () => {
    // It would begin above the first row whatever the window did, so it keeps
    // its all-day chip either way — and opening the grid to the floor for it
    // bought two empty rows at the top of every week of that month.
    expect(hourRange([timed(3, 4)]).startHour).toBe(DEFAULT_START_HOUR);
    expect(hourRange([timed(5.5, 7)]).startHour).toBe(DEFAULT_START_HOUR);
    // …and one that starts before the floor but runs into the day still
    // widens DOWNWARD, because its end is drawn.
    expect(hourRange([timed(3, 4)]).endHour).toBe(DEFAULT_END_HOUR);
  });

  it('takes the widest answer across the whole set', () => {
    expect(hourRange([timed(7, 8), timed(10, 11), due(23, 59), timed(14, 15)])).toEqual({
      startHour: 7,
      endHour: 24,
    });
  });

  it('never runs past 24', () => {
    const crossing = {
      start_time: new Date(2026, 8, 22, 23, 30).toISOString(),
      end_time: new Date(2026, 8, 24, 9, 0).toISOString(),
    };
    expect(hourRange([crossing, due(23, 59)]).endHour).toBe(24);
  });

  it('skips an item whose dates cannot be read', () => {
    expect(hourRange([{ start_time: 'nonsense', end_time: 'nonsense' }])).toEqual({
      startHour: DEFAULT_START_HOUR,
      endHour: DEFAULT_END_HOUR,
    });
  });
});

describe('selectionRange', () => {
  const TUESDAY = new Date(2026, 8, 22);

  it('turns one touched cell into an hour', () => {
    const { start, end } = selectionRange(TUESDAY, 10, 10);
    expect(start.getHours()).toBe(10);
    expect(end.getHours()).toBe(11);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('reads a drag in either direction', () => {
    const down = selectionRange(TUESDAY, 10, 13);
    const up = selectionRange(TUESDAY, 13, 10);
    expect(down).toEqual(up);
    expect(down.start.getHours()).toBe(10);
    expect(down.end.getHours()).toBe(14);
  });

  it('ends a selection of the LAST row at the next day’s midnight', () => {
    // The 11 PM row only exists once the window widens, and an hour 24 does
    // not. `setHours(24)` rolls the date, which is exactly the range the add
    // modal rebuilds with `buildEventWindow` and the service accepts.
    const { start, end } = selectionRange(TUESDAY, 23, 23);

    expect(start.getDate()).toBe(22);
    expect(start.getHours()).toBe(23);
    expect(end.getDate()).toBe(23);
    expect(end.getHours()).toBe(0);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it('keeps a drag that ENDS on the last row valid too', () => {
    const { start, end } = selectionRange(TUESDAY, 21, 23);
    expect(start.getHours()).toBe(21);
    expect(end.getDate()).toBe(23);
    expect(end.getTime() - start.getTime()).toBe(3 * 60 * 60 * 1000);
  });
});

describe('heightForBlock', () => {
  it('measures an ordinary block exactly as heightForDuration does', () => {
    expect(heightForBlock(10, 1, 23)).toBe('4rem');
    expect(heightForBlock(10, 0.5, 23)).toBe('3rem');
  });

  it('clips a block at the bottom edge of the window', () => {
    // 11:30 PM for 15 minutes: the minimum-duration clamp would otherwise hang
    // half a block below the calendar.
    expect(heightForBlock(23.5, 0.25, 24)).toBe('2rem');
    // 11 PM → 12:30 AM, clipped to the hours that are actually drawn.
    expect(heightForBlock(23, 1.5, 24)).toBe('4rem');
  });

  it('never goes negative', () => {
    expect(heightForBlock(24, 1, 24)).toBe('0rem');
  });
});

describe('blockLayout', () => {
  it('gives a two-hour block its meta row and several chip lines', () => {
    const layout = blockLayout(2, 5);
    expect(layout.showMeta).toBe(true);
    expect(layout.chipLines).toBe(3);
    expect(layout.tight).toBe(false);
  });

  it('starts wrapping chips at 105 minutes', () => {
    expect(blockLayout(104 / 60, 5).chipLines).toBe(1);
    expect(blockLayout(CHIP_WRAP_MIN_HOURS, 5).chipLines).toBeGreaterThan(1);
  });

  it('gives the 65-minute class its time row AND a chip line', () => {
    // The commonest block in the product. It keeps both by dropping to the
    // tight padding; losing the time the moment a deck was linked to it was
    // the wrong trade.
    for (const resourceCount of [1, 2, 3]) {
      const layout = blockLayout(65 / 60, resourceCount);
      expect(layout.showMeta).toBe(true);
      expect(layout.chipLines).toBe(1);
      expect(layout.tight).toBe(true);
    }
  });

  it('keeps both from 63 minutes up, and trades below that', () => {
    expect(blockLayout(META_WITH_CHIP_MIN_HOURS, 2)).toMatchObject({
      showMeta: true,
      chipLines: 1,
    });
    // 60–62 minutes is where the two genuinely do not both fit. The chip wins:
    // when the event happens is still legible from where its block sits in the
    // grid, and the time is in the block's accessible name either way.
    expect(blockLayout(1, 2)).toMatchObject({ showMeta: false, chipLines: 1 });
    expect(blockLayout(62 / 60, 2)).toMatchObject({ showMeta: false, chipLines: 1 });
  });

  it('keeps the meta row on that same block when nothing is linked to it', () => {
    // The row is TRADED for a chip line, never simply dropped — and with no
    // chips to pay for, the block keeps the roomier padding too.
    const layout = blockLayout(65 / 60, 0);
    expect(layout.chipLines).toBe(0);
    expect(layout.showMeta).toBe(true);
    expect(layout.tight).toBe(false);
  });

  it('budgets chip lines by the boxes they draw, with no gap above the first', () => {
    // The chip container's negative top margin reclaims exactly the padding
    // the rows above it end with, so n lines cost n boxes and n−1 gaps.
    expect(chipAreaRem(0)).toBe(0);
    expect(chipAreaRem(1)).toBeCloseTo(CHIP_BOX_REM, 5);
    expect(chipAreaRem(3)).toBeCloseTo(3 * CHIP_BOX_REM + 2 * CHIP_GAP_REM, 5);
  });

  it('gives a 50-minute block the icon cluster and keeps its meta row', () => {
    const layout = blockLayout(50 / 60, 3);
    expect(layout.chipLines).toBe(0);
    expect(layout.showMeta).toBe(true);
    expect(layout.tight).toBe(true);
  });

  it('gives a 45-minute block nothing but its title and the cluster', () => {
    const layout = blockLayout(45 / 60, 3);
    expect(layout.chipLines).toBe(0);
    expect(layout.showMeta).toBe(false);
  });

  it('hands an hour-long block exactly one chip line', () => {
    expect(blockLayout(CHIP_LINE_MIN_HOURS, 1).chipLines).toBe(1);
    // And the tier below it none, however many resources there are.
    expect(blockLayout(CHIP_LINE_MIN_HOURS - 0.01, 9).chipLines).toBe(0);
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
