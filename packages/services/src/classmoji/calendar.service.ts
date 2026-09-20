import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { EventType } from '@prisma/client';
import { pagesUrl } from '../emails/escape.ts';
import {
  CalendarTimeRangeError,
  isFeaturedLinkRow,
  resolveFeaturedLink,
  type FeaturedLinkKind,
  type FeaturedLinkRef,
} from './calendarPolicy.ts';

type DateInput = Date | string;
type CalendarEditScope = 'this_only' | 'this_and_future' | 'all';

interface OccurrenceLink {
  occurrence_date: Date | null;
}

/**
 * A stored link row, as the calendar query loads it.
 *
 * The `*_id` columns are declared alongside the joined row because the edit
 * modal rebuilds its pickers from them — see `CalendarRawLinkRow` below.
 */
interface CalendarPageLink extends OccurrenceLink {
  page_id: string;
  featured: boolean;
  page: {
    id: string;
    title: string;
    is_draft: boolean;
  } | null;
}

interface CalendarSlideLink extends OccurrenceLink {
  slide_id: string;
  featured: boolean;
  slide: {
    id: string;
    title: string;
    is_draft: boolean;
  } | null;
}

interface CalendarAssignmentLink extends OccurrenceLink {
  assignment_id: string;
  featured: boolean;
  assignment: {
    id: string;
    title: string;
    slug: string | null;
    is_published: boolean;
    repository: {
      id: string;
      title: string;
      slug: string | null;
      is_published: boolean;
    } | null;
  } | null;
}

/** A linked page as the calendar DISPLAYS it. */
interface CalendarDisplayPage {
  page: {
    id: string;
    title: string;
    is_draft: boolean;
  };
  /** Starred for the month view. See `CalendarFeaturedResource`. */
  featured: boolean;
}

/** A linked deck as the calendar DISPLAYS it. */
interface CalendarDisplaySlide {
  slide: {
    id: string;
    title: string;
    is_draft: boolean;
  };
  featured: boolean;
}

/** A linked assignment as the calendar DISPLAYS it, with its repository. */
interface CalendarDisplayAssignment {
  assignment: {
    id: string;
    title: string;
    slug: string | null;
    is_published: boolean;
  };
  repository: {
    id: string;
    title: string;
    slug: string | null;
    is_published: boolean;
  } | null;
  featured: boolean;
}

interface CalendarDisplayLinks {
  pages: CalendarDisplayPage[];
  slides: CalendarDisplaySlide[];
  assignments: CalendarDisplayAssignment[];
}

/**
 * The ONE linked resource the month view shows under this event, already
 * resolved for the viewer being answered.
 *
 * Derived after both filters — the occurrence's links, then the ones this
 * viewer may see — so it is null rather than withheld when a student's event
 * has a starred draft behind it. A student is not told that something is
 * starred, only shown nothing, which is also what an unstarred event shows.
 *
 * `is_draft` is what the Draft treatment reads, and only staff are ever handed
 * a true one. For an assignment it means "the class cannot see this yet",
 * covering an unpublished assignment AND one in an unpublished repository —
 * the pair the link list already marks together.
 */
interface CalendarFeaturedResource {
  kind: FeaturedLinkKind;
  id: string;
  title: string;
  is_draft: boolean;
}

/** What the mapper below returns: the display arrays and the star among them. */
interface CalendarDisplayLinksWithFeatured extends CalendarDisplayLinks {
  featured: CalendarFeaturedResource | null;
}

/**
 * The stored link rows echoed back under `_raw*Links` when a caller asks for
 * them, carrying only what the edit modal reads: which resource, and which
 * occurrence it is attached to. The joined page/deck/assignment rows are NOT
 * repeated here — the display arrays above are where linked content is read.
 */
interface CalendarRawPageLink extends OccurrenceLink {
  page_id: string;
  /** Which chip the edit modal draws the star on when it prefills. */
  featured: boolean;
}

interface CalendarRawSlideLink extends OccurrenceLink {
  slide_id: string;
  featured: boolean;
}

interface CalendarRawAssignmentLink extends OccurrenceLink {
  assignment_id: string;
  featured: boolean;
}

interface CalendarEventOverrideShape {
  id?: string;
  date: Date | string;
  is_cancelled: boolean;
  new_start_time: Date | string | null;
  new_end_time: Date | string | null;
  new_location: string | null;
  new_meeting_link: string | null;
}

interface CalendarRecurrenceRule {
  days?: string[];
  until?: string | null;
  [key: string]: Prisma.JsonValue | undefined;
}

/**
 * A stored CalendarEvent row with its link relations — the INPUT to expansion.
 *
 * Fields are declared one by one rather than through an index signature: the
 * expansion below copies this row into the display shape field by field, and an
 * index signature would let a column join that copy without anyone deciding it
 * should.
 */
interface CalendarEventWithLinks {
  id: string;
  created_by: string;
  event_type: EventType;
  title: string;
  description: string | null;
  is_recurring: boolean;
  recurrence_rule: Prisma.JsonValue | null;
  creator?: { id: string; name: string | null; login: string | null } | null;
  pageLinks: CalendarPageLink[];
  slideLinks: CalendarSlideLink[];
  assignmentLinks: CalendarAssignmentLink[];
  overrides?: CalendarEventOverrideShape[];
  start_time: Date;
  end_time: Date;
  location: string | null;
  meeting_link: string | null;
}

/**
 * One occurrence as the calendar DISPLAYS it — the OUTPUT of expansion.
 *
 * Built field by field from the stored row: every key here is one a calendar
 * surface reads (both grids, the event card, the link list, the edit modal, the
 * MCP calendar reads, the ICS feed). The stored link relations are not among
 * them; linked content travels as the visibility-filtered, occurrence-filtered
 * `pages`/`slides`/`assignments` arrays, and the `_raw*Links` arrays exist only
 * for callers that asked for them.
 */
interface CalendarExpandedEvent extends CalendarDisplayLinks {
  id: string;
  created_by: string;
  event_type: EventType;
  title: string;
  description: string | null;
  start_time: Date;
  end_time: Date;
  location: string | null;
  meeting_link: string | null;
  is_recurring: boolean;
  recurrence_rule: Prisma.JsonValue | null;
  creator: { id: string; name: string | null; login: string | null } | null;
  is_overridden: boolean;
  featured_resource: CalendarFeaturedResource | null;
  occurrence_date?: Date;
  _rawPageLinks?: CalendarRawPageLink[];
  _rawSlideLinks?: CalendarRawSlideLink[];
  _rawAssignmentLinks?: CalendarRawAssignmentLink[];
}

