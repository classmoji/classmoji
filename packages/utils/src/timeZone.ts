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
 * THE ZONE comes from `classroom_settings.timezone` (read through
 * classroom.getTimeZone), resolved by `resolveEffectiveTimeZone`: the
 * classroom's zone, else a caller-supplied zone (Ask Moji's browser zone), else
 * UTC. Null, blank or unrecognised falls back to UTC and says so, the same rule
 * apps/pages' schedule applies: an honest UTC label beats a bare time in an
 * unknown zone.
 *
 * Intl only, no date library: the column is validated against Intl on write
 * (`canonicalTimeZone`, via classroom.updateSettings), so "Intl can format
 * with this zone" is exactly the invariant that already holds.
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
  const timeZone = canonicalTimeZone(zone);
  return timeZone
    ? { timeZone, isFallback: false }
    : { timeZone: FALLBACK_TIME_ZONE, isFallback: true };
}

/**
 * The canonical spelling of a zone Intl can format with, or null.
 *
 * THE validation for every zone that arrives from outside — a settings form, a
 * browser at classroom creation, Ask Moji's init, the MCP timezone header.
 * Asking Intl to build a formatter (rather than checking membership in
 * `Intl.supportedValuesOf`) accepts aliases like `US/Eastern` and stores the
 * resolved name, so one zone has one spelling in the database.
 */
export function canonicalTimeZone(zone: unknown): string | null {
  if (typeof zone !== 'string') return null;
  const trimmed = zone.trim();
  // Same shape floor as the DB CHECK: refuse before handing junk to Intl.
  if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9+_/-]+$/.test(trimmed)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Where an effective zone came from. */
export type TimeZoneSource = 'classroom' | 'caller' | 'default';

export interface EffectiveTimeZone {
  /** The zone to render in: an IANA name, or `UTC`. */
  timeZone: string;
  /**
   * `classroom` — the course's own setting; `caller` — the asking user's
   * browser zone (Ask Moji only, used when the course has none); `default` —
   * neither, so UTC, which every renderer labels as UTC.
   */
  source: TimeZoneSource;
}

/**
 * THE resolution order, in one place: the classroom's zone, then a
 * caller-supplied zone, then UTC. Each candidate is validated; an invalid one is
 * skipped as if it were absent, never thrown.
 *
 * The caller zone is a fallback for Ask Moji, whose client knows the student's
 * browser zone. The Claude.ai connector has no browser and passes none.
 */
export function resolveEffectiveTimeZone(
  classroomZone: string | null | undefined,
  callerZone?: string | null
): EffectiveTimeZone {
  const fromClassroom = canonicalTimeZone(classroomZone);
  if (fromClassroom) return { timeZone: fromClassroom, source: 'classroom' };
  const fromCaller = canonicalTimeZone(callerZone);
  if (fromCaller) return { timeZone: fromCaller, source: 'caller' };
  return { timeZone: FALLBACK_TIME_ZONE, source: 'default' };
}

/**
 * Every zone to offer in a picker: the runtime's IANA list, each in the
 * canonical spelling `canonicalTimeZone` stores, with UTC first. Call it on the
 * SERVER and ship the result, so the list the browser renders is the list the
 * server validates against (browser and server ICU can disagree).
 */
export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const raw =
    typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  const zones = new Set<string>();
  for (const zone of raw) {
    const canonical = canonicalTimeZone(zone);
    if (canonical && canonical !== FALLBACK_TIME_ZONE) zones.add(canonical);
  }
  return [FALLBACK_TIME_ZONE, ...[...zones].sort()];
}

/** A Date for anything instant-shaped, or null when it is not one. */
function toInstant(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

type Parts = Partial<Record<Intl.DateTimeFormatPartTypes, string>>;

/**
 * Formatters are costly to build and a payload can hold hundreds of dates in
 * one zone, so each (zone, options) formatter is built once and reused. The key
 * space is small: a handful of option shapes times the zones actually in use.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function partsOf(instant: Date, options: Intl.DateTimeFormatOptions): Parts {
  const parts: Parts = {};
  for (const part of formatterFor(options).formatToParts(instant)) {
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

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

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
 * The first instant that falls on local date `year-month-day` in `timeZone`
 * (normally local 00:00). `month` is 1-based; overflowing days (Oct 32) roll
 * over the way Date.UTC does.
 *
 * NOT simply "wall-clock midnight minus the offset": in zones that change DST
 * AT midnight (America/Santiago, America/Havana, …) local 00:00 does not exist
 * on the spring-forward day — the clock goes 23:59 → 01:00 — and the naive
 * answer lands an hour early, on the previous day. So both candidate offsets
 * (before and after any change) are tried, and the earliest one that actually
 * falls on the target date wins.
 */
function localMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const target = new Date(wall);
  const onTarget = (instant: number) => {
    const p = partsOf(new Date(instant), {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
    return (
      Number(p.year) === target.getUTCFullYear() &&
      Number(p.month) === target.getUTCMonth() + 1 &&
      Number(p.day) === target.getUTCDate()
    );
  };

  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  const valid = [first, second].filter(onTarget);
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(first, second));
}

/** True when `YYYY-MM-DD` names a date that exists (no Feb 30, no month 13). */
export function isRealCalendarDate(ymd: string): boolean {
  const m = YMD.exec(ymd);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
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

/**
 * The instants bounding whole local days `startYmd` … `endYmd` (inclusive) in
 * the class zone: local 00:00 on the first day to local 23:59:59.999 on the
 * last. This is what "the week of Sep 21" means to a student — a deadline at
 * Sun 11:59 PM EDT is `Mon 03:59Z`, and a UTC-day window drops it.
 *
 * Returns null when either date is not a real `YYYY-MM-DD` date (no
 * `2026-02-30`: Date would silently roll that into March), or start is after end.
 */
export function localDayRange(
  startYmd: string,
  endYmd: string,
  zone: string | null | undefined
): { start: Date; end: Date } | null {
  if (!isRealCalendarDate(startYmd) || !isRealCalendarDate(endYmd)) return null;
  const s = YMD.exec(startYmd)!;
  const e = YMD.exec(endYmd)!;
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
 * `include`, when given, limits which keys get a rendering (an allowlist of
 * the dates a reader actually quotes); without it every timestamp does.
 *
 * `count` is how many were added, so a caller can decide whether the payload
 * had any dates in it at all.
 */
export function addLocalTimes<T>(
  payload: T,
  zone: string | null | undefined,
  { include }: { include?: (key: string) => boolean } = {}
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
      if (include && !include(key)) continue;
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
