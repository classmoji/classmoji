import { createEvent, createEvents, type DateArray, type EventAttributes } from 'ics';
import * as calendarService from './calendar.service.ts';
import { hasPlainHost, isMeetingLinkUrl } from './calendarPolicy.ts';

interface RecurrenceRuleInput {
  days?: string[];
  until?: string | Date;
}

interface CalendarEventInput {
  id: string;
  title: string;
  description?: string | null;
  event_type: string;
  start_time: Date | string;
  end_time: Date | string;
  location?: string | null;
  meeting_link?: string | null;
  is_deadline?: boolean | null;
}

/**
 * Day name to ICS RRULE day code mapping
 */
const DAY_MAP = {
  sunday: 'SU',
  monday: 'MO',
  tuesday: 'TU',
  wednesday: 'WE',
  thursday: 'TH',
  friday: 'FR',
  saturday: 'SA',
};

/**
 * Convert a Date to ICS date array format [year, month, day, hour, minute]
 */
const dateToArray = (date: Date | string): DateArray => {
  const d = new Date(date);
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1, // ICS months are 1-indexed
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ];
};

/**
 * Convert custom recurrence rule to ICS RRULE format
 * Input: { days: ['monday', 'wednesday'], until: '2025-05-15T00:00:00Z' }
 * Output: { freq: 'WEEKLY', byday: ['MO', 'WE'], until: [2025, 5, 15, 0, 0] }
 */
const _convertRecurrenceRule = (
  recurrenceRule: RecurrenceRuleInput | null | undefined
): { freq: 'WEEKLY'; byday: string[]; until?: number[] } | null => {
  if (!recurrenceRule || !recurrenceRule.days || !Array.isArray(recurrenceRule.days)) {
    return null;
  }

  const rrule: { freq: 'WEEKLY'; byday: string[]; until?: number[] } = {
    freq: 'WEEKLY',
    byday: recurrenceRule.days
      .map((day: string) => DAY_MAP[day.toLowerCase() as keyof typeof DAY_MAP])
      .filter(Boolean),
  };

  if (recurrenceRule.until) {
    rrule.until = dateToArray(new Date(recurrenceRule.until));
  }

  return rrule;
};

/**
 * Longest text the feed hands the ics library per field, counted as the
 * library writes it: a comma, semicolon, backslash or line feed is escaped to
 * two characters. The library folds every line of every occurrence on its
 * own, in time that grows with the square of the line's length, so these
 * limits, with `FEED_URL_LIMIT`, bound the cost of a long series. Measured on
 * a development laptop for a 395-occurrence daily series: about 68 ms with no
 * text and no URL; about 315 ms with a 1,000-character URL and no text, the
 * URL field being the largest single cost; and about 490 to 530 ms at worst,
 * with every field at its limit, a 1,000-character URL, and a description of
 * letters followed by flag-tag text. The description limit covers the
 * "Meeting Link:" line too.
 */
const FEED_TITLE_LIMIT = 150;
const FEED_LOCATION_LIMIT = 150;
const FEED_DESCRIPTION_LIMIT = 560;

/** Longest link the feed puts in an event's URL field. */
const FEED_URL_LIMIT = 1_000;

/** Most `:` such a link may hold after its scheme, a port included. */
const FEED_URL_MAX_COLONS = 8;

/** Line breaks as line feeds: a carriage return is not written on its own. */
const normalizeLineBreaks = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * What one UTF-16 unit counts for against a limit: two for a character the
 * library escapes to two, and three for the first half of a character from
 * U+E0000 to U+E03FF. The library folds a line slowly where tag characters
 * follow U+1F3F4, the black flag that starts a subdivision flag (about 3.6
 * times as long as letters at a weight of one); tag characters and variation
 * selectors on their own fold faster than letters, so weighting the whole
 * block costs ordinary text nothing.
 */
const unitWeight = (code: number): number =>
  code === 0x5c || code === 0x3b || code === 0x2c || code === 0x0a ? 2 : code === 0xdb40 ? 3 : 1;