interface CalendarDeadlineItem {
  id: string;
  event_type: 'DEADLINE';
  title: string;
  description: string;
  start_time: Date;
  end_time: Date;
  is_deadline: true;
  is_unpublished: boolean;
  assignment_id: string;
  repository_id: string;
  pages: CalendarDisplayPage[];
  slides: CalendarDisplaySlide[];
  /**
   * Always null. A deadline is not an event somebody links resources to — its
   * pages and decks come from the assignment — so there is no chip to star and
   * the month view shows nothing under it. Declared rather than omitted: these
   * items carry no index signature, so a caller reading `featured_resource`
   * across the union needs the key to exist on every variant.
   */
  featured_resource: null;
  github_issue_url: string | null;
}

/**
 * A form's `closes_at`, synthesized as a calendar item the same way an
 * assignment's `student_deadline` is. There is no CalendarEvent row behind it.
 *
 * `event_type: 'DEADLINE'` is deliberately reused rather than inventing a sixth
 * type: it is already a synthetic literal (not a value of the Prisma EventType
 * enum), it is already in the calendar's event-type filter list, and the ICS
 * generator already renders it as an all-day event. A form close IS a deadline.
 *
 * `is_form_close` is what tells the two apart. It matters: `is_deadline` alone
 * makes an item draggable in the admin calendar, and that drag handler parses
 * an assignment id out of the event id. Form closes opt out of the drag.
 */
interface CalendarFormCloseItem {
  id: string;
  event_type: 'DEADLINE';
  title: string;
  description: string;
  start_time: Date;
  end_time: Date;
  is_deadline: true;
  is_form_close: true;
  is_unpublished: boolean;
  form_id: string;
  form_slug: string;
  form_status: string;
  form_access: string;
  /** Where clicking through goes: the responses view for staff, the fill page otherwise. */
  form_url: string;
  pages: CalendarDisplayPage[];
  slides: CalendarDisplaySlide[];
  /** Always null, for the same reason a deadline's is. */
  featured_resource: null;
  github_issue_url: null;
}

interface CalendarEventCreateData {
  event_type: EventType;
  title: string;
  description?: string | null;
  start_time: DateInput;
  end_time: DateInput;
  location?: string | null;
  meeting_link?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: Prisma.InputJsonObject | null;
}

interface CalendarEventUpdateData {
  event_type?: EventType;
  title?: string;
  description?: string | null;
  start_time?: DateInput;
  end_time?: DateInput;
  location?: string | null;
  meeting_link?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: Prisma.InputJsonObject | null;
}

interface CalendarOverrideData {
  is_cancelled?: boolean;
  new_start_time?: DateInput | null;
  new_end_time?: DateInput | null;
  new_location?: string | null;
  new_meeting_link?: string | null;
}

interface DeadlineRepositoryAssignment {
  provider_issue_number: number;
  git_repo: {
    name: string;
  };
}

/**
 * The write policy lives in a dependency-free module so the three surfaces that
 * enforce it — both web calendar actions and the MCP tools — can import the
 * real decision rather than a copy. Re-exported here because this is where
 * callers already look for it.
 */
export {
  ASSISTANT_EVENT_TYPE,
  ASSISTANT_EVENT_TYPE_MESSAGE,
  assistantMayChangeEventType,
  assistantMayCreateEventType,
  CalendarTimeRangeError,
  FEATURED_LINK_KINDS,
  isCalendarTimeRangeError,
  isFeaturedLinkRow,
  resolveFeaturedLink,
  toFeaturedLinkRef,
} from './calendarPolicy.ts';
export type { FeaturedLinkKind, FeaturedLinkRef } from './calendarPolicy.ts';

/**
 * An event must end strictly after it starts; a zero-length or inverted range
 * is refused.
 *
 * Only checked when BOTH edges are supplied, which is recurrence-independent.
 * A single moved edge is deliberately NOT compared against the stored row: for
 * a recurring series the stored `start_time`/`end_time` are the TEMPLATE's
 * absolute datetimes (dated at the series start), not this occurrence's, so the
 * comparison would refuse valid edits. calendar_event_update in apps/mcp draws
 * the same line, for the same reason.
 */
const assertEndAfterStart = (
  start: DateInput | null | undefined,
  end: DateInput | null | undefined
): void => {
  if (start === undefined || start === null || end === undefined || end === null) return;

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    throw new CalendarTimeRangeError();
  }
};

const isJsonObject = (
  value: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined
): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getRecurrenceRule = (
  value: Prisma.JsonValue | null | undefined
): CalendarRecurrenceRule | null => {
  if (!isJsonObject(value)) {
    return null;
  }

  const days = Array.isArray(value.days)
    ? value.days.filter((day): day is string => typeof day === 'string')
    : undefined;
  const until = typeof value.until === 'string' ? value.until : null;

  return {
    ...value,
    days,
    until,
  };
};

const toInputJsonObject = (value: Prisma.JsonValue | null | undefined): Prisma.InputJsonObject => {
  if (!isJsonObject(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value)) as Prisma.InputJsonObject;
};

const toDate = (value: DateInput): Date => new Date(value);
const toOptionalUpdateDate = (value: DateInput | null | undefined): Date | undefined =>
  value ? new Date(value) : undefined;
const toOptionalDate = (
  value: DateInput | null | undefined,
  nullWhenMissing: boolean = false
): Date | null | undefined => {
  if (value === undefined) return nullWhenMissing ? null : undefined;
  if (value === null) return null;
  return new Date(value);
};

const toNullableJsonInput = (
  value: Prisma.InputJsonObject | null | undefined
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value;
};

const getDayName = (date: Date): string => {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
};

/**
 * Check if two dates are the same day (ignoring time)
 * Uses UTC methods to avoid timezone issues when comparing dates from DB (UTC) with local dates
 */
const isSameDate = (date1: Date, date2: Date): boolean => {
  return (
    date1.getUTCFullYear() === date2.getUTCFullYear() &&
    date1.getUTCMonth() === date2.getUTCMonth() &&
    date1.getUTCDate() === date2.getUTCDate()
  );
};

/**
 * Normalize a date to midnight UTC for comparison (strips time component)
 * Uses UTC methods to avoid timezone issues when comparing dates from DB (UTC) with local dates
 */
const normalizeDate = (date: Date): Date => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Filter links for a specific occurrence date
 * - For non-recurring events: NULL occurrence_date links match (template links)
 * - For recurring events: Only links with matching occurrence_date
 *   (NULL links are ignored - they were created before the event became recurring)
 * @param {Array} links - Array of link objects with occurrence_date
 * @param {Date} occurrenceDate - The date of the occurrence to filter for
 * @param {boolean} isRecurring - Whether the event is recurring
 */
