import crypto from 'crypto';

const CALENDAR_SECRET = process.env.CALENDAR_SECRET;

/**
 * Calculate date range for calendar view
 * Uses UTC to avoid timezone issues - deadlines stored as UTC need consistent comparison
 * @param {number} year - The year
 * @param {number} month - The month (0-indexed, like JavaScript Date)
 * @returns {{ start: Date, end: Date }} - UTC date range with buffer for timezone edge cases
 */
export function getCalendarDateRange(year, month) {
  // Use UTC to match how deadlines are stored in the database
  const monthStart = new Date(Date.UTC(year, month, 1));
  // Adjust to previous Sunday
  const startDayOfWeek = monthStart.getUTCDay();
  monthStart.setUTCDate(monthStart.getUTCDate() - startDayOfWeek);
  // Start a day early to catch timezone edge cases (e.g., Jan 31 11:59pm ET = Feb 1 04:59 UTC)
  monthStart.setUTCDate(monthStart.getUTCDate() - 1);
  monthStart.setUTCHours(0, 0, 0, 0);

  // Last day of month
  const monthEnd = new Date(Date.UTC(year, month + 1, 0));
  // Adjust to next Saturday
  const endDayOfWeek = monthEnd.getUTCDay();
  monthEnd.setUTCDate(monthEnd.getUTCDate() + (6 - endDayOfWeek));
  // End a day late to catch timezone edge cases
  monthEnd.setUTCDate(monthEnd.getUTCDate() + 1);
  monthEnd.setUTCHours(23, 59, 59, 999);

  return { start: monthStart, end: monthEnd };
}

/**
 * Generate HMAC signature for a classroom slug
 * Used to create subscription URLs that are hard to guess
 * Returns null if CALENDAR_SECRET is not configured
 */
export function generateCalendarSignature(slug) {
  if (!CALENDAR_SECRET) {
    return null;
  }
  return crypto.createHmac('sha256', CALENDAR_SECRET).update(slug).digest('hex').slice(0, 16);
}

/**
 * Build the full calendar subscription URL for a classroom
 * @param {string} slug - The classroom slug
 * @returns {string|null} The full subscription URL, or null if not configured
 */
export function buildCalendarUrl(slug) {
  const signature = generateCalendarSignature(slug);
  if (!signature) {
    return null;
  }
  const baseUrl = process.env.HOST_URL || 'https://classmoji.io';
  return `${baseUrl}/api/calendar/${slug}/${signature}.ics`;
}
