/**
 * Calendar geometry — the numbers and the droppable-id formats that the staff
 * grid and the student grid both depend on.
 *
 * Pure: no React, no dnd-kit, no DOM. That is the point. The two week grids
 * were written independently and drifted (68px vs 64px rows, a 0.5h vs 0.75h
 * minimum block, an hour label that would print "0 AM"), and the drag-and-drop
 * ids were built in one place and parsed in another with nothing tying the two
 * formats together. Everything positional now comes from here, so the views
 * measure the same way and the producer/parser pair cannot drift.
 *
 * Sizes are `rem`, never px: the app sets `html { font-size: 17px }`, so an
 * hour row is 68px there and follows the reader's UI font size elsewhere.
 */

/** Height of one hour row. */
export const HOUR_HEIGHT_REM = 4;

/** First hour of the default window (inclusive) — 8 AM. */
export const DEFAULT_START_HOUR = 8;

/**
 * Exclusive end of the default window. Rows run `[DEFAULT_START_HOUR,
 * DEFAULT_END_HOUR)`, i.e. 8 AM…10 PM — 15 rows, which is exactly what both
 * views render today.
 *
 * Widening the grid down to midnight (the 11 PM row) and deriving the range
 * from the loaded month is a later change, and it is a change to this one
 * constant plus the range helper — not to any caller.
 */
export const DEFAULT_END_HOUR = 23;

/**
 * The earliest hour a computed range is allowed to widen up to. A 6 AM event
 * pulls the grid up to 6 AM; a 3 AM one does not drag it to 3 AM.
 */
export const HOUR_FLOOR = 6;

/**
 * Shortest block the grid draws, in hours. One number for both views: the
 * student grid clamped at 0.75h and the staff grid at 0.5h, which made the same
 * 30-minute event two different heights depending on who looked.
 *
 * 0.75h is the survivor, not 0.5h, because it is the one that fits: a block
 * carries a title line and a time line, and neither view's content fits in a
 * 0.5h box. The student block subtracts 4px from its height on top of that, so
 * a half-hour event was drawing ~47px of content into a 30px box.
 */
export const MIN_DURATION_HOURS = 0.75;

/** The hours rendered in a window, e.g. `[8, 9, … 22]` for the default one. */
export const hoursInWindow = (
  startHour: number = DEFAULT_START_HOUR,
  endHourExclusive: number = DEFAULT_END_HOUR
): number[] => {
  const hours: number[] = [];
  for (let hour = startHour; hour < endHourExclusive; hour++) hours.push(hour);
  return hours;
};

/** A span of hours as a CSS length. */
export const remForHours = (hours: number): string => `${hours * HOUR_HEIGHT_REM}rem`;

/**
 * Offset of a clock time from the top of the grid, as a CSS length.
 * `hourFloat` is an absolute clock hour with minutes as a fraction (14.5 = 2:30 PM).
 */
export const topForHour = (hourFloat: number, startHour: number = DEFAULT_START_HOUR): string =>
  remForHours(hourFloat - startHour);

/** Height of a block of `hours`, clamped so a very short event stays readable. */
export const heightForDuration = (hours: number): string =>
  remForHours(Math.max(hours, MIN_DURATION_HOURS));

/**
 * An hour label split into its parts, for views that stack the number over the
 * meridiem. `hour % 12 || 12` is what keeps midnight and 24 printing "12 AM"
 * rather than "0 AM".
 */
export const hourLabelParts = (hour: number): { hour: number; suffix: 'AM' | 'PM' } => {
  const normalized = ((Math.trunc(hour) % 24) + 24) % 24;
  return { hour: normalized % 12 || 12, suffix: normalized < 12 ? 'AM' : 'PM' };
};

/** An hour label on one line, e.g. `8 AM`, `12 PM`, `11 PM`. */
export const formatHourLabel = (hour: number): string => {
  const parts = hourLabelParts(hour);
  return `${parts.hour} ${parts.suffix}`;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Local calendar date as `YYYY-MM-DD` (never UTC — the grid is drawn in local time). */
const dateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** Droppable id for a month cell / the week view's all-day strip: `month-YYYY-MM-DD`. */
export const monthDropId = (date: Date): string => `month-${dateKey(date)}`;

/**
 * Droppable id for one week-view hour cell: `week-YYYY-MM-DD-HH`.
 *
 * `hour` is the ABSOLUTE clock hour of the cell, not its row index. Rebasing it
 * onto a dynamic window start would silently move every drop by the offset.
 */
export const weekDropId = (date: Date, hour: number): string =>
  `week-${dateKey(date)}-${pad2(hour)}`;

export type DropTarget = { view: 'month'; date: Date } | { view: 'week'; date: Date; hour: number };

const MONTH_DROP_ID = /^month-(\d{4})-(\d{1,2})-(\d{1,2})$/;
const WEEK_DROP_ID = /^week-(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/;

/**
 * Parse a droppable id back into a local date (and, for week cells, the
 * absolute clock hour). Returns null for anything that is not one of the two
 * formats above, so an unrecognised drop is ignored rather than turned into an
 * Invalid Date.
 */
export const parseDropId = (id: string): DropTarget | null => {
  const week = WEEK_DROP_ID.exec(id);
  if (week) {
    const [, year, month, day, hour] = week;
    return {
      view: 'week',
      date: new Date(Number(year), Number(month) - 1, Number(day)),
      hour: Number(hour),
    };
  }

  const month = MONTH_DROP_ID.exec(id);
  if (month) {
    const [, year, monthOfYear, day] = month;
    return {
      view: 'month',
      date: new Date(Number(year), Number(monthOfYear) - 1, Number(day)),
    };
  }

  return null;
};
