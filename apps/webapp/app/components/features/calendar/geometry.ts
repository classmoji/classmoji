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

import type { CalendarEventWithLinks } from './types';

/** Height of one hour row. */
export const HOUR_HEIGHT_REM = 4;

/** First hour of the default window (inclusive) — 8 AM. */
export const DEFAULT_START_HOUR = 8;

/**
 * Exclusive end of the default window. Rows run `[DEFAULT_START_HOUR,
 * DEFAULT_END_HOUR)`, i.e. 8 AM…10 PM — 15 rows.
 *
 * This is the FLOOR of what the grid draws, never its ceiling: `hourRange`
 * widens it to cover whatever the loaded month actually holds, up to 24.
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

/**
 * A block shorter than an hour, which has to pay for its second line out of its
 * padding: the card drops from `p-2` to `px-2 py-1` below this. Nothing else
 * changes, and a block an hour or longer keeps the roomier padding.
 */
export const TIGHT_BLOCK_MAX_HOURS = 1;

/** Whether a block of `hours` needs the tighter vertical padding. */
export const isTightBlock = (hours: number): boolean =>
  Math.max(hours, MIN_DURATION_HOURS) < TIGHT_BLOCK_MAX_HOURS;

/**
 * The shortest block with room under its title for the meta row (the time and
 * the room). Below it the row is not drawn at all, rather than drawn and sliced
 * in half by the card's clip.
 *
 * 48 minutes, which is where the arithmetic puts it. Every length involved is
 * in `rem`, so write R for the root font size and count in rem: a block is
 * `hours × 4`, less the 0.25 gap the grid leaves under it and the 0.5 of
 * `py-1`; the content is a 1.25 title, a 0.125 gap and a 1 meta row = 2.375.
 *
 *   50 min (0.833h): 3.333 − 0.75 = 2.583 ≥ 2.375 — fits, with 0.2 to spare
 *   48 min (0.8h)  : 3.2   − 0.75 = 2.45  ≥ 2.375 — fits
 *   45 min (0.75h) : 3     − 0.25 − 1 (it keeps `p-2`) = 1.75 < 2.375 — title only
 *
 * Both sides of every one of those comparisons are multiples of R, so the
 * answer is the same at a 14px, 17px or 20px root: the rows, the padding and
 * the type all scale together. That is also why this keys off DURATION rather
 * than a measured height — no layout pass can tell us anything the ratio does
 * not already say.
 *
 * The threshold sits at 48 rather than 50 minutes so that the most common short
 * slot here — the 50-minute x-hour — is decided by a clear margin rather than
 * by an exact float comparison against its own length.
 */
export const META_ROW_MIN_HOURS = 0.8;

/** Whether a block of `hours` has room for its meta row. */
export const fitsMetaRow = (hours: number): boolean =>
  Math.max(hours, MIN_DURATION_HOURS) >= META_ROW_MIN_HOURS;

/**
 * The shortest block that lists its linked resources as CHIPS. Below it they
 * are an icon cluster on the title row, which costs no vertical room at all.
 *
 * 60 minutes.
 */
export const CHIP_LINE_MIN_HOURS = 1;

/**
 * The shortest block whose chips may run to MORE than one line. 105 minutes:
 * the point where a block has spare height rather than borrowed height.
 */
export const CHIP_WRAP_MIN_HOURS = 1.75;

/**
 * One chip line, in rem: the chip's own box plus the gap above it. One chip
 * per line — a day column is about 107px at the week view's minimum width, and
 * two chips side by side there leave each of them room for an icon and a
 * letter. A whole line is what makes a chip worth reading, and it is also what
 * makes `+N` exact: the count of hidden resources has to be decided from the
 * block's height, never from a measured width.
 */
export const CHIP_LINE_REM = 1.125;

/** The gap the grid leaves under a block (`pb-1`), inside its measured height. */
const BLOCK_GAP_REM = 0.25;
/** Vertical padding of the card, both halves: `p-2`, or `py-1` when tight. */
const BLOCK_PADDING_REM = 1;
const TIGHT_BLOCK_PADDING_REM = 0.5;
/** The title line, the meta row, and the gap between stacked rows. */
const TITLE_ROW_REM = 1.25;
const META_ROW_REM = 1;
const ROW_GAP_REM = 0.125;

/**
 * How one week block lays its content out — decided from its DURATION and the
 * number of things linked to it, never from a measured height.
 *
 * Everything below is in rem and every length involved is a multiple of the
 * root font size, so the answer is the same at a 14px, 17px or 20px root: the
 * rows, the padding and the type all scale together. That is the whole reason
 * the tiers key off duration; a layout pass could tell us nothing the ratio
 * does not already say, and the hour row is 56–80px depending on the reader.
 *
 * `chipLines` of 0 means the block shows an icon cluster on its title row
 * instead — one icon per kind, which costs no height.
 */
