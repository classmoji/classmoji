import { createEvents } from 'ics';
import * as calendarService from './calendar.service.js';

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
const dateToArray = (date) => {
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
const convertRecurrenceRule = (recurrenceRule) => {
  if (!recurrenceRule || !recurrenceRule.days || !Array.isArray(recurrenceRule.days)) {
    return null;
  }

  const rrule = {
    freq: 'WEEKLY',
    byday: recurrenceRule.days.map(day => DAY_MAP[day.toLowerCase()]).filter(Boolean),
  };

  if (recurrenceRule.until) {
    rrule.until = dateToArray(new Date(recurrenceRule.until));
  }

  return rrule;
};

/**
 * Convert a calendar event to ICS event format
 */
const convertEventToICS = (event, classroomSlug) => {
  const startArray = dateToArray(event.start_time);
  const endArray = dateToArray(event.end_time);

  // Calculate duration in minutes for all-day events (deadlines)
  const startDate = new Date(event.start_time);
  const endDate = new Date(event.end_time);
  const durationMinutes = Math.round((endDate - startDate) / (1000 * 60));

  const icsEvent = {
    uid: `${event.id}@classmoji.io`,
    start: startArray,
    startInputType: 'utc',
    startOutputType: 'utc',
    title: event.title,
    description: event.description || '',
    categories: [event.event_type],
  };

  // For deadlines, make them all-day events
  if (event.is_deadline || event.event_type === 'DEADLINE') {
    // For deadlines, just set the date without time
    icsEvent.start = [startArray[0], startArray[1], startArray[2]];
    delete icsEvent.startInputType;
    delete icsEvent.startOutputType;
  } else {
    // Regular timed events
    icsEvent.end = endArray;
    icsEvent.endInputType = 'utc';
    icsEvent.endOutputType = 'utc';
  }

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
export const generateCalendarFeed = async (classroomId, classroomSlug = 'classroom') => {
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
  const icsEvents = events.map(event => convertEventToICS(event, classroomSlug));

  // Generate ICS content
  return new Promise((resolve, reject) => {
    createEvents(icsEvents, (error, value) => {
      if (error) {
        console.error('Error generating ICS:', error);
        reject(error);
      } else {
        // Add custom calendar name
        const calendarName = `X-WR-CALNAME:${classroomSlug} Calendar`;
        const icsContent = value.replace(
          'BEGIN:VCALENDAR',
          `BEGIN:VCALENDAR\r\n${calendarName}`
        );
        resolve(icsContent);
      }
    });
  });
};
