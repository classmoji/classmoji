import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { ModuleItemType } from '@prisma/client';

// Both plugins, because this file must never read the PROCESS zone. `utc` is
// what makes a stored instant parse as the instant it is; `timezone` is what
// projects it into the course's zone. Plain `dayjs(value)` does neither — it
// silently adopts whatever TZ the container was started with.
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * `/schedule`'s items → rows, as a pure function.
 *
 * Split out of the route for two reasons. It is the layer where a redacted
 * placeholder is turned into text, which is exactly the thing that must be
 * tested without a browser or a database; and it is the only place that decides
 * what a viewer READS, which keeps that decision from drifting into JSX where
 * it is checkable only by looking.
 *
 * The service has already decided what this viewer may see — this never
 * re-filters, and it never invents a link for a placeholder.
 */

/** The kind label shown on every row, visible or redacted. */
const ITEM_TYPE_LABEL: Record<ModuleItemType, string> = {
  PAGE: 'Page',
  SLIDE: 'Slides',
  REPOSITORY: 'Assignment',
  QUIZ: 'Quiz',
};

/**
 * Dates are formatted HERE, not in the component, and with an explicit pattern
 * rather than `toLocaleDateString()`.
 *
 * The anonymous schedule is shared-cacheable for 60s and ships no JavaScript,
 * so one server's rendering is what every visitor reads — there is no client
 * re-render to correct it. An explicit pattern removes the LOCALE from that
 * output, and it is the same string a spec can assert.
 *
 * It does NOT remove the zone, which is a separate axis and was the actual bug:
 * `toLocaleDateString()` and `format('MMM D, YYYY')` disagree about digits and
 * month names, but both read the calendar day off whatever zone they are given.
 * Prod is UTC (alpine, no TZ), so a 23:59 America/New_York deadline rendered as
 * the NEXT day while every member surface — formatted in the reader's browser —
 * showed the right one. The zone is therefore an explicit input:
 * `ScheduleTargets.timezone`, which the route reads from `classroom_sites`.
 * Null there means UTC, and a UTC rendering says so in the string.
 */
const DATE_FORMAT = 'MMM D, YYYY';

/**
 * The service's schedule item, stated structurally.
 *
 * Not imported from `@classmoji/services`: that package only exports its root,
 * and pulling the route's db module in here would put Prisma inside a function
 * whose whole value is that it needs nothing. The coupling is still checked —
 * `schedule.tsx` passes the service's own result to `toScheduleSections`, so a
 * shape change fails to compile at that call site.
 */
export type ScheduleItem =
  | {
      kind: 'visible';
      item_type: ModuleItemType;
      page?: { id: string; title: string; slug: string | null } | null;
      slide?: { id: string; title: string } | null;
      repository?: { id: string; title: string } | null;
      quiz?: { id: string; name: string } | null;
    }
  | {
      kind: 'placeholder';
      id: string;
      item_type: ModuleItemType;
      due_at: Date | string | null;
    };

export type ScheduleModule = { id: string; title: string; items: ScheduleItem[] };

/** A row the visitor may open. */
export type ScheduleLinkRow = {
  kind: 'link';
  label: string;
  href: string;
  typeLabel: string;
  /** Leaves this site — gets `rel="noopener noreferrer"` and a ↗ marker. */
  external: boolean;
};

/** A row standing in for an item this visitor may not open. Carries no identity. */
export type SchedulePlaceholderRow = {
  kind: 'placeholder';
  id: string;
  typeLabel: string;
  /** Preformatted, or null when the item has no deadline. */
  due: string | null;
};

export type ScheduleRow = ScheduleLinkRow | SchedulePlaceholderRow;

export type ScheduleSection = { id: string; title: string; rows: ScheduleRow[] };

/**
 * The per-site facts this mapper cannot derive: where each item type's link
 * points, and which zone a deadline reads in. Supplied by the route, which is
 * the layer that knows the host and has the site row.
 */
export type ScheduleTargets = {
  /** A page on this site: its slug, or its id when the title reduced to nothing. */
  pagePath: (page: { slug: string | null; id: string }) => string;
  /** Origin of the slides service. */
  slidesUrl: string;
  /** The viewer's in-app classroom base, e.g. `https://app.example/student/cs52`. */
  appBase: string;
  /**
   * The course's IANA zone (`classroom_sites.timezone`), or null for none set.
   *
   * Required rather than optional on purpose: a forgotten zone is invisible in
   * review and off by up to a day in production, so every call site has to say
   * which of the two behaviours it wants.
   */
  timezone: string | null;
};

