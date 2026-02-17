/**
 * Calendar utility functions for date manipulation and event processing
 */

/**
 * Get day name from date (lowercase)
 */
export const getDayName = (date) => {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[date.getDay()];
};

/**
 * Get short day name for display
 */
export const getShortDayName = (date) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
};

/**
 * Format time for display (e.g., "9:00 AM")
 */
export const formatTime = (date) => {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(date));
};

/**
 * Format date for display (e.g., "Mon 17")
 */
export const formatDate = (date) => {
  const d = new Date(date);
  return `${getShortDayName(d)} ${d.getDate()}`;
};

/**
 * Format full date (e.g., "December 17, 2025")
 */
export const formatFullDate = (date) => {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(date));
};

/**
 * Get week dates (Sunday to Saturday) for a given date
 */
export const getWeekDates = (date) => {
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
 * Get start and end of week
 */
export const getWeekRange = (date) => {
  const dates = getWeekDates(date);
  const start = new Date(dates[0]);
  start.setHours(0, 0, 0, 0);

  const end = new Date(dates[6]);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

/**
 * Add weeks to a date
 */
export const addWeeks = (date, weeks) => {
  const d = new Date(date);
  d.setDate(d.getDate() + (weeks * 7));
  return d;
};

/**
 * Get color class for event type
 */
export const getEventTypeColor = (eventType) => {
  const colors = {
    OFFICE_HOURS: 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-700',
    LECTURE: 'bg-sky-50 dark:bg-sky-900/20 border-sky-200 dark:border-sky-700',
    LAB: 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-700',
    SECTION: 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-700',
    ASSESSMENT: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700',
    REVIEW_SESSION: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-700',
    HOLIDAY: 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-700',
    DEADLINE: 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-700',
    OTHER: 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-700',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get text color class for event type
 */
export const getEventTypeTextColor = (eventType) => {
  const colors = {
    OFFICE_HOURS: 'text-violet-700 dark:text-violet-300',
    LECTURE: 'text-sky-700 dark:text-sky-300',
    LAB: 'text-teal-700 dark:text-teal-300',
    SECTION: 'text-teal-700 dark:text-teal-300',
    ASSESSMENT: 'text-amber-700 dark:text-amber-300',
    REVIEW_SESSION: 'text-orange-700 dark:text-orange-300',
    HOLIDAY: 'text-gray-700 dark:text-gray-300',
    DEADLINE: 'text-rose-700 dark:text-rose-300',
    OTHER: 'text-gray-700 dark:text-gray-300',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get badge color for event type
 */
export const getEventTypeBadgeColor = (eventType) => {
  const colors = {
    OFFICE_HOURS: 'purple',
    LECTURE: 'cyan',
    LAB: 'cyan',
    SECTION: 'cyan',
    ASSESSMENT: 'orange',
    REVIEW_SESSION: 'orange',
    HOLIDAY: 'default',
    DEADLINE: 'magenta',
    OTHER: 'default',
  };
  return colors[eventType] || 'default';
};

/**
 * Get display name for event type
 */
export const getEventTypeLabel = (eventType) => {
  const labels = {
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
 * Calculate grid position for event in weekly calendar
 * Returns top and height percentages based on time
 */
export const getEventGridPosition = (startTime, endTime, dayStartHour = 0, dayEndHour = 24) => {
  const start = new Date(startTime);
  const end = new Date(endTime);

  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();

  const dayStartMinutes = dayStartHour * 60;
  const dayEndMinutes = dayEndHour * 60;
  const dayDuration = dayEndMinutes - dayStartMinutes;

  const top = ((startMinutes - dayStartMinutes) / dayDuration) * 100;
  const height = ((endMinutes - startMinutes) / dayDuration) * 100;

  return {
    top: Math.max(0, Math.min(100, top)),
    height: Math.max(0, Math.min(100 - top, height)),
  };
};

/**
 * Group events by date
 */
export const groupEventsByDate = (events) => {
  const grouped = {};

  events.forEach(event => {
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
export const sortEventsByTime = (events) => {
  return [...events].sort((a, b) =>
    new Date(a.start_time) - new Date(b.start_time)
  );
};

/**
 * Check if event is happening now
 */
export const isEventNow = (event) => {
  const now = new Date();
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  return now >= start && now <= end;
};

/**
 * Check if event is upcoming (within next 24 hours)
 */
export const isEventUpcoming = (event) => {
  const now = new Date();
  const start = new Date(event.start_time);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return start > now && start < tomorrow;
};

/**
 * Get duration in minutes
 */
export const getEventDuration = (event) => {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  return Math.round((end - start) / (1000 * 60));
};

/**
 * Format duration for display
 */
export const formatDuration = (minutes) => {
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
export const isSameDay = (date1, date2) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

/**
 * Get time slots for calendar grid (hourly)
 */
export const getTimeSlots = (startHour = 0, endHour = 24) => {
  const slots = [];
  for (let hour = startHour; hour < endHour; hour++) {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    slots.push({
      hour,
      label: formatTime(date),
    });
  }
  return slots;
};

/**
 * Filter events by type
 */
export const filterEventsByType = (events, types) => {
  if (!types || types.length === 0) return events;
  return events.filter(event => types.includes(event.event_type));
};

/**
 * Get recurrence rule display text
 */
export const getRecurrenceText = (recurrenceRule) => {
  if (!recurrenceRule || !recurrenceRule.days) return '';

  const { days, until } = recurrenceRule;
  const dayLabels = {
    sunday: 'Sun',
    monday: 'Mon',
    tuesday: 'Tue',
    wednesday: 'Wed',
    thursday: 'Thu',
    friday: 'Fri',
    saturday: 'Sat',
  };

  const dayNames = days.map(d => dayLabels[d] || d).join(', ');
  const untilDate = until ? formatFullDate(new Date(until)) : '';

  return `Repeats ${dayNames}${untilDate ? ` until ${untilDate}` : ''}`;
};

/**
 * Get month calendar dates (includes padding days from prev/next month)
 * Returns 5-6 weeks of dates starting from Sunday
 */
export const getMonthDates = (date) => {
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
 * Get month range (start and end dates)
 */
export const getMonthRange = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();

  const start = new Date(year, month, 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(year, month + 1, 0);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

/**
 * Add months to a date (handles end-of-month dates correctly)
 * e.g., Jan 31 + 1 month = Feb 28 (not March 3)
 */
export const addMonths = (date, months) => {
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
export const getMonthName = (date) => {
  return new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(date));
};

/**
 * Get year
 */
export const getYear = (date) => {
  return new Date(date).getFullYear();
};

/**
 * Check if date is today
 */
export const isToday = (date) => {
  return isSameDay(date, new Date());
};

/**
 * Check if date is in current month
 */
export const isCurrentMonth = (date, referenceDate) => {
  const d1 = new Date(date);
  const d2 = new Date(referenceDate);
  return d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
};

/**
 * Get Notion-style left border color for event type
 */
export const getEventTypeBorderColor = (eventType) => {
  const colors = {
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
export const getEventTypeDotColor = (eventType) => {
  const colors = {
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
export const getEventTypeLightBg = (eventType) => {
  const colors = {
    OFFICE_HOURS: 'bg-violet-100 dark:bg-violet-900/30',
    LECTURE: 'bg-sky-100 dark:bg-sky-900/30',
    LAB: 'bg-teal-100 dark:bg-teal-900/30',
    SECTION: 'bg-teal-100 dark:bg-teal-900/30',
    ASSESSMENT: 'bg-amber-100 dark:bg-amber-900/30',
    REVIEW_SESSION: 'bg-orange-100 dark:bg-orange-900/30',
    HOLIDAY: 'bg-gray-100 dark:bg-gray-800/50',
    DEADLINE: 'bg-rose-100 dark:bg-rose-900/30',
    OTHER: 'bg-gray-100 dark:bg-gray-800/50',
  };
  return colors[eventType] || colors.OTHER;
};

/**
 * Get dark text color for event type (for month view event badges)
 */
export const getEventTypeDarkText = (eventType) => {
  const colors = {
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