/** Length of the text against a limit, counted no further than past `stop`. */
const escapedLength = (text: string, stop = Infinity): number => {
  let length = 0;
  for (let i = 0; i < text.length && length <= stop; i++) length += unitWeight(text.charCodeAt(i));
  return length;
};

/**
 * The text, with line breaks as line feeds, cut so that as the library writes
 * it, it is at most `limit` characters, ending in an ellipsis when cut,
 * without splitting a surrogate pair. Only the start of a long text is read:
 * what is kept comes from its first `2 * limit` characters.
 */
const fitForFeed = (raw: string, limit: number): string => {
  const head = raw.length > 2 * limit + 2 ? raw.slice(0, 2 * limit + 2) : raw;
  const text = normalizeLineBreaks(head);
  if (head === raw && escapedLength(text, limit) <= limit) return text;
  let used = 0;
  let end = 0;
  while (end < text.length) {
    const next = used + unitWeight(text.charCodeAt(end));
    if (next > limit - 1) break;
    used = next;
    end++;
  }
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
};

/**
 * The event's description for the feed, with the meeting link, or the note a
 * meeting-link field holds instead, on its own line at the end, all within
 * `FEED_DESCRIPTION_LIMIT`. The description gives way first; that line is kept
 * whole. A link line too long for the limit on its own is left out, and the
 * URL field carries the link when it can; a note line that long is shortened.
 */
const feedDescription = (description: string, meetingLink: string | null | undefined): string => {
  if (!meetingLink) return fitForFeed(description, FEED_DESCRIPTION_LIMIT);

  const isLink = isMeetingLinkUrl(meetingLink);
  const lineText = `Meeting Link: ${meetingLink.trim()}`;
  // Line breaks only shorten a text, so one over twice the limit cannot fit.
  const fits =
    lineText.length <= 2 * FEED_DESCRIPTION_LIMIT &&
    escapedLength(normalizeLineBreaks(lineText), FEED_DESCRIPTION_LIMIT) <= FEED_DESCRIPTION_LIMIT;
  if (!fits) {
    return isLink
      ? fitForFeed(description, FEED_DESCRIPTION_LIMIT)
      : fitForFeed(lineText, FEED_DESCRIPTION_LIMIT);
  }

  const line = normalizeLineBreaks(lineText);
  if (!description) return line;

  // The blank line before that line is written as four characters.
  const room = FEED_DESCRIPTION_LIMIT - escapedLength(line) - 4;
  return room > 1 ? `${fitForFeed(description, room)}\n\n${line}` : line;
};

/**
 * The meeting link for the event's URL field, or null to leave the field out
 * (the description still carries the link when it fits). The field takes an
 * http(s) link with a plain host (`hasPlainHost`), no user name or password, no
 * `@` outside the query, at most `FEED_URL_MAX_COLONS` colons after the scheme
 * and at most `FEED_URL_LIMIT` characters: the forms the library's URL check is
 * written for. An `@` in the query is written as `%40`, which a server reads
 * the same. The parsed form is used because that check accepts only a
 * lowercase scheme and host.
 */
export const feedUrl = (meetingLink: string): string | null => {
  if (!isMeetingLinkUrl(meetingLink)) return null;
  const url = new URL(meetingLink.trim());
  if (!hasPlainHost(url) || url.username !== '' || url.password !== '') return null;
  if (url.search.includes('@')) url.search = url.search.replaceAll('@', '%40');

  const href = url.href;
  if (href.length > FEED_URL_LIMIT || href.includes('@')) return null;
  const afterScheme = href.slice(url.protocol.length + 2);
  if (afterScheme.split(':').length - 1 > FEED_URL_MAX_COLONS) return null;
  return href;
};

/**
 * Convert a calendar event to ICS event format
 */