export interface BlockLayout {
  /** The card pays for its content out of its padding. */
  tight: boolean;
  /** Whether the time·room row is drawn. */
  showMeta: boolean;
  /** How many chips the block shows, one per line. 0 → the icon cluster. */
  chipLines: number;
}

export const blockLayout = (hours: number, resourceCount = 0): BlockLayout => {
  const drawn = Math.max(hours, MIN_DURATION_HOURS);
  const tight = isTightBlock(hours);
  const content =
    drawn * HOUR_HEIGHT_REM - BLOCK_GAP_REM - (tight ? TIGHT_BLOCK_PADDING_REM : BLOCK_PADDING_REM);

  // How many chip lines this block's DURATION entitles it to, before asking
  // whether they fit: none under an hour, one up to 105 minutes, and as many
  // as there is room for above that.
  const allowed =
    resourceCount === 0
      ? 0
      : drawn >= CHIP_WRAP_MIN_HOURS
        ? Number.POSITIVE_INFINITY
        : drawn >= CHIP_LINE_MIN_HOURS
          ? 1
          : 0;

  const linesIn = (room: number) => Math.max(0, Math.floor(room / CHIP_LINE_REM));
  const afterTitle = content - TITLE_ROW_REM;

  let showMeta = fitsMetaRow(hours);
  let chipLines = Math.min(
    allowed,
    linesIn(showMeta ? afterTitle - META_ROW_REM - ROW_GAP_REM : afterTitle)
  );

  // An hour-long block has room for a title and one more row, not two — and
  // the row it is asked for here is the chip line. The meta row gives way:
  // WHEN an event happens is already legible from where its block sits in the
  // grid, while the deck attached to it is visible nowhere else in week view.
  // Only ever a trade, never a loss: a block with nothing linked keeps its row.
  if (allowed > 0 && chipLines === 0 && showMeta) {
    showMeta = false;
    chipLines = Math.min(allowed, linesIn(afterTitle));
  }

  return { tight, showMeta, chipLines };
};

/**
 * The CSS grid template both week surfaces use: a fixed time gutter plus seven
 * equal day columns. `minmax(0, 1fr)` rather than a bare `1fr` — `1fr` has an
 * `auto` minimum, so one long unbroken title widens its column and knocks the
 * day header, the all-day strip and the hour grid out of alignment with each
 * other. The staff grid used `1fr`, the student grid `minmax(0, 1fr)`.
 */
export const WEEK_GRID_COLUMNS = '4rem repeat(7, minmax(0, 1fr))';

/** The span of clock hours a week grid draws. `endHour` is EXCLUSIVE, ≤ 24. */
export interface HourWindow {
  startHour: number;
  endHour: number;
}

/** What both grids draw before anything has been loaded. */
export const DEFAULT_HOUR_WINDOW: HourWindow = {
  startHour: DEFAULT_START_HOUR,
  endHour: DEFAULT_END_HOUR,
};

/** The one shape `hourRange` and `isOutsideWindow` need off a calendar item. */
type TimedItem = Pick<CalendarEventWithLinks, 'is_deadline' | 'start_time' | 'end_time'>;

/** A local clock time as an hour with minutes as a fraction (14.5 = 2:30 PM). */
const clockHour = (date: Date): number => date.getHours() + date.getMinutes() / 60;

const isValid = (date: Date): boolean => !Number.isNaN(date.getTime());

/** Local midnight before `date`, as a timestamp — the day an instant falls on. */
const localDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * Does this event END on a later local day than it starts?
 *
 * 11 PM → midnight is a legitimate event now that the grid reaches midnight,
 * and its end time reads as hour 0 — earlier than its start. Everything that
 * compares the two clock times has to ask this first.
 */
export const crossesMidnight = (event: Pick<TimedItem, 'start_time' | 'end_time'>): boolean => {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  if (!isValid(start) || !isValid(end)) return false;
  return localDay(end) > localDay(start);
};

