import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { EventType } from '@prisma/client';

type DateInput = Date | string;
type CalendarEditScope = 'this_only' | 'this_and_future' | 'all';

interface OccurrenceLink {
  occurrence_date: Date | null;
}

interface CalendarPageLink extends OccurrenceLink {
  page: {
    id: string;
    title: string;
    is_draft: boolean;
  } | null;
}

interface CalendarSlideLink extends OccurrenceLink {
  slide: {
    id: string;
    title: string;
    is_draft: boolean;
  } | null;
}

interface CalendarAssignmentLink extends OccurrenceLink {
  assignment: {
    id: string;
    title: string;
    slug: string | null;
    module: {
      id: string;
      title: string;
      slug: string | null;
    } | null;
  } | null;
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

interface CalendarEventWithLinks {
  is_recurring: boolean;
  recurrence_rule: Prisma.JsonValue | null;
  pageLinks: CalendarPageLink[];
  slideLinks: CalendarSlideLink[];
  assignmentLinks: CalendarAssignmentLink[];
  overrides?: CalendarEventOverrideShape[];
  start_time: Date;
  end_time: Date;
  location: string | null;
  meeting_link: string | null;
  [key: string]: unknown;
}

interface CalendarExpandedEvent extends CalendarEventWithLinks {
  pages: Array<{ page: CalendarPageLink['page'] }>;
  slides: Array<{ slide: CalendarSlideLink['slide'] }>;
  assignments: Array<{
    assignment: CalendarAssignmentLink['assignment'];
    module: NonNullable<CalendarAssignmentLink['assignment']>['module'] | undefined;
  }>;
  occurrence_date?: Date;
  is_overridden?: boolean;
  _rawPageLinks?: CalendarPageLink[];
  _rawSlideLinks?: CalendarSlideLink[];
  _rawAssignmentLinks?: CalendarAssignmentLink[];
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
  module_id: string;
  pages: unknown[];
  slides: unknown[];
  github_issue_url: string | null;
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
  repository: {
    name: string;
  };
}

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
 * Map raw link data to the format expected by EventLinks component
 * By default, filters out draft content (calendar links should only show published content)
 */
const mapLinksToDisplayFormat = (
  pageLinks: CalendarPageLink[],
  slideLinks: CalendarSlideLink[],
  assignmentLinks: CalendarAssignmentLink[],
  filterDrafts: boolean = true
) => {
  // Map pages (filter drafts by default)
  const pages = (pageLinks || [])
    .filter(l => !filterDrafts || !l.page?.is_draft)
    .map(l => ({ page: l.page }));

  // Map slides (filter drafts by default)
  const slides = (slideLinks || [])
    .filter(l => !filterDrafts || !l.slide?.is_draft)
    .map(l => ({ slide: l.slide }));

  // Map assignments with module info for navigation
  const assignments = (assignmentLinks || []).map(l => ({
    assignment: l.assignment,
    module: l.assignment?.module,
  }));

  return { pages, slides, assignments };
};

/**
 * Expand recurring event into individual occurrences within date range
 * @param {object} event - The calendar event to expand
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {boolean} includeRawLinks - Whether to include raw link data for admin UI editing
 */
const expandRecurringEvent = (
  event: CalendarEventWithLinks,
  startDate: Date,
  endDate: Date,
  includeRawLinks: boolean = false
): CalendarExpandedEvent[] => {
  // For non-recurring events, just map links to display format
  if (!event.is_recurring || !event.recurrence_rule) {
    // Map links to display format (filter for this non-recurring event's date)
    // Pass isRecurring=false so NULL occurrence_date links are included
    const filteredPageLinks = filterLinksForOccurrence(event.pageLinks, event.start_time, false);
    const filteredSlideLinks = filterLinksForOccurrence(event.slideLinks, event.start_time, false);
    const filteredAssignmentLinks = filterLinksForOccurrence(
      event.assignmentLinks,
      event.start_time,
      false
    );
    const { pages, slides, assignments } = mapLinksToDisplayFormat(
      filteredPageLinks,
      filteredSlideLinks,
      filteredAssignmentLinks
    );

    const expandedEvent: CalendarExpandedEvent = {
      ...event,
      pages,
      slides,
      assignments,
    };

    // Only include raw links if requested (for admin UI editing)
    if (includeRawLinks) {
      expandedEvent._rawPageLinks = event.pageLinks;
      expandedEvent._rawSlideLinks = event.slideLinks;
      expandedEvent._rawAssignmentLinks = event.assignmentLinks;
    }

    return [expandedEvent];
  }

  const occurrences = [];
  const recurrenceRule = getRecurrenceRule(event.recurrence_rule);
  const { days, until } = recurrenceRule ?? {};

  if (!days || !Array.isArray(days)) {
    const filteredPageLinks = filterLinksForOccurrence(event.pageLinks, event.start_time, false);
    const filteredSlideLinks = filterLinksForOccurrence(event.slideLinks, event.start_time, false);
    const filteredAssignmentLinks = filterLinksForOccurrence(
      event.assignmentLinks,
      event.start_time,
      false
    );
    const { pages, slides, assignments } = mapLinksToDisplayFormat(
      filteredPageLinks,
      filteredSlideLinks,
      filteredAssignmentLinks
    );
    const expandedEvent: CalendarExpandedEvent = {
      ...event,
      pages,
      slides,
      assignments,
    };

    if (includeRawLinks) {
      expandedEvent._rawPageLinks = event.pageLinks;
      expandedEvent._rawSlideLinks = event.slideLinks;
      expandedEvent._rawAssignmentLinks = event.assignmentLinks;
    }

    return [expandedEvent];
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
        const filteredPageLinks = filterLinksForOccurrence(event.pageLinks, occurrenceDate, true);
        const filteredSlideLinks = filterLinksForOccurrence(event.slideLinks, occurrenceDate, true);
        const filteredAssignmentLinks = filterLinksForOccurrence(
          event.assignmentLinks,
          occurrenceDate,
          true
        );
        const { pages, slides, assignments } = mapLinksToDisplayFormat(
          filteredPageLinks,
          filteredSlideLinks,
          filteredAssignmentLinks
        );

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

          const overrideOccurrence: CalendarExpandedEvent = {
            ...event,
            start_time: occurrenceStart,
            end_time: occurrenceEnd,
            location: override.new_location || event.location,
            meeting_link: override.new_meeting_link || event.meeting_link,
            is_overridden: true,
            occurrence_date: occurrenceDate,
            pages,
            slides,
            assignments,
          };

          // Only include raw links if requested (for admin UI editing)
          if (includeRawLinks) {
            overrideOccurrence._rawPageLinks = event.pageLinks;
            overrideOccurrence._rawSlideLinks = event.slideLinks;
            overrideOccurrence._rawAssignmentLinks = event.assignmentLinks;
          }

          occurrences.push(overrideOccurrence);
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

          const templateOccurrence: CalendarExpandedEvent = {
            ...event,
            start_time: occurrenceStart,
            end_time: occurrenceEnd,
            occurrence_date: occurrenceDate,
            pages,
            slides,
            assignments,
          };

          // Only include raw links if requested (for admin UI editing)
          if (includeRawLinks) {
            templateOccurrence._rawPageLinks = event.pageLinks;
            templateOccurrence._rawSlideLinks = event.slideLinks;
            templateOccurrence._rawAssignmentLinks = event.assignmentLinks;
          }

          occurrences.push(templateOccurrence);
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
 */
export const getClassroomCalendar = async (
  classroomId: string,
  startDate: Date,
  endDate: Date,
  userId: string | null = null,
  includeRawLinks: boolean = false,
  includeUnpublished: boolean = false
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
          assignment: {
            select: {
              id: true,
              title: true,
              slug: true,
              module: { select: { id: true, title: true, slug: true } },
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
    expandRecurringEvent(event, startDate, endDate, includeRawLinks)
  );

  // Get deadlines from Assignments (pass userId to include GitHub issue links)
  const deadlines = await getDeadlinesForRange(
    classroomId,
    startDate,
    endDate,
    userId,
    includeUnpublished
  );

  // Combine and sort by start time
  const allEvents = [...expandedEvents, ...deadlines].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  return allEvents;
};

/**
 * Get assignment deadlines as calendar items
 * @param {string} classroomId - The classroom ID
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} [userId] - Optional user ID to include their GitHub issue links
 * @param {boolean} [includeUnpublished=false] - Include unpublished assignments (for admin view)
 */
export const getDeadlinesForRange = async (
  classroomId: string,
  startDate: Date,
  endDate: Date,
  userId: string | null = null,
  includeUnpublished: boolean = false
) => {
  const assignments = await getPrisma().assignment.findMany({
    where: {
      module: {
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
      module: {
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
        include: {
          page: {
            select: {
              id: true,
              title: true,
            },
          },
        },
        orderBy: {
          order: 'asc',
        },
      },
      slides: {
        // Only filter out drafts if not including unpublished content
        ...(includeUnpublished
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
      // Include user's repository assignment if userId provided
      ...(userId && {
        repository_assignments: {
          where: {
            repository: {
              student_id: userId,
            },
          },
          include: {
            repository: {
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
      'repository_assignments' in assignment
        ? (assignment.repository_assignments?.[0] ?? null)
        : null
    ) as DeadlineRepositoryAssignment | null;
    const gitOrgLogin = assignment.module.classroom?.git_organization?.login;

    // Build GitHub issue URL if user has a repo assignment
    let github_issue_url = null;
    if (repoAssignment && gitOrgLogin) {
      github_issue_url = `https://github.com/${gitOrgLogin}/${repoAssignment.repository.name}/issues/${repoAssignment.provider_issue_number}`;
    }

    // Flag unpublished content for admin UI styling
    const isUnpublished = !assignment.is_published || !assignment.module?.is_published;

    const deadline: CalendarDeadlineItem = {
      id: `deadline-${assignment.id}`,
      event_type: 'DEADLINE',
      title: `Due: ${assignment.title}`,
      description: assignment.module.title,
      start_time: assignment.student_deadline!,
      end_time: assignment.student_deadline!,
      is_deadline: true,
      is_unpublished: isUnpublished,
      assignment_id: assignment.id,
      module_id: assignment.module.id,
      pages: assignment.pages,
      slides: assignment.slides,
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

      // Update original event to end before this occurrence
      await getPrisma().calendarEvent.update({
        where: { id: eventId },
        data: {
          recurrence_rule: {
            ...toInputJsonObject(event.recurrence_rule),
            until: dayBeforeOccurrence.toISOString(),
          },
        },
      });

      // Create new event starting from this occurrence
      const newEvent = await getPrisma().calendarEvent.create({
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

      return newEvent;
    }

    case 'all': {
      // Update the entire event template
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
          recurrence_rule: eventData.is_recurring
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

      // Also delete any overrides on or after this date
      await getPrisma().calendarEventOverride.deleteMany({
        where: {
          event_id: eventId,
          date: { gte: occurrenceDate },
        },
      });

      return getPrisma().calendarEvent.update({
        where: { id: eventId },
        data: {
          recurrence_rule: {
            ...toInputJsonObject(event.recurrence_rule),
            until: dayBeforeOccurrence.toISOString(),
          },
        },
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
 */
export const updateEventLinks = async (
  eventId: string,
  classroomId: string,
  linkData: { pageIds?: string[]; slideIds?: string[]; assignmentIds?: string[] },
  occurrenceDate: Date | null = null
) => {
  const { pageIds = [], slideIds = [], assignmentIds = [] } = linkData;

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
          where: { id: { in: assignmentIds }, module: { classroom_id: classroomId } },
          select: { id: true },
        })
      : [],
  ]);

  // Only use validated IDs (filter out any that don't belong to this classroom)
  const validPageIds = pages.map(p => p.id);
  const validSlideIds = slides.map(s => s.id);
  const validAssignmentIds = assignments.map(a => a.id);

  return getPrisma().$transaction(async tx => {
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
        })),
      });
    }

    return { success: true };
  });
};
