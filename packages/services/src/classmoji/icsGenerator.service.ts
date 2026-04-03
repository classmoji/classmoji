import { createEvents, type DateArray, type EventAttributes } from 'ics';
import * as calendarService from './calendar.service.ts';

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
const convertRecurrenceRule = (
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
 * Convert a calendar event to ICS event format
 */
const convertEventToICS = (event: CalendarEventInput, classroomSlug: string): EventAttributes => {
  const startArray = dateToArray(event.start_time);
  const endArray = dateToArray(event.end_time);
  const baseEvent = {
    uid: `${event.id}@classmoji.io`,
    title: event.title,
    description: event.description || '',
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
    icsEvent.location = event.location;
  }

  // Add meeting link to description if present
  if (event.meeting_link) {
    icsEvent.url = event.meeting_link;
    if (icsEvent.description) {
      icsEvent.description += `\n\nMeeting Link: ${event.meeting_link}`;
    } else {
      icsEvent.description = `Meeting Link: ${event.meeting_link}`;
    }
  }

  // Handle recurring events - only for base events, not expanded occurrences
  // Note: We're getting expanded events from the calendar service, so we don't
  // need to handle RRULE here - each occurrence is already a separate event

  return icsEvent;
};

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
    // Return empty calendar
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Classmoji//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${classroomSlug} Calendar`,
      'END:VCALENDAR',
    ].join('\r\n');
  }

  // Convert events to ICS format
  const icsEvents = events.map(event =>
    convertEventToICS(event as CalendarEventInput, classroomSlug)
  );

  // Generate ICS content
  return new Promise((resolve, reject) => {
    createEvents(icsEvents, (error, value) => {
      if (error) {
        console.error('Error generating ICS:', error);
        reject(error);
      } else {
        // Add custom calendar name
        const calendarName = `X-WR-CALNAME:${classroomSlug} Calendar`;
        const icsContent = value.replace('BEGIN:VCALENDAR', `BEGIN:VCALENDAR\r\n${calendarName}`);
        resolve(icsContent);
      }
    });
  });
};