/**
 * The hours the week grid has to draw for a given set of events.
 *
 * The grid follows the day rather than holding a fixed 8 AM…10 PM band: an
 * 11:59 PM deadline needs somewhere to land, and an 8 AM floor hides an early
 * lab entirely. So the window widens DOWN to cover the last thing that happens
 * (to midnight at the furthest) and UP to the first — but no earlier than
 * `HOUR_FLOOR`, because one 3 AM outlier should not stretch every other week
 * into a screenful of empty night.
 *
 * Feed it the WHOLE loaded set — the month-sized payload, unfiltered by the
 * type legend. Computing it per week would resize the grid as you page, and
 * computing it after the filter would resize it as you toggle a chip.
 *
 * Deadlines widen the window down only. They are zero-duration marks, so the
 * hour they fall IN has to be rendered for their line to have anywhere to sit:
 * 11:59 PM asks for the 11 PM row, i.e. an exclusive end of 24. They never
 * widen it up — a 2 AM due time keeps its all-day chip and gets no line, which
 * is the same answer as before.
 */
export const hourRange = (events: readonly TimedItem[]): HourWindow => {
  let { startHour, endHour } = DEFAULT_HOUR_WINDOW;

  for (const event of events) {
    const start = new Date(event.start_time);
    if (!isValid(start)) continue;
    const startFloat = clockHour(start);

    if (event.is_deadline) {
      endHour = Math.max(endHour, Math.floor(startFloat) + 1);
      continue;
    }

    const end = new Date(event.end_time);
    if (!isValid(end)) continue;
    // An event running past midnight is clipped at the bottom edge, so what it
    // asks for is the rest of the day rather than its own end hour.
    const endFloat = crossesMidnight(event) ? 24 : clockHour(end);

    endHour = Math.max(endHour, Math.ceil(endFloat));
    startHour = Math.min(startHour, Math.max(HOUR_FLOOR, Math.floor(startFloat)));
  }

  return { startHour, endHour: Math.min(endHour, 24) };
};

/**
 * The time range a drag across hour cells picks out, from the first and last
 * cell the pointer touched. A plain click touches one cell and yields an hour.
 *
 * Clamped at 24, which is how selecting the 11 PM row ends at the NEXT day's
 * midnight rather than at an hour 24 that does not exist: `setHours(24)` rolls
 * the date, and the add modal's `buildEventWindow` rolls it back the same way
 * when it rebuilds the range from the form. The service refuses anything whose
 * end is not after its start, so this has to come out the right way round.
 *
 * Pure, and exported so that boundary can be asserted without a pointer.
 */
export const selectionRange = (
  date: Date,
  anchorHour: number,
  hoverHour: number
): { start: Date; end: Date } => {
  const start = new Date(date);
  start.setHours(Math.min(anchorHour, hoverHour), 0, 0, 0);

  const end = new Date(date);
  end.setHours(Math.min(Math.max(anchorHour, hoverHour) + 1, 24), 0, 0, 0);

  return { start, end };
};

/**
 * Whether an item belongs in the all-day strip rather than in the hour grid.
 *
 * ONE bound, the window the grid is actually drawing: an event that fits
 * between its edges gets a block. There used to be a second, narrower bound —
 * the grid drew a 10 PM row and then exiled anything starting in it — so a
 * 10:30 PM class sat in the strip above a row with its name on it.
 *
 * Deadlines are always here: they are zero-duration, they keep their chip, and
 * in the grid they are a line rather than a block.
 *
 * One implementation for both roles. The staff grid compared whole hours and
 * the student grid compared floats, so a 7:45 AM event sat in the grid for one
 * viewer and in the strip for the other.
 */
export const isOutsideWindow = (
  event: TimedItem,
  startHour: number = DEFAULT_START_HOUR,
  endHourExclusive: number = DEFAULT_END_HOUR
): boolean => {
  if (event.is_deadline) return true;

  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  if (!isValid(start) || !isValid(end)) return true;

  const startFloat = clockHour(start);
  if (startFloat < startHour || startFloat >= endHourExclusive) return true;

  // It starts inside the window and finishes on a later day: it is drawn from
  // its start down to the bottom edge and clipped there, not exiled.
  if (crossesMidnight(event)) return false;

  // Nothing to draw: a zero-length or inverted range would otherwise be given
  // the minimum-duration block, which is a lie about when it happens.
  return end.getTime() <= start.getTime();
};

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
 * Height of one block in the grid, clipped at the bottom edge of the window.
 *
 * An event that runs past midnight is drawn from its start to the last row and
 * stops there; so is a 15-minute one at 11:50 PM, whose minimum-duration clamp
 * would otherwise hang half a block below the calendar.
 */
export const heightForBlock = (
  startHourFloat: number,
  hours: number,
  endHourExclusive: number
): string =>
  remForHours(
    Math.max(0, Math.min(Math.max(hours, MIN_DURATION_HOURS), endHourExclusive - startHourFloat))
  );

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
