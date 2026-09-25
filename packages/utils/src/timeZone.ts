/**
 * Class-time-zone rendering for anything that hands a date to a MODEL.
 *
 * Every member-facing web view formats a deadline in the browser, so it lands
 * in the reader's own zone for free. A model has no browser: it reads the raw
 * ISO instant (`2026-09-21T03:59:00.000Z`) and, left to itself, reports the UTC
 * wall-clock ("due September 21 at 3:59 AM") for a deadline that is really Sun
 * Sep 20, 11:59 PM in New York. It also gets weekdays wrong when it works them
 * out itself. So the server does the conversion and hands the model a ready
 * local string alongside the ISO value.
 *
 * THE ZONE comes from `classroom_sites.timezone` (the IANA zone the public
 * schedule already renders in). Null, blank or unrecognised falls back to UTC
 * and says so, the same rule apps/pages' schedule applies: an honest UTC label
 * beats a bare time in an unknown zone.
 *
 * Intl only, no date library: the column is validated against Intl on write
 * (site.service canonicalizeTimeZone), so "Intl can format with this zone" is
 * exactly the invariant that already holds.
 */

/** The zone used when a classroom has none set. */
export const FALLBACK_TIME_ZONE = 'UTC';

export interface ResolvedTimeZone {
  /** The IANA zone to render in (canonical spelling), or `UTC`. */
  timeZone: string;
  /** True when the classroom had no usable zone and this is the UTC fallback. */
  isFallback: boolean;
}

/**
 * The zone to render in, from a stored value that may be null or bad.
 *
 * A zone Intl cannot build a formatter for is treated as unset rather than
 * thrown: this runs on read paths, and one bad row must not take a tool down.
 */
export function resolveTimeZone(zone: string | null | undefined): ResolvedTimeZone {
  const trimmed = typeof zone === 'string' ? zone.trim() : '';
  if (!trimmed) return { timeZone: FALLBACK_TIME_ZONE, isFallback: true };
  try {
    const timeZone = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions()
      .timeZone;
    return { timeZone, isFallback: false };
  } catch {
    return { timeZone: FALLBACK_TIME_ZONE, isFallback: true };
  }
}

