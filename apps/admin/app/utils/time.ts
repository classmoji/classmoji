/**
 * Calendar periods for platform metrics, in one named reporting time zone.
 *
 * The old dashboard used rolling 24h/7d windows ending at page load but
 * labelled them with calendar dates, so "Oct 30" meant Oct 30 14:05 → Oct 31
 * 14:05 and two loads a minute apart disagreed. Every chart and every
 * "this week" number now uses calendar days and Monday-start weeks in
 * REPORTING_TZ, and the current (unfinished) period is marked partial.
 *
 * Pure: no Prisma, unit-tested in __tests__/time.test.ts.
 */

export const REPORTING_TZ = 'America/New_York';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Period {
  start: Date;
  end: Date;
  /** The period containing `now`: still filling up. */
  partial: boolean;
}

/** Wall-clock parts of an instant in `tz`. */
/**
 * One formatter per time zone. Building an Intl.DateTimeFormat is the
 * expensive part of reading local parts, and Home reads them for every
 * activity row: constructing one per call blocked the admin server's only
 * thread for seconds per load (React's stream timed out, health checks
 * failed).
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (tz: string): Intl.DateTimeFormat => {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, fmt);
  }
  return fmt;
};

const partsIn = (instant: Date, tz: string) => {
  const fmt = formatterFor(tz);
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday,
  };
};

/** Offset of `tz` from UTC at `instant`, in ms (negative west of Greenwich). */
const offsetAt = (instant: Date, tz: string): number => {
  const p = partsIn(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
};

/** The instant of local midnight on the calendar day y-m-d in `tz`, DST-safe. */
const midnight = (year: number, month: number, day: number, tz: string): Date => {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - offsetAt(new Date(guess), tz);
  // Re-read the offset at the candidate: across a DST change it differs.
  t = guess - offsetAt(new Date(t), tz);
  return new Date(t);
};

/** Start of the calendar day containing `instant`, in `tz`. */
export const startOfDay = (instant: Date, tz = REPORTING_TZ): Date => {
  const p = partsIn(instant, tz);
  return midnight(p.year, p.month, p.day, tz);
};

/** Start of the calendar day `n` days after the day starting at `dayStart`. */
const addDays = (dayStart: Date, n: number, tz: string): Date => {
  // Step through noon so a 23h/25h DST day can't land on the wrong date.
  const noon = new Date(dayStart.getTime() + 12 * 60 * 60 * 1000 + n * DAY_MS);
  return startOfDay(noon, tz);
};

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** Start of the Monday-start week containing `instant`, in `tz`. */
export const startOfWeek = (instant: Date, tz = REPORTING_TZ): Date => {
  const day = startOfDay(instant, tz);
  const back = WEEKDAY_INDEX[partsIn(day, tz).weekday] ?? 0;
  return addDays(day, -back, tz);
};

/**
 * `count` consecutive calendar periods ending with the one containing `now`,
 * oldest first. The last one is partial.
 */
export const calendarPeriods = (
  now: Date,
  unit: 'day' | 'week',
  count: number,
  tz = REPORTING_TZ
): Period[] => {
  const step = unit === 'day' ? 1 : 7;
  const current = unit === 'day' ? startOfDay(now, tz) : startOfWeek(now, tz);
  const periods: Period[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = addDays(current, -i * step, tz);
    const end = addDays(start, step, tz);
    periods.push({ start, end, partial: i === 0 });
  }
  return periods;
};

/** Count timestamps per period (half-open [start, end)); outside the range is dropped. */
export const countPerPeriod = (timestamps: Date[], periods: Period[]): number[] => {
  const counts = new Array<number>(periods.length).fill(0);
  if (periods.length === 0) return counts;
  const first = periods[0].start.getTime();
  const last = periods[periods.length - 1].end.getTime();
  for (const ts of timestamps) {
    const t = ts.getTime();
    if (t < first || t >= last) continue;
    // Periods are contiguous: binary search the right one.
    let lo = 0;
    let hi = periods.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (periods[mid].start.getTime() <= t) lo = mid;
      else hi = mid - 1;
    }
    counts[lo] += 1;
  }
  return counts;
};

/** "Oct 20" for a period start, read in the reporting zone. */
export const formatPeriodLabel = (iso: string, tz = REPORTING_TZ): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });

/** "Oct 20 – 26" (or "Oct 27 – Nov 2") for a week, end exclusive. */
export const formatWeekRange = (startIso: string, endIso: string, tz = REPORTING_TZ): string => {
  const start = new Date(startIso);
  const lastDay = new Date(new Date(endIso).getTime() - 12 * 60 * 60 * 1000);
  const sameMonth =
    start.toLocaleDateString('en-US', { month: 'short', timeZone: tz }) ===
    lastDay.toLocaleDateString('en-US', { month: 'short', timeZone: tz });
  const a = formatPeriodLabel(startIso, tz);
  const b = sameMonth
    ? lastDay.toLocaleDateString('en-US', { day: 'numeric', timeZone: tz })
    : formatPeriodLabel(lastDay.toISOString(), tz);
  return `${a} – ${b}`;
};

/** "2 min", "3 hours", "Yesterday", "Oct 3": how long ago, for activity columns. */
export const relativeTime = (iso: string | null, now = new Date()): string => {
  if (!iso) return '—';
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'}`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: new Date(iso).getFullYear() === now.getFullYear() ? undefined : 'numeric',
    timeZone: REPORTING_TZ,
  });
};

/** 'YYYY-MM-DD' of the calendar day containing `instant`, in `tz`. */
export const localDate = (instant: Date, tz = REPORTING_TZ): string => {
  const p = partsIn(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/**
 * The instant a 'YYYY-MM-DD' calendar day starts, in `tz`. Remembered per
 * (day, zone): callers pass the same few dozen days for thousands of rows.
 * A fresh Date is returned each time, so a caller may not change the cached one.
 */
const dayStarts = new Map<string, number>();
const DAY_START_CACHE_MAX = 10_000;
export const dayStart = (date: string, tz = REPORTING_TZ): Date => {
  const key = `${tz}|${date}`;
  let t = dayStarts.get(key);
  if (t === undefined) {
    // Noon UTC falls on the same calendar date everywhere from UTC-11 to UTC+11.
    t = startOfDay(new Date(`${date}T12:00:00Z`), tz).getTime();
    if (dayStarts.size >= DAY_START_CACHE_MAX) dayStarts.clear();
    dayStarts.set(key, t);
  }
  return new Date(t);
};