const filterLinksForOccurrence = <T extends OccurrenceLink>(
  links: T[],
  occurrenceDate: Date,
  isRecurring: boolean = false
): T[] => {
  if (!links || links.length === 0) return [];

  const normalizedOccurrence = normalizeDate(occurrenceDate);

  // For recurring events: only use links with matching occurrence_date
  // (NULL links are stale from before the event was made recurring)
  if (isRecurring) {
    return links.filter(
      link =>
        link.occurrence_date &&
        normalizeDate(link.occurrence_date).getTime() === normalizedOccurrence.getTime()
    );
  }

  // For non-recurring events: use NULL links (template) and any dated links that match
  return links.filter(
    link =>
      !link.occurrence_date ||
      normalizeDate(link.occurrence_date).getTime() === normalizedOccurrence.getTime()
  );
};

/**
 * Build the linked-content arrays the calendar renders, from the stored link
 * rows for one occurrence.
 *
 * Each entry is assembled field by field, so a column added to the query later
 * does not become part of what the calendar hands out.
 *
 * @param {boolean} [canSeeDrafts=false] - Whether the viewer may see unpublished
 *   linked content: draft pages, draft decks, and assignments (or repositories)
 *   that are not published yet. Defaults to false, so a caller that says nothing
 *   gets the published-only view.
 */
const mapLinksToDisplayFormat = (
  pageLinks: CalendarPageLink[],
  slideLinks: CalendarSlideLink[],
  assignmentLinks: CalendarAssignmentLink[],
  canSeeDrafts: boolean = false
): CalendarDisplayLinksWithFeatured => {
  /**
   * The starred rows that SURVIVED the visibility filter, in the order the
   * three kinds are mapped. Pushed from inside the filters below, so a
   * resource this viewer may not see cannot become their starred resource —
   * not even as an id.
   */
  const starred: Array<CalendarFeaturedResource & { dated: boolean }> = [];

  const pages = (pageLinks || []).flatMap(l => {
    if (!l.page || (!canSeeDrafts && l.page.is_draft)) return [];
    if (l.featured) {
      starred.push({
        kind: 'page',
        id: l.page.id,
        title: l.page.title,
        is_draft: l.page.is_draft,
        dated: Boolean(l.occurrence_date),
      });
    }
    return [
      {
        page: { id: l.page.id, title: l.page.title, is_draft: l.page.is_draft },
        featured: l.featured,
      },
    ];
  });

  const slides = (slideLinks || []).flatMap(l => {
    if (!l.slide || (!canSeeDrafts && l.slide.is_draft)) return [];
    if (l.featured) {
      starred.push({
        kind: 'slide',
        id: l.slide.id,
        title: l.slide.title,
        is_draft: l.slide.is_draft,
        dated: Boolean(l.occurrence_date),
      });
    }
    return [
      {
        slide: { id: l.slide.id, title: l.slide.title, is_draft: l.slide.is_draft },
        featured: l.featured,
      },
    ];
  });

  // An assignment link follows the publication state of BOTH the assignment and
  // the repository it lives in — the repositories view applies the same pair —
  // so an unpublished repository hides its assignments' links too.
  const assignments = (assignmentLinks || []).flatMap(l => {
    const assignment = l.assignment;
    if (!assignment) return [];
    const published = assignment.is_published && assignment.repository?.is_published !== false;
    if (!canSeeDrafts && !published) return [];

    if (l.featured) {
      starred.push({
        kind: 'assignment',
        id: assignment.id,
        title: assignment.title,
        // "The class cannot see this yet" — the pair the link list marks
        // together, so an assignment in an unpublished repository counts.
        is_draft: !published,
        dated: Boolean(l.occurrence_date),
      });
    }

    return [
      {
        assignment: {
          id: assignment.id,
          title: assignment.title,
          slug: assignment.slug,
          is_published: assignment.is_published,
        },
        repository: assignment.repository
          ? {
              id: assignment.repository.id,
              title: assignment.repository.title,
              slug: assignment.repository.slug,
              is_published: assignment.repository.is_published,
            }
          : null,
        featured: l.featured,
      },
    ];
  });

  // Normally there is at most one, which the write and the database both hold
  // to. One case can surface two: a NON-recurring event reads its undated
  // links AND any dated link that falls on its own date, and those are two
  // buckets with a star apiece — a series that was flattened back to a single
  // event, say. The dated row wins, because it was written against the date
  // being shown; without a rule the answer would depend on row order.
  const featuredMatch = starred.find(s => s.dated) ?? starred[0] ?? null;
  const featured = featuredMatch
    ? {
        kind: featuredMatch.kind,
        id: featuredMatch.id,
        title: featuredMatch.title,
        is_draft: featuredMatch.is_draft,
      }
    : null;

  return { pages, slides, assignments, featured };
};

/**
 * Build one occurrence's display object from the stored row.
 *
 * The stored row's own relations (`pageLinks`, `slideLinks`, `assignmentLinks`,
 * `overrides`) are deliberately not copied across: linked content travels as
 * the already-filtered arrays in `links`, and the raw rows go out only under
 * `_raw*Links`, only when the caller asked for them.
 */
const buildOccurrence = (
  event: CalendarEventWithLinks,
  occurrence: {
    start_time: Date;
    end_time: Date;
    location: string | null;
    meeting_link: string | null;
    occurrence_date?: Date;
    is_overridden?: boolean;
  },
  links: CalendarDisplayLinksWithFeatured,
  includeRawLinks: boolean
): CalendarExpandedEvent => {
  const expanded: CalendarExpandedEvent = {
    id: event.id,
    created_by: event.created_by,
    event_type: event.event_type,
    title: event.title,
    description: event.description,
    start_time: occurrence.start_time,
    end_time: occurrence.end_time,
    location: occurrence.location,
    meeting_link: occurrence.meeting_link,
    is_recurring: event.is_recurring,
    recurrence_rule: event.recurrence_rule,
    creator: event.creator ?? null,
    is_overridden: occurrence.is_overridden ?? false,
    ...(occurrence.occurrence_date ? { occurrence_date: occurrence.occurrence_date } : {}),
    pages: links.pages,
    slides: links.slides,
    assignments: links.assignments,
    featured_resource: links.featured,
  };

  // Only for callers editing the event: which resource is attached to which
  // occurrence, and which of them is starred, so the edit modal can prefill one
  // date's pickers.
  if (includeRawLinks) {
    expanded._rawPageLinks = event.pageLinks.map(l => ({
      page_id: l.page_id,
      occurrence_date: l.occurrence_date,
      featured: l.featured,
    }));
    expanded._rawSlideLinks = event.slideLinks.map(l => ({
      slide_id: l.slide_id,
      occurrence_date: l.occurrence_date,
      featured: l.featured,
    }));
    expanded._rawAssignmentLinks = event.assignmentLinks.map(l => ({
      assignment_id: l.assignment_id,
      occurrence_date: l.occurrence_date,
      featured: l.featured,
    }));
  }

  return expanded;
};