const convertEventToICS = (event: CalendarEventInput, _classroomSlug: string): EventAttributes => {
  const startArray = dateToArray(event.start_time);
  const endArray = dateToArray(event.end_time);
  const baseEvent = {
    uid: `${event.id}@classmoji.io`,
    title: fitForFeed(event.title, FEED_TITLE_LIMIT),
    description: feedDescription(event.description || '', event.meeting_link),
    categories: [event.event_type],
  };

  const icsEvent: EventAttributes =
    event.is_deadline || event.event_type === 'DEADLINE'
      ? {
          ...baseEvent,
          start: [startArray[0], startArray[1], startArray[2]],
          duration: { days: 1 },
        }
      : {
          ...baseEvent,
          start: startArray,
          startInputType: 'utc',
          startOutputType: 'utc',
          end: endArray,
          endInputType: 'utc',
          endOutputType: 'utc',
        };

  // Add location if present
  if (event.location) {
    icsEvent.location = fitForFeed(event.location, FEED_LOCATION_LIMIT);
  }

  // Only a web link becomes the event's URL; any other text stays in the
  // description alone.
  const url = event.meeting_link ? feedUrl(event.meeting_link) : null;
  if (url) icsEvent.url = url;

  // Handle recurring events - only for base events, not expanded occurrences
  // Note: We're getting expanded events from the calendar service, so we don't
  // need to handle RRULE here - each occurrence is already a separate event

  return icsEvent;
};

/** A calendar with no events, under the classroom's calendar name. */
const emptyCalendar = (classroomSlug: string): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Classmoji//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${classroomSlug} Calendar`,
    'END:VCALENDAR',
  ].join('\r\n');

/** Logged for each event left out of the feed: its id only, never its content. */
const logSkipped = (eventId: string) =>
  console.warn(`Calendar feed: skipped event ${eventId}, which failed ICS validation`);

/**
 * The event as the ics library will take it: as built; without its URL, when
 * only the URL is refused (the library's URL check is narrower than the URL
 * parser, e.g. on an underscore in the host); or null when neither passes.
 */
const servableIcsEvent = (icsEvent: EventAttributes): EventAttributes | null => {
  if (!createEvent(icsEvent).error) return icsEvent;
  if (icsEvent.url) {
    const withoutUrl = { ...icsEvent };
    delete withoutUrl.url;
    if (!createEvent(withoutUrl).error) return withoutUrl;
  }
  return null;
};

/** The library's calendar text with the classroom's calendar name added. */
const withCalendarName = (ics: string, classroomSlug: string): string =>
  ics.replace('BEGIN:VCALENDAR', `BEGIN:VCALENDAR\r\nX-WR-CALNAME:${classroomSlug} Calendar`);

/**
 * Generate an ICS calendar feed for a classroom
 * @param {string} classroomId - The classroom ID
 * @param {string} classroomSlug - The classroom slug (for UID generation)
 * @returns {Promise<string>} The ICS file content
 */
export const generateCalendarFeed = async (
  classroomId: string,
  classroomSlug: string = 'classroom'
): Promise<string> => {
  // Get date range: 30 days past to 365 days future
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);

  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + 365);

  // Fetch all calendar events for the range
  const events = await calendarService.getClassroomCalendar(classroomId, startDate, endDate);

  if (!events || events.length === 0) {
    return emptyCalendar(classroomSlug);
  }

  // Convert events to ICS format
  const converted = events.flatMap(event => {
    const input = event as CalendarEventInput;
    try {
      return [{ id: input.id, icsEvent: convertEventToICS(input, classroomSlug) }];
    } catch {
      logSkipped(input.id);
      return [];
    }
  });
  if (converted.length === 0) return emptyCalendar(classroomSlug);

  // The whole list in one pass is the normal case. The library refuses the
  // entire batch over one bad event, so only then is each event checked on its
  // own, and the ones it still refuses are left out.
  let result = createEvents(converted.map(c => c.icsEvent));
  if (result.error) {
    const servable = converted.flatMap(({ id, icsEvent }) => {
      const kept = servableIcsEvent(icsEvent);
      if (!kept) logSkipped(id);
      return kept ? [kept] : [];
    });
    if (servable.length === 0) return emptyCalendar(classroomSlug);
    result = createEvents(servable);
  }

  // Not expected: every event above passed the library on its own. The
  // library's error is not passed on, because it carries the whole event it
  // refused and the caller logs what it is thrown.
  if (result.error || !result.value) {
    throw new Error('Calendar feed: the ics library refused events that passed one by one');
  }
  return withCalendarName(result.value, classroomSlug);
};