/** A Date for anything instant-shaped, or null when it is not one. */
function toInstant(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

function partsOf(instant: Date, options: Intl.DateTimeFormatOptions): Parts {
  const parts: Parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', options).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  return parts;
}

/**
 * One instant as a short local string with weekday, year and zone
 * abbreviation: `Sun Sep 20, 2026, 11:59 PM EDT`.
 *
 * The year stays in: a model working out "is that this week?" should never
 * have to guess it. The abbreviation is whatever Intl gives for en-US — `EDT`,
 * `PST`, `UTC`, or an offset like `GMT+1` for zones without a common US name.
 *
 * Returns null for a missing or unparseable value.
 */
export function formatLocalDateTime(
  value: Date | string | number | null | undefined,
  zone: string | null | undefined
): string | null {
  const instant = toInstant(value);
  if (!instant) return null;
  const { timeZone } = resolveTimeZone(zone);
  const p = partsOf(instant, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  return `${p.weekday} ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
}

/**
 * The "what time is it" line for a model's context:
 * `Thursday, September 24, 2026, 11:20 AM EDT (America/New_York)`.
 *
 * On the UTC fallback the parenthetical says the course has no zone set, so the
 * model (and anyone reading a transcript) knows the times are UTC by default
 * rather than by choice.
 */
export function formatNowContext(now: Date, zone: string | null | undefined): string {
  const { timeZone, isFallback } = resolveTimeZone(zone);
  const p = partsOf(now, {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const label = isFallback ? 'UTC; this course has not set a time zone' : timeZone;
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName} (${label})`;
}

// ─── Calendar-day arithmetic in a zone ──────────────────────────────────────

/** The zone's UTC offset at `instantMs`, in ms (positive east of UTC). */
function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsOf(new Date(instantMs), {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant local midnight begins on `year-month-day` in `timeZone`.
 * `month` is 1-based. Overflowing days (Oct 32) roll over the way Date.UTC does.
 */
function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = offsetMs(wall, timeZone);
  let instant = wall - first;
  // One correction step: the offset AT the resulting instant can differ from
  // the offset at the naive guess when a DST change falls between them.
  const second = offsetMs(instant, timeZone);
  if (second !== first) instant = wall - second;
  return new Date(instant);
}

/** The calendar date (in `timeZone`) that `instant` falls on. */
export function localDateParts(
  instant: Date,
  zone: string | null | undefined
): { year: number; month: number; day: number; weekday: number } {
  const { timeZone } = resolveTimeZone(zone);
  const p = partsOf(instant, {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  // Weekday of a calendar date does not depend on the zone once we have it.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday };
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instants bounding whole local days `startYmd` … `endYmd` (inclusive) in
 * the class zone: local 00:00 on the first day to local 23:59:59.999 on the
 * last. This is what "the week of Sep 21" means to a student — a deadline at
 * Sun 11:59 PM EDT is `Mon 03:59Z`, and a UTC-day window drops it.
 *
 * Returns null when either date is not `YYYY-MM-DD`, or start is after end.
 */
export function localDayRange(
  startYmd: string,
  endYmd: string,
  zone: string | null | undefined
): { start: Date; end: Date } | null {
  const s = YMD.exec(startYmd);
  const e = YMD.exec(endYmd);
  if (!s || !e) return null;
  const { timeZone } = resolveTimeZone(zone);
  const start = localMidnight(Number(s[1]), Number(s[2]), Number(s[3]), timeZone);
  const end = new Date(
    localMidnight(Number(e[1]), Number(e[2]), Number(e[3]) + 1, timeZone).getTime() - 1
  );
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { start, end };
}

/**
 * The web calendar's default month window, in the class zone: the local month
 * containing `now`, widened to whole grid weeks (Sunday start) plus one day on
 * each side. Same shape as the UTC version it replaces, only anchored on the
 * class's own calendar, so the last evening of a month is not in the next one.
 */
export function localMonthGridRange(
  now: Date,
  zone: string | null | undefined
): { start: Date; end: Date } {
  const { timeZone } = resolveTimeZone(zone);
  const { year, month } = localDateParts(now, timeZone);
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  const start = localMidnight(year, month, 1 - firstDow - 1, timeZone);
  const end = new Date(
    localMidnight(year, month, lastDay + (6 - lastDow) + 1 + 1, timeZone).getTime() - 1
  );
  return { start, end };
}

// ─── Adding `<field>_local` next to every timestamp in a payload ─────────────

/**
 * An ISO-8601 date-TIME with an explicit zone (`Z` or an offset). Bare dates
 * (`2026-08-31`) deliberately do not match: they are calendar days, not
 * instants, and shifting one into a zone would move it to the previous evening.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Keys whose values LOOK like instants but are calendar days stored at UTC
 * midnight (Postgres `@db.Date`). Rendering one in New York would print the
 * evening before. `CalendarEvent.occurrence_date` is the one such column.
 */
const DATE_ONLY_KEYS: ReadonlySet<string> = new Set(['occurrence_date']);

export const LOCAL_SUFFIX = '_local';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function localFor(value: unknown, timeZone: string): string | null {
  if (value instanceof Date) return formatLocalDateTime(value, timeZone);
  if (typeof value === 'string' && ISO_DATETIME.test(value)) {
    return formatLocalDateTime(value, timeZone);
  }
  return null;
}

/**
 * A copy of `payload` with a `<key>_local` string added right after every key
 * that holds a timestamp (an ISO date-time string or a Date), rendered in the
 * class zone. Nothing is removed or rewritten: existing keys, including an
 * existing `<key>_local`, are left exactly as they were.
 *
 * `count` is how many were added, so a caller can decide whether the payload
 * had any dates in it at all.
 */
export function addLocalTimes<T>(
  payload: T,
  zone: string | null | undefined
): { value: T; count: number } {
  const { timeZone } = resolveTimeZone(zone);
  let count = 0;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = walk(value);
      const localKey = `${key}${LOCAL_SUFFIX}`;
      if (DATE_ONLY_KEYS.has(key) || key.endsWith(LOCAL_SUFFIX) || localKey in node) continue;
      const local = localFor(value, timeZone);
      if (local !== null) {
        out[localKey] = local;
        count += 1;
      }
    }
    return out;
  };

  return { value: walk(payload) as T, count };
}