/**
 * Format a placeholder's deadline in the course's zone, tolerating the string a
 * serialized Date becomes.
 *
 * `dayjs.utc(value)` and never `dayjs(value)`: the latter reads the process
 * zone, which is the bug this exists to close. It also fixes what a naive
 * timestamp means — a stored instant is UTC, so `'2026-09-13T03:59:00'` without
 * a `Z` has to parse as UTC rather than as "3:59am wherever this container is".
 *
 * With no zone the date is stamped `(UTC)`. That suffix is not decoration: a
 * bare "Sep 13, 2026" on a page with no zone anywhere in it is a date whose
 * meaning depends on a server setting the reader cannot see, and for a deadline
 * that ambiguity is worth four characters of noise.
 */
function formatDue(dueAt: Date | string | null, zone: string | null): string | null {
  if (!dueAt) return null;

  const instant = dayjs.utc(dueAt);
  if (!instant.isValid()) return null;

  const asUtc = () => `${instant.format(DATE_FORMAT)} (UTC)`;
  if (!zone) return asUtc();

  // The service refuses a zone Intl cannot build a formatter for, but this is a
  // PUBLIC, unauthenticated render and the column is reachable by a psql
  // session and the DB's shape-only CHECK. Falling back beats a 500 on the
  // whole schedule for one bad row, and the reader still gets an honest date.
  try {
    const zoned = instant.tz(zone);
    return zoned.isValid() ? zoned.format(DATE_FORMAT) : asUtc();
  } catch {
    return asUtc();
  }
}

function toLinkRow(item: Extract<ScheduleItem, { kind: 'visible' }>, targets: ScheduleTargets) {
  const label = (value: string | undefined) => value || 'Untitled';

  if (item.item_type === 'PAGE' && item.page) {
    return {
      kind: 'link' as const,
      label: label(item.page.title),
      href: targets.pagePath(item.page),
      typeLabel: ITEM_TYPE_LABEL.PAGE,
      external: false,
    };
  }
  if (item.item_type === 'SLIDE' && item.slide) {
    return {
      kind: 'link' as const,
      label: label(item.slide.title),
      href: `${targets.slidesUrl}/${item.slide.id}`,
      typeLabel: ITEM_TYPE_LABEL.SLIDE,
      external: true,
    };
  }
  if (item.item_type === 'REPOSITORY' && item.repository) {
    return {
      kind: 'link' as const,
      label: label(item.repository.title),
      href: `${targets.appBase}/repos`,
      typeLabel: ITEM_TYPE_LABEL.REPOSITORY,
      external: true,
    };
  }
  if (item.item_type === 'QUIZ' && item.quiz) {
    return {
      kind: 'link' as const,
      label: label(item.quiz.name),
      href: `${targets.appBase}/quizzes`,
      typeLabel: ITEM_TYPE_LABEL.QUIZ,
      external: true,
    };
  }
  // A visible item whose target row vanished between the include and here.
  // Dropped rather than rendered as a placeholder: a placeholder is a promise
  // that something is there, and nothing is.
  return null;
}

/**
 * One module's items as rows, in item order.
 *
 * Placeholders keep their positions rather than being collected at the end:
 * where a redacted item sits is part of the structure the public schedule is
 * meant to convey, and re-sorting would imply an ordering the instructor did
 * not author.
 */
export function toScheduleRows(items: ScheduleItem[], targets: ScheduleTargets): ScheduleRow[] {
  return items.flatMap((item): ScheduleRow[] => {
    if (item.kind === 'placeholder') {
      return [
        {
          kind: 'placeholder',
          id: item.id,
          typeLabel: ITEM_TYPE_LABEL[item.item_type],
          due: formatDue(item.due_at, targets.timezone),
        },
      ];
    }

    const row = toLinkRow(item, targets);
    return row ? [row] : [];
  });
}

/**
 * Every module as a section, INCLUDING the ones whose rows are all placeholders
 * and the ones with no rows at all.
 *
 * Nothing is dropped here on purpose. The service already decided which modules
 * a viewer may know about (`is_published && is_public`), and for the anonymous
 * schedule a module's existence is the point: a bare title with no rows says
 * "this unit is coming", which is true and is not a leak.
 */
export function toScheduleSections(
  modules: ScheduleModule[],
  targets: ScheduleTargets
): ScheduleSection[] {
  return modules.map(module => ({
    id: module.id,
    title: module.title,
    rows: toScheduleRows(module.items, targets),
  }));
}