/**
 * Expand recurring event into individual occurrences within date range
 * @param {object} event - The calendar event to expand
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {boolean} includeRawLinks - Whether to include raw link data for admin UI editing
 * @param {boolean} canSeeDrafts - Whether the viewer may see unpublished linked content
 */
const expandRecurringEvent = (
  event: CalendarEventWithLinks,
  startDate: Date,
  endDate: Date,
  includeRawLinks: boolean = false,
  canSeeDrafts: boolean = false
): CalendarExpandedEvent[] => {
  /** The links for one date, filtered for the occurrence and for the viewer. */
  const linksFor = (occurrenceDate: Date, isRecurring: boolean): CalendarDisplayLinksWithFeatured =>
    mapLinksToDisplayFormat(
      filterLinksForOccurrence(event.pageLinks, occurrenceDate, isRecurring),
      filterLinksForOccurrence(event.slideLinks, occurrenceDate, isRecurring),
      filterLinksForOccurrence(event.assignmentLinks, occurrenceDate, isRecurring),
      canSeeDrafts
    );

  /** The single occurrence an event without a usable recurrence rule has. */
  const singleOccurrence = (): CalendarExpandedEvent[] => [
    buildOccurrence(
      event,
      {
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
        meeting_link: event.meeting_link,
      },
      // isRecurring=false, so NULL occurrence_date links are included
      linksFor(event.start_time, false),
      includeRawLinks
    ),
  ];

  // For non-recurring events, just map links to display format
  if (!event.is_recurring || !event.recurrence_rule) {
    return singleOccurrence();
  }

  const occurrences = [];
  const recurrenceRule = getRecurrenceRule(event.recurrence_rule);
  const { days, until } = recurrenceRule ?? {};

  if (!days || !Array.isArray(days)) {
    return singleOccurrence();
  }

  const currentDate = new Date(event.start_time);
  // Handle missing or invalid 'until' date - default to rangeEnd if not set
  const endDateLimit = until ? new Date(until) : null;
  const rangeStart = new Date(startDate);
  const rangeEnd = new Date(endDate);

  // Use the earlier of endDateLimit or rangeEnd, handling case where endDateLimit is not set
  const effectiveEndDate =
    endDateLimit && !isNaN(endDateLimit.getTime())
      ? endDateLimit < rangeEnd
        ? endDateLimit
        : rangeEnd
      : rangeEnd;

  while (currentDate <= effectiveEndDate) {
    const dayName = getDayName(currentDate);

    if (days.includes(dayName) && currentDate >= rangeStart) {
      const override = event.overrides?.find(o => isSameDate(new Date(o.date), currentDate));

      if (override?.is_cancelled) {
        // Skip this occurrence
      } else {
        // Filter and map links for this specific occurrence
        // Pass isRecurring=true so only occurrence-specific links are included
        const occurrenceDate = new Date(currentDate);
        const links = linksFor(occurrenceDate, true);

        if (override) {
          // Use override times/location
          const duration =
            new Date(event.end_time).getTime() - new Date(event.start_time).getTime();
          const occurrenceStart = override.new_start_time
            ? new Date(override.new_start_time)
            : new Date(
                currentDate.getFullYear(),
                currentDate.getMonth(),
                currentDate.getDate(),
                new Date(event.start_time).getHours(),
                new Date(event.start_time).getMinutes()
              );
          const occurrenceEnd = override.new_end_time
            ? new Date(override.new_end_time)
            : new Date(occurrenceStart.getTime() + duration);

          occurrences.push(
            buildOccurrence(
              event,
              {
                start_time: occurrenceStart,
                end_time: occurrenceEnd,
                location: override.new_location || event.location,
                meeting_link: override.new_meeting_link || event.meeting_link,
                is_overridden: true,
                occurrence_date: occurrenceDate,
              },
              links,
              includeRawLinks
            )
          );
        } else {
          // Use template times for this date
          const duration =
            new Date(event.end_time).getTime() - new Date(event.start_time).getTime();
          const occurrenceStart = new Date(
            currentDate.getFullYear(),
            currentDate.getMonth(),
            currentDate.getDate(),
            new Date(event.start_time).getHours(),
            new Date(event.start_time).getMinutes()
          );
          const occurrenceEnd = new Date(occurrenceStart.getTime() + duration);

          occurrences.push(
            buildOccurrence(
              event,
              {
                start_time: occurrenceStart,
                end_time: occurrenceEnd,
                location: event.location,
                meeting_link: event.meeting_link,
                occurrence_date: occurrenceDate,
              },
              links,
              includeRawLinks
            )
          );
        }
      }
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return occurrences;
};

/**
 * Get all calendar events for a classroom within a date range
 * Includes recurring event expansion and deadline integration
 * @param {string} classroomId - The classroom ID
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} [userId] - Optional user ID to include their GitHub issue links for deadlines
 * @param {boolean} [includeRawLinks=false] - Include raw link data for admin UI editing
 * @param {boolean} [includeUnpublished=false] - Include unpublished assignments (for admin view)
 * @param {boolean} [options.canSeeDrafts=false] - Whether the viewer may see unpublished LINKED
 *   content: draft pages, draft decks, and links to assignments that are not published yet. All
 *   staff may (OWNER, TEACHER and ASSISTANT alike); students may not. Kept separate from
 *   `includeUnpublished`, which decides whether unpublished assignments get a DEADLINE item of
 *   their own — the two answer different questions and are free to diverge. Defaults to false, so
 *   a caller that says nothing gets the student view.
 */
export const getClassroomCalendar = async (
  classroomId: string,
  startDate: Date,
  endDate: Date,
  userId: string | null = null,
  includeRawLinks: boolean = false,
  includeUnpublished: boolean = false,
  {
    canManageForms = false,
    canSeeDrafts = false,
  }: { canManageForms?: boolean; canSeeDrafts?: boolean } = {}
) => {
  // Get all calendar events that could appear in this range
  const events = await getPrisma().calendarEvent.findMany({
    where: {
      classroom_id: classroomId,
      OR: [
        // One-time events in range
        {
          is_recurring: false,
          start_time: {
            gte: startDate,
            lte: endDate,
          },
        },
        // Recurring events that started before range end and recur until after range start
        {
          is_recurring: true,
          start_time: {
            lte: endDate,
          },
        },
      ],
    },
    include: {
      creator: {
        select: {
          id: true,
          name: true,
          login: true,
        },
      },
      overrides: true,
      pageLinks: {
        include: {
          page: {
            select: { id: true, title: true, is_draft: true },
          },
        },
        orderBy: { order: 'asc' },
      },
      slideLinks: {
        include: {
          slide: {
            select: { id: true, title: true, is_draft: true },
          },
        },
        orderBy: { order: 'asc' },
      },
      assignmentLinks: {
        include: {
          // `is_published` on both rows is what decides whether this link is
          // shown at all: a link to an assignment (or to a repository) that has
          // not been published is staff-only.
          assignment: {
            select: {
              id: true,
              title: true,
              slug: true,
              is_published: true,
              repository: {
                select: { id: true, title: true, slug: true, is_published: true },
              },
            },
          },
        },
        orderBy: { order: 'asc' },
      },
    },
    orderBy: {
      start_time: 'asc',
    },
  });

  // Expand recurring events (pass includeRawLinks for admin UI editing)
  const expandedEvents = events.flatMap(event =>
    expandRecurringEvent(event, startDate, endDate, includeRawLinks, canSeeDrafts)
  );

  // Get deadlines from Assignments (pass userId to include GitHub issue links)
  const deadlines = await getDeadlinesForRange(
    classroomId,
    startDate,
    endDate,
    userId,
    includeUnpublished,
    { canSeeDrafts }
  );

  // Get form close dates. Where the click-through goes is a role question, and
  // deliberately NOT keyed off `includeUnpublished`: the assistant calendar
  // passes that too, but the forms responses view is OWNER|TEACHER only
  // (apps/pages formAuth.server), so an assistant sent there would get a 403.
  // Callers pass `canManageForms` from the resolved membership role.
  const formCloses = await getFormCloseEventsForRange(classroomId, startDate, endDate, {
    forStaff: canManageForms,
  });

  // Combine and sort by start time
  const allEvents = [...expandedEvents, ...deadlines, ...formCloses].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  return allEvents;
};

/**
 * One item as the calendar hands it to a caller: an expanded CalendarEvent
 * occurrence, a synthesized assignment deadline, or a synthesized form close.
 *
 * Derived from the function rather than written out, so it cannot describe a
 * payload the service no longer returns. The webapp keeps its own client-side
 * shape (`CalendarEventWithLinks`) — importing this one into a component would
 * pull the service graph into the browser bundle — and a type-level conformance
 * test in the webapp checks the two still agree where they must.
 */
export type ClassroomCalendarItem = Awaited<ReturnType<typeof getClassroomCalendar>>[number];

/**
 * Get form close dates as calendar items.
 *
 * Mirrors getDeadlinesForRange: no CalendarEvent rows are written, the items are
 * synthesized per request from `Form.closes_at`.
 *
 * Which forms appear:
 *   - OPEN and CLOSED forms with a `closes_at` in range. A CLOSED form keeps its
 *     event on purpose — the date it closed is real history, and having an event
 *     vanish from the calendar the moment an instructor closes the form would be
 *     worse than showing it. This matches assignment deadlines, which stay on the
 *     calendar after they pass.
 *   - DRAFT forms never appear, in either view. A draft has never been published,
 *     has no revision to render, and its close date is not yet a commitment. It
 *     is not surfaced to staff either — unlike an unpublished assignment, which
 *     staff see flagged via `is_unpublished` — because a draft form's close date
 *     is routinely a placeholder from the builder.
 *   - A form with no `closes_at` has no deadline and therefore no event.
 *
 * @param {string} classroomId - The classroom ID
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {boolean} [options.forStaff=false] - Point the link at the responses view instead of the
 *   fill page. Only for callers who have established the viewer is OWNER or TEACHER: the responses
 *   view in apps/pages is gated to those two roles, so an assistant sent there gets a 403.
 */
export const getFormCloseEventsForRange = async (
  classroomId: string,
  startDate: Date,
  endDate: Date,
  { forStaff = false }: { forStaff?: boolean } = {}
): Promise<CalendarFormCloseItem[]> => {
  const forms = await getPrisma().form.findMany({
    where: {
      classroom_id: classroomId,
      status: { in: ['OPEN', 'CLOSED'] },
      closes_at: { gte: startDate, lte: endDate },
    },
    select: {
      id: true,
      title: true,
      slug: true,
      description: true,
      status: true,
      access: true,
      closes_at: true,
      classroom: { select: { slug: true } },
    },
    orderBy: { closes_at: 'asc' },
  });

  const base = pagesUrl();

  return forms.map(form => {
    const closesAt = form.closes_at!;
    const formPath = `${base}/${form.classroom.slug}/forms/${form.slug}`;

    return {
      id: `form-close-${form.id}`,
      event_type: 'DEADLINE' as const,
      title: `${form.title} closes`,
      description: form.description ?? 'Form',
      start_time: closesAt,
      end_time: closesAt,
      is_deadline: true as const,
      is_form_close: true as const,
      // Draft forms are filtered out above, so nothing that reaches here is
      // unpublished. The field exists for shape parity with deadline items.
      is_unpublished: false,
      form_id: form.id,
      form_slug: form.slug,
      form_status: form.status,
      form_access: form.access,
      form_url: forStaff ? `${formPath}/responses` : formPath,
      pages: [],
      slides: [],
      featured_resource: null,
      github_issue_url: null,
    };
  });
};

/**
 * Get assignment deadlines as calendar items
 * @param {string} classroomId - The classroom ID
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} [userId] - Optional user ID to include their GitHub issue links
 * @param {boolean} [includeUnpublished=false] - Include unpublished assignments (for admin view)
 * @param {boolean} [options.canSeeDrafts=false] - Whether the viewer may see draft pages and decks
 *   attached to the assignment. Separate from `includeUnpublished`, which decides whether the
 *   assignment appears at all — see `getClassroomCalendar`.
 */
export const getDeadlinesForRange = async (
  classroomId: string,
  startDate: Date,
  endDate: Date,
  userId: string | null = null,
  includeUnpublished: boolean = false,
  { canSeeDrafts = false }: { canSeeDrafts?: boolean } = {}
) => {
  const assignments = await getPrisma().assignment.findMany({
    where: {
      repository: {
        classroom_id: classroomId,
        // Only filter by is_published if not including unpublished
        ...(includeUnpublished ? {} : { is_published: true }),
      },
      // Only filter by is_published if not including unpublished
      ...(includeUnpublished ? {} : { is_published: true }),
      student_deadline: {
        gte: startDate,
        lte: endDate,
      },
    },
    include: {
      repository: {
        select: {
          id: true,
          title: true,
          is_published: true,
          classroom: {
            select: {
              git_organization: {
                select: {
                  login: true,
                },
              },
            },
          },
        },
      },
      pages: {
        // Draft pages are staff-only, the same rule the event-link leg applies
        ...(canSeeDrafts
          ? {}
          : {
              where: {
                page: {
                  is_draft: false,
                },
              },
            }),
        include: {
          page: {
            select: {
              id: true,
              title: true,
              // Selected so a draft the viewer IS allowed to see can be shown
              // as one; the flag is what the Draft treatment reads.
              is_draft: true,
            },
          },
        },
        orderBy: {
          order: 'asc',
        },
      },
      slides: {
        // Draft decks are staff-only, same as the pages above
        ...(canSeeDrafts
          ? {}
          : {
              where: {
                slide: {
                  is_draft: false,
                },
              },
            }),
        include: {
          slide: {
            select: {
              id: true,
              title: true,
              is_draft: true,
            },
          },
        },
        orderBy: {
          order: 'asc',
        },
      },
      // Include user's gitRepo assignment if userId provided
      ...(userId && {
        git_repo_assignments: {
          where: {
            git_repo: {
              student_id: userId,
            },
          },
          include: {
            git_repo: {
              select: {
                name: true,
              },
            },
          },
          take: 1,
        },
      }),
    },
    orderBy: {
      student_deadline: 'asc',
    },
  });

  return assignments.map(assignment => {
    const repoAssignment = (
      'git_repo_assignments' in assignment ? (assignment.git_repo_assignments?.[0] ?? null) : null
    ) as DeadlineRepositoryAssignment | null;
    const gitOrgLogin = assignment.repository.classroom?.git_organization?.login;

    // Build GitHub issue URL if user has a repo assignment
    let github_issue_url = null;
    if (repoAssignment && gitOrgLogin) {
      github_issue_url = `https://github.com/${gitOrgLogin}/${repoAssignment.git_repo.name}/issues/${repoAssignment.provider_issue_number}`;
    }

    // Flag unpublished content for admin UI styling
    const isUnpublished = !assignment.is_published || !assignment.repository?.is_published;

    const deadline: CalendarDeadlineItem = {
      id: `deadline-${assignment.id}`,
      event_type: 'DEADLINE',
      title: `Due: ${assignment.title}`,
      description: assignment.repository.title,
      start_time: assignment.student_deadline!,
      end_time: assignment.student_deadline!,
      is_deadline: true,
      is_unpublished: isUnpublished,
      assignment_id: assignment.id,
      repository_id: assignment.repository.id,
      // Built entry by entry, like the event-link leg: the stored link row
      // carries columns (ids, ordering, timestamps) the calendar never renders.
      pages: assignment.pages.flatMap(l =>
        l.page
          ? [
              {
                page: { id: l.page.id, title: l.page.title, is_draft: l.page.is_draft },
                // An assignment's own pages are not calendar links, so there is
                // no star to carry: the column lives on the CalendarEvent link
                // rows, which these are not.
                featured: false,
              },
            ]
          : []
      ),
      slides: assignment.slides.flatMap(l =>
        l.slide
          ? [
              {
                slide: { id: l.slide.id, title: l.slide.title, is_draft: l.slide.is_draft },
                featured: false,
              },
            ]
          : []
      ),
      featured_resource: null,
      github_issue_url,
    };

    return deadline;
  });
};

/**
 * Create a new calendar event
 */
export const createEvent = async (
  classroomId: string,
  userId: string,
  eventData: CalendarEventCreateData
) => {
  const {
    event_type,
    title,
    description,
    start_time,
    end_time,
    location,
    meeting_link,
    is_recurring,
    recurrence_rule,
  } = eventData;

  assertEndAfterStart(start_time, end_time);

  return getPrisma().calendarEvent.create({
    data: {
      classroom_id: classroomId,
      created_by: userId,
      event_type,
      title,
      description,
      start_time: toDate(start_time),
      end_time: toDate(end_time),
      location,
      meeting_link,
      is_recurring: is_recurring || false,
      recurrence_rule: is_recurring ? toNullableJsonInput(recurrence_rule) : Prisma.JsonNull,
    },
    include: {
      creator: {
        select: {
          id: true,
          name: true,
          login: true,
        },
      },
    },
  });
};

/**
 * Update an existing calendar event
 */
export const updateEvent = async (eventId: string, eventData: CalendarEventUpdateData) => {
  const {
    event_type,
    title,
    description,
    start_time,
    end_time,
    location,
    meeting_link,
    is_recurring,
    recurrence_rule,
  } = eventData;

  assertEndAfterStart(start_time, end_time);

  return getPrisma().calendarEvent.update({
    where: { id: eventId },
    data: {
      event_type,
      title,
      description,
      start_time: toOptionalUpdateDate(start_time),
      end_time: toOptionalUpdateDate(end_time),
      location,
      meeting_link,
      is_recurring,
      recurrence_rule: is_recurring ? toNullableJsonInput(recurrence_rule) : Prisma.JsonNull,
    },
    include: {
      creator: {
        select: {
          id: true,
          name: true,
          login: true,
        },
      },
      overrides: true,
    },
  });
};

/**
 * Delete a calendar event
 */
export const deleteEvent = async (eventId: string) => {
  return getPrisma().calendarEvent.delete({
    where: { id: eventId },
  });
};

/**
 * Update a recurring event with scope handling
 * @param {number} eventId - The event ID
 * @param {object} eventData - The updated event data
 * @param {string} editScope - 'this_only', 'this_and_future', or 'all'
 * @param {Date} occurrenceDate - The date of the specific occurrence being edited
 */
export const updateEventWithScope = async (
  eventId: string,
  eventData: CalendarEventUpdateData,
  editScope: CalendarEditScope,
  occurrenceDate: Date
) => {
  assertEndAfterStart(eventData.start_time, eventData.end_time);

  const event = await getPrisma().calendarEvent.findUnique({
    where: { id: eventId },
    include: { overrides: true },
  });

  if (!event) {
    throw new Error('Event not found');
  }

  switch (editScope) {
    case 'this_only': {
      // Create or update an override for this specific occurrence
      const existingOverride = event.overrides?.find(o =>
        isSameDate(new Date(o.date), occurrenceDate)
      );

      if (existingOverride) {
        await getPrisma().calendarEventOverride.update({
          where: { id: existingOverride.id },
          data: {
            new_start_time: toOptionalDate(eventData.start_time, true),
            new_end_time: toOptionalDate(eventData.end_time, true),
            new_location: eventData.location,
            new_meeting_link: eventData.meeting_link,
          },
        });
      } else {
        await getPrisma().calendarEventOverride.create({
          data: {
            event_id: eventId,
            date: occurrenceDate,
            new_start_time: toOptionalDate(eventData.start_time, true),
            new_end_time: toOptionalDate(eventData.end_time, true),
            new_location: eventData.location,
            new_meeting_link: eventData.meeting_link,
          },
        });
      }
      return event;
    }

    case 'this_and_future': {
      // Update the recurrence rule to end just before this occurrence
      // and create a new event starting from this date
      const dayBeforeOccurrence = new Date(occurrenceDate);
      dayBeforeOccurrence.setDate(dayBeforeOccurrence.getDate() - 1);

      // Links and overrides are both stored per occurrence date, so the split
      // has to divide them too: everything from this date on belongs to the new
      // event, and the dates before it stay behind. One boundary for both, at
      // midnight UTC — the normalisation the link writes already use, and the
      // one an override needs as well, since an override's `date` carries the
      // occurrence's time of day and would fall the wrong side of a bare
      // instant comparison.
      const splitFrom = normalizeDate(occurrenceDate);

      return getPrisma().$transaction(async tx => {
        // Update original event to end before this occurrence
        await tx.calendarEvent.update({
          where: { id: eventId },
          data: {
            recurrence_rule: {
              ...toInputJsonObject(event.recurrence_rule),
              until: dayBeforeOccurrence.toISOString(),
            },
          },
        });

        // Create new event starting from this occurrence
        const newEvent = await tx.calendarEvent.create({
          data: {
            classroom_id: event.classroom_id,
            created_by: event.created_by,
            event_type: eventData.event_type || event.event_type,
            title: eventData.title || event.title,
            description: eventData.description ?? event.description,
            start_time: eventData.start_time ? toDate(eventData.start_time) : event.start_time,
            end_time: eventData.end_time ? toDate(eventData.end_time) : event.end_time,
            location: eventData.location ?? event.location,
            meeting_link: eventData.meeting_link ?? event.meeting_link,
            is_recurring: eventData.is_recurring ?? event.is_recurring,
            recurrence_rule: toNullableJsonInput(
              eventData.recurrence_rule ?? toInputJsonObject(event.recurrence_rule)
            ),
          },
        });

        // A NULL occurrence_date never matches `gte`, so the undated bucket
        // stays with the original event — which is where a non-recurring
        // event's links live.
        const laterOccurrences = {
          event_id: eventId,
          occurrence_date: { gte: splitFrom },
        };
        const moveToNewEvent = { event_id: newEvent.id };

        await tx.calendarEventPageLink.updateMany({
          where: laterOccurrences,
          data: moveToNewEvent,
        });
        await tx.calendarEventSlideLink.updateMany({
          where: laterOccurrences,
          data: moveToNewEvent,
        });
        await tx.calendarEventAssignmentLink.updateMany({
          where: laterOccurrences,
          data: moveToNewEvent,
        });

        // The overrides for those dates go with them. Left behind they would
        // hang off a series that no longer reaches their date — invisible, and
        // a cancelled occurrence would quietly come back on the new event.
        await tx.calendarEventOverride.updateMany({
          where: { event_id: eventId, date: { gte: splitFrom } },
          data: moveToNewEvent,
        });

        return newEvent;
      });
    }

    case 'all': {
      // Update the entire event template. When the caller didn't address
      // recurrence at all (is_recurring undefined), leave recurrence_rule
      // untouched — forcing JsonNull here would wipe a recurring series on a
      // partial (e.g. title-only) update while is_recurring stayed true.
      return getPrisma().calendarEvent.update({
        where: { id: eventId },
        data: {
          event_type: eventData.event_type,
          title: eventData.title,
          description: eventData.description,
          start_time: toOptionalUpdateDate(eventData.start_time),
          end_time: toOptionalUpdateDate(eventData.end_time),
          location: eventData.location,
          meeting_link: eventData.meeting_link,
          is_recurring: eventData.is_recurring,
          recurrence_rule:
            eventData.is_recurring === undefined
              ? undefined
              : eventData.is_recurring
                ? toNullableJsonInput(eventData.recurrence_rule)
                : Prisma.JsonNull,
        },
      });
    }

    default:
      throw new Error(`Invalid edit scope: ${editScope}`);
  }
};

/**
 * Delete a recurring event with scope handling
 * @param {number} eventId - The event ID
 * @param {string} editScope - 'this_only', 'this_and_future', or 'all'
 * @param {Date} occurrenceDate - The date of the specific occurrence being deleted
 */
export const deleteEventWithScope = async (
  eventId: string,
  editScope: CalendarEditScope,
  occurrenceDate: Date
) => {
  const event = await getPrisma().calendarEvent.findUnique({
    where: { id: eventId },
    include: { overrides: true },
  });

  if (!event) {
    throw new Error('Event not found');
  }

  switch (editScope) {
    case 'this_only': {
      // Create a cancellation override for this specific occurrence
      const existingOverride = event.overrides?.find(o =>
        isSameDate(new Date(o.date), occurrenceDate)
      );

      if (existingOverride) {
        await getPrisma().calendarEventOverride.update({
          where: { id: existingOverride.id },
          data: { is_cancelled: true },
        });
      } else {
        await getPrisma().calendarEventOverride.create({
          data: {
            event_id: eventId,
            date: occurrenceDate,
            is_cancelled: true,
          },
        });
      }
      return { cancelled: true, occurrenceDate };
    }

    case 'this_and_future': {
      // Update the recurrence rule to end just before this occurrence
      const dayBeforeOccurrence = new Date(occurrenceDate);
      dayBeforeOccurrence.setDate(dayBeforeOccurrence.getDate() - 1);

      // The occurrences from this date on are gone, so their per-date rows go
      // with them. One boundary at midnight UTC for links AND overrides: an
      // override's `date` carries the occurrence's time of day, so comparing it
      // against the bare instant would spare the ones earlier in the same day.
      // The undated bucket (NULL occurrence_date) is not matched by `gte`.
      const deleteFrom = normalizeDate(occurrenceDate);
      const laterOccurrences = {
        event_id: eventId,
        occurrence_date: { gte: deleteFrom },
      };

      return getPrisma().$transaction(async tx => {
        // Also delete any overrides on or after this date
        await tx.calendarEventOverride.deleteMany({
          where: {
            event_id: eventId,
            date: { gte: deleteFrom },
          },
        });

        await tx.calendarEventPageLink.deleteMany({ where: laterOccurrences });
        await tx.calendarEventSlideLink.deleteMany({ where: laterOccurrences });
        await tx.calendarEventAssignmentLink.deleteMany({ where: laterOccurrences });

        return tx.calendarEvent.update({
          where: { id: eventId },
          data: {
            recurrence_rule: {
              ...toInputJsonObject(event.recurrence_rule),
              until: dayBeforeOccurrence.toISOString(),
            },
          },
        });
      });
    }

    case 'all': {
      // Delete the entire event (cascade will delete overrides)
      return getPrisma().calendarEvent.delete({
        where: { id: eventId },
      });
    }

    default:
      throw new Error(`Invalid edit scope: ${editScope}`);
  }
};

/**
 * Get a single calendar event by ID
 */
export const getEventById = async (eventId: string) => {
  return getPrisma().calendarEvent.findUnique({
    where: { id: eventId },
    include: {
      creator: {
        select: {
          id: true,
          name: true,
          login: true,
        },
      },
      overrides: true,
    },
  });
};

/**
 * Create an override for a specific occurrence of a recurring event
 */
export const createOverride = async (
  eventId: string,
  date: Date | string,
  overrideData: CalendarOverrideData
) => {
  const { is_cancelled, new_start_time, new_end_time, new_location, new_meeting_link } =
    overrideData;

  return getPrisma().calendarEventOverride.create({
    data: {
      event_id: eventId,
      date: new Date(date),
      is_cancelled: is_cancelled || false,
      new_start_time: toOptionalDate(new_start_time, true),
      new_end_time: toOptionalDate(new_end_time, true),
      new_location,
      new_meeting_link,
    },
  });
};

/**
 * Update an existing override
 */
export const updateOverride = async (overrideId: string, overrideData: CalendarOverrideData) => {
  const { is_cancelled, new_start_time, new_end_time, new_location, new_meeting_link } =
    overrideData;

  return getPrisma().calendarEventOverride.update({
    where: { id: overrideId },
    data: {
      is_cancelled,
      new_start_time: toOptionalDate(new_start_time, true),
      new_end_time: toOptionalDate(new_end_time, true),
      new_location,
      new_meeting_link,
    },
  });
};

/**
 * Delete an override
 */
export const deleteOverride = async (overrideId: string) => {
  return getPrisma().calendarEventOverride.delete({
    where: { id: overrideId },
  });
};

/**
 * Get all events created by a specific user
 */
export const getUserEvents = async (userId: string, classroomId: string) => {
  return getPrisma().calendarEvent.findMany({
    where: {
      created_by: userId,
      classroom_id: classroomId,
    },
    include: {
      overrides: true,
    },
    orderBy: {
      start_time: 'asc',
    },
  });
};

/**
 * Update resource links for a calendar event
 * For recurring events, links are stored per-occurrence using occurrence_date
 * @param {string} eventId - The calendar event ID
 * @param {string} classroomId - The classroom ID for validation
 * @param {object} linkData - Object containing pageIds, slideIds, assignmentIds arrays
 * @param {Date|null} occurrenceDate - For recurring events, the specific occurrence date
 * @param {object|null} featured - Which of those links the month view shows under the event on
 *   this date, as `{ kind, id }`. At most one, across all three kinds. A ref naming something
 *   this write is not linking is dropped silently rather than refused — see `resolveFeaturedLink`.
 */
export const updateEventLinks = async (
  eventId: string,
  classroomId: string,
  linkData: { pageIds?: string[]; slideIds?: string[]; assignmentIds?: string[] },
  occurrenceDate: Date | null = null,
  featured: FeaturedLinkRef | null = null
) => {
  const { pageIds = [], slideIds = [], assignmentIds = [] } = linkData;

  // The TARGET has to be in this classroom too, not just the resources being
  // linked. Without this the id checks below would happily rewrite another
  // classroom's event — deleting its links for that date and writing this
  // classroom's in their place — for anyone holding an id.
  const target = await getPrisma().calendarEvent.findFirst({
    where: { id: eventId, classroom_id: classroomId },
    select: { id: true },
  });

  if (!target) {
    throw new Error('Calendar event not found in this classroom');
  }

  // Normalize occurrence_date for storage (date-only, no time)
  const normalizedDate = occurrenceDate
    ? new Date(new Date(occurrenceDate).toISOString().split('T')[0])
    : null;

  // Validate all resources belong to this classroom
  const [pages, slides, assignments] = await Promise.all([
    pageIds.length > 0
      ? getPrisma().page.findMany({
          where: { id: { in: pageIds }, classroom_id: classroomId },
          select: { id: true },
        })
      : [],
    slideIds.length > 0
      ? getPrisma().slide.findMany({
          where: { id: { in: slideIds }, classroom_id: classroomId },
          select: { id: true },
        })
      : [],
    assignmentIds.length > 0
      ? getPrisma().assignment.findMany({
          where: { id: { in: assignmentIds }, repository: { classroom_id: classroomId } },
          select: { id: true },
        })
      : [],
  ]);

  // Only use validated IDs (filter out any that don't belong to this classroom)
  const validPageIds = pages.map(p => p.id);
  const validSlideIds = slides.map(s => s.id);
  const validAssignmentIds = assignments.map(a => a.id);

  // The star is resolved against the VALIDATED lists, so an id this write is
  // not actually linking — including one from another classroom, already
  // dropped above — cannot carry it.
  const featuredLink = resolveFeaturedLink(featured, {
    pageIds: validPageIds,
    slideIds: validSlideIds,
    assignmentIds: validAssignmentIds,
  });

  return getPrisma().$transaction(async tx => {
    // Take the parent event's row lock BEFORE anything else in here.
    //
    // At most one link row per (event, date) may be starred, and that rule
    // spans three tables, so no unique index can hold it on its own (the
    // partial indexes the migration adds only cover one table each). Under Read
    // Committed two concurrent saves of the same event would not see each
    // other's uncommitted rows and could each insert a star into a different
    // table. Locking the event row first makes them queue: the second save
    // starts after the first has committed and deleted-and-rewritten the date's
    // links, so it is rewriting a state it can see.
    await tx.$queryRaw`SELECT id FROM calendar_events WHERE id = ${eventId} FOR UPDATE`;

    // Delete existing links for this event/occurrence combination
    await tx.calendarEventPageLink.deleteMany({
      where: { event_id: eventId, occurrence_date: normalizedDate },
    });
    await tx.calendarEventSlideLink.deleteMany({
      where: { event_id: eventId, occurrence_date: normalizedDate },
    });
    await tx.calendarEventAssignmentLink.deleteMany({
      where: { event_id: eventId, occurrence_date: normalizedDate },
    });

    // Create new links (only for validated IDs, preserving order)
    if (validPageIds.length > 0) {
      await tx.calendarEventPageLink.createMany({
        data: validPageIds.map((id, idx) => ({
          event_id: eventId,
          page_id: id,
          occurrence_date: normalizedDate,
          order: idx,
          featured: isFeaturedLinkRow(featuredLink, 'page', id),
        })),
      });
    }
    if (validSlideIds.length > 0) {
      await tx.calendarEventSlideLink.createMany({
        data: validSlideIds.map((id, idx) => ({
          event_id: eventId,
          slide_id: id,
          occurrence_date: normalizedDate,
          order: idx,
          featured: isFeaturedLinkRow(featuredLink, 'slide', id),
        })),
      });
    }
    if (validAssignmentIds.length > 0) {
      await tx.calendarEventAssignmentLink.createMany({
        data: validAssignmentIds.map((id, idx) => ({
          event_id: eventId,
          assignment_id: id,
          occurrence_date: normalizedDate,
          order: idx,
          featured: isFeaturedLinkRow(featuredLink, 'assignment', id),
        })),
      });
    }

    return { success: true };
  });
};
