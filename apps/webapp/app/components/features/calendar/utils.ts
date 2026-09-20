/**
 * Calendar utility functions for date manipulation and event processing
 */

import type { CalendarEventWithLinks } from './types';

/** A value that can be converted to a Date via `new Date(value)` */
type DateInput = Date | string | number;

/**
 * Build an event's start and end instants from one calendar date and two clock
 * times — what both event modals collect.
 *
 * The end time is stamped onto the SAME date as the start, so a pairing like
 * 11 PM → 12 AM would describe an event that finishes before it begins. An end
 * strictly EARLIER than the start is a midnight crossing, so it rolls forward
 * one date.
 *
 * An end EQUAL to the start does not roll. Two identical times are a mistake,
 * not a request for a 24-hour event, and turning one into a day-long block
 * would be a silent answer to something the user has to fix. It passes through
 * as a zero-length range for the service to refuse, which is what puts the
 * message on screen.
 *
 * Pure, so both halves of that rule can be tested on their own.
 */
export const buildEventWindow = (
  date: Date,
  startTime: Date,
  endTime: Date
): { start: Date; end: Date } => {
  const start = new Date(date);
  start.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);

  const end = new Date(date);
  end.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

  if (end.getTime() < start.getTime()) {
    end.setDate(end.getDate() + 1);
  }

  return { start, end };
};

/**
 * The React key for one rendered occurrence.
 *
 * A recurring event surfaces once per date under a single id, so `event.id`
 * alone collides across a week and React reuses the wrong node. The key is the
 * pair that is actually unique: the id and the occurrence it was expanded for.
 * `index` is the last resort for an item with no id at all (nothing the service
 * sends is like that today).
 */
export const eventKey = (event: CalendarEventWithLinks, index: number): string => {
  const id = event.id ?? `index-${index}`;
  if (!event.occurrence_date) return String(id);
  return `${id}-${new Date(event.occurrence_date).toISOString()}`;
};

/** `SUN` … `SAT`, the day-name row both grids draw. */
export const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** The calendar header's primary label, e.g. `September 2026`. */
export const formatMonthYear = (date: DateInput) =>
  `${getMonthName(date)} ${new Date(date).getFullYear()}`;

/**
 * The calendar header's secondary label in week view: the day range, without
 * repeating the month the primary label already carries (`20 – 26`), unless the
 * week straddles two months (`Sep 27 – Oct 3`).
 */
export const formatDayRange = (start: DateInput, end: DateInput) => {
  const from = new Date(start);
  const to = new Date(end);
  if (from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear()) {
    return `${from.getDate()} – ${to.getDate()}`;
  }
  return `${getMonthName(from).slice(0, 3)} ${from.getDate()} – ${getMonthName(to).slice(0, 3)} ${to.getDate()}`;
};

/**
 * A clock time with the minutes dropped when they are zero — `9 AM`, `11:59 PM`.
 * What a deadline chip and the now badge show, where `formatTime`'s `9:00 AM`
 * is more digits than a chip has room for.
 */
export const formatShortTime = (date: DateInput) => {
  const d = new Date(date);
  const hours = d.getHours() % 12 || 12;
  const minutes = d.getMinutes();
  const suffix = d.getHours() < 12 ? 'AM' : 'PM';
  return minutes === 0
    ? `${hours} ${suffix}`
    : `${hours}:${String(minutes).padStart(2, '0')} ${suffix}`;
};

/**
 * Get day name from date (lowercase)
 */
export const getDayName = (date: Date) => {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
};

/**
 * Get short day name for display
 */
export const getShortDayName = (date: Date) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
};

/**
 * Format time for display (e.g., "9:00 AM")
 */
export const formatTime = (date: DateInput) => {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(date));
};

/**
 * Format date for display (e.g., "Mon 17")
 */
export const formatDate = (date: DateInput) => {
  const d = new Date(date);
  return `${getShortDayName(d)} ${d.getDate()}`;
};

/**
 * Get week dates (Sunday to Saturday) for a given date
 */
export const getWeekDates = (date: DateInput) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day;

  const sunday = new Date(d.setDate(diff));
  sunday.setHours(0, 0, 0, 0);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(sunday);
    date.setDate(sunday.getDate() + i);
    dates.push(date);
  }

  return dates;
};

/**
 * Add weeks to a date
 */
export const addWeeks = (date: DateInput, weeks: number) => {
  const d = new Date(date);
  d.setDate(d.getDate() + weeks * 7);
  return d;
};

/**
 * Get display name for event type
 */
export const getEventTypeLabel = (eventType: string) => {
  const labels: Record<string, string> = {
    OFFICE_HOURS: 'Office Hours',
    LECTURE: 'Lecture',
    LAB: 'Lab',
    SECTION: 'Section',
    ASSESSMENT: 'Assessment',
    REVIEW_SESSION: 'Review Session',
    HOLIDAY: 'Holiday',
    DEADLINE: 'Deadline',
    OTHER: 'Other',
  };
  return labels[eventType] || 'Event';
};

/**
 * Group events by date
 */
export const groupEventsByDate = (events: CalendarEventWithLinks[]) => {
  const grouped: Record<string, CalendarEventWithLinks[]> = {};

  events.forEach((event: CalendarEventWithLinks) => {
    const date = new Date(event.start_time);
    date.setHours(0, 0, 0, 0);
    const key = date.toISOString();

    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(event);
  });

  return grouped;
};

/**
 * Sort events by start time
 */
export const sortEventsByTime = (events: CalendarEventWithLinks[]) => {
  return [...events].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );
};

/**
 * Check if event is happening now
 */
export const isEventNow = (event: CalendarEventWithLinks) => {
  const now = new Date();
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  return now >= start && now <= end;
};

/**
 * Get duration in minutes
 */
export const getEventDuration = (event: CalendarEventWithLinks) => {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60));
};

/**
 * Format duration for display
 */
export const formatDuration = (minutes: number) => {
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
};

/**
 * Check if two dates are the same day
 * Uses local time methods since calendar UI displays dates in local timezone
 */
export const isSameDay = (date1: DateInput, date2: DateInput) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

/**
 * Filter events by type
 */
export const filterEventsByType = (events: CalendarEventWithLinks[], types: string[]) => {
  if (!types || types.length === 0) return events;
  return events.filter((event: CalendarEventWithLinks) => types.includes(event.event_type));
};

/**
 * Get month calendar dates (includes padding days from prev/next month)
 * Returns 5-6 weeks of dates starting from Sunday
 */
export const getMonthDates = (date: DateInput) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();

  // First day of month
  const firstDay = new Date(year, month, 1);
  const firstDayOfWeek = firstDay.getDay();

  // Start from the Sunday before first day
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - firstDayOfWeek);

  // Generate 6 weeks (42 days) to cover all possible month layouts
  const dates = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    dates.push(date);
  }

  return dates;
};

/**
 * Add months to a date (handles end-of-month dates correctly)
 * e.g., Jan 31 + 1 month = Feb 28 (not March 3)
 */
export const addMonths = (date: DateInput, months: number) => {
  const d = new Date(date);
  const dayOfMonth = d.getDate();

  // Move to the 1st to avoid overflow when changing months
  d.setDate(1);
  // Add the months
  d.setMonth(d.getMonth() + months);
  // Get the last day of the new month
  const lastDayOfNewMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  // Set to the original day, clamped to the last valid day of the new month
  d.setDate(Math.min(dayOfMonth, lastDayOfNewMonth));

  return d;
};

/**
 * Get month name
 */
export const getMonthName = (date: DateInput) => {
  return new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(date));
};

/**
 * Get year
 */
export const getYear = (date: DateInput) => {
  return new Date(date).getFullYear();
};

/**
 * Check if date is today
 */
export const isToday = (date: DateInput) => {
  return isSameDay(date, new Date());
};

/**
 * Check if date is in current month
 */
export const isCurrentMonth = (date: DateInput, referenceDate: DateInput) => {
  const d1 = new Date(date);
  const d2 = new Date(referenceDate);
  return d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
};

/**
 * Get Notion-style left border color for event type
 */
export const getEventTypeBorderColor = (eventType: string) => {
  const colors: Record<string, string> = {
    OFFICE_HOURS: 'border-l-violet-500',
    LECTURE: 'border-l-sky-500',
    LAB: 'border-l-teal-500',
    SECTION: 'border-l-teal-600',
    ASSESSMENT: 'border-l-amber-500',
    REVIEW_SESSION: 'border-l-orange-500',
    HOLIDAY: 'border-l-gray-400',
    DEADLINE: 'border-l-rose-500',
    OTHER: 'border-l-gray-400',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get dot color for event type (for month view compact display)
 */
export const getEventTypeDotColor = (eventType: string) => {
  const colors: Record<string, string> = {
    OFFICE_HOURS: 'bg-violet-500',
    LECTURE: 'bg-sky-500',
    LAB: 'bg-teal-500',
    SECTION: 'bg-teal-600',
    ASSESSMENT: 'bg-amber-500',
    REVIEW_SESSION: 'bg-orange-500',
    HOLIDAY: 'bg-gray-400',
    DEADLINE: 'bg-rose-500',
    OTHER: 'bg-gray-400',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get light background color for event type (for month view event badges)
 */
export const getEventTypeLightBg = (eventType: string) => {
  const colors: Record<string, string> = {
    OFFICE_HOURS: 'bg-violet-100 dark:bg-violet-900/30',
    LECTURE: 'bg-sky-100 dark:bg-sky-900/30',
    LAB: 'bg-teal-100 dark:bg-teal-900/30',
    SECTION: 'bg-teal-100 dark:bg-teal-900/30',
    ASSESSMENT: 'bg-amber-100 dark:bg-amber-900/30',
    REVIEW_SESSION: 'bg-orange-100 dark:bg-orange-900/30',
    HOLIDAY: 'bg-gray-100 dark:bg-neutral-800/50',
    DEADLINE: 'bg-rose-100 dark:bg-rose-900/30',
    OTHER: 'bg-gray-100 dark:bg-neutral-800/50',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get dark text color for event type (for month view event badges)
 */
export const getEventTypeDarkText = (eventType: string) => {
  const colors: Record<string, string> = {
    OFFICE_HOURS: 'text-violet-800 dark:text-violet-200',
    LECTURE: 'text-sky-800 dark:text-sky-200',
    LAB: 'text-teal-800 dark:text-teal-200',
    SECTION: 'text-teal-800 dark:text-teal-200',
    ASSESSMENT: 'text-amber-800 dark:text-amber-200',
    REVIEW_SESSION: 'text-orange-800 dark:text-orange-200',
    HOLIDAY: 'text-gray-700 dark:text-gray-300',
    DEADLINE: 'text-rose-800 dark:text-rose-200',
    OTHER: 'text-gray-700 dark:text-gray-300',
  };
  return colors[eventType] || colors.OTHER;
};
