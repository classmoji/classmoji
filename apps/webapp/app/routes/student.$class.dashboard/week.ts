import dayjs, { type Dayjs } from 'dayjs';

/**
 * Week arithmetic for the dashboard's week strip, kept pure so it can be tested
 * under different time zones. Everything here works in the time zone of the
 * process that calls it: the server (UTC on Fly) for the fetch window, the
 * browser for what the student sees.
 */

/** Sunday 00:00 of the week containing `now`, in local time. */
export const startOfWeek = (now: Dayjs = dayjs()) => now.day(0).startOf('day');

/**
 * The span of events the loader fetches. The server cannot know the browser's
 * time zone, and the browser's date is at most a day either side of the
 * server's, so its week is this week or, across a Saturday/Sunday boundary, the
 * one either side. Fetch from the week of yesterday to the week of tomorrow,
 * plus a day of slack at each end for the offset between the two midnights;
 * the card drops whatever falls outside the week it shows.
 */
export const eventFetchWindow = (now: Dayjs = dayjs()) => ({
  from: startOfWeek(now.subtract(1, 'day')).subtract(1, 'day'),
  to: startOfWeek(now.add(1, 'day')).add(8, 'day'),
});

/**
 * Buckets events into the seven local calendar days from `weekStart`, sorted
 * by time. Events on any other day are dropped. Comparing start-of-day to
 * start-of-day keeps a Saturday 11pm event out of Sunday's column, which a
 * plain diff (truncating -0.04 days to 0) would put there.
 */
export const groupByDay = <T extends { start_time: string | Date }>(
  events: T[],
  weekStart: Dayjs
): T[][] => {
  const grid: T[][] = Array.from({ length: 7 }, () => []);
  events.forEach(event => {
    // Rounded, not truncated: in a zone whose clocks spring forward at
    // midnight (Santiago, Havana, Beirut) that week's Sunday starts at 01:00,
    // so Monday is 23 hours after it and a truncating diff would say 0.
    const offset = Math.round(dayjs(event.start_time).startOf('day').diff(weekStart, 'day', true));
    if (offset >= 0 && offset < 7) grid[offset].push(event);
  });
  grid.forEach(day =>
    day.sort((a, b) => dayjs(a.start_time).valueOf() - dayjs(b.start_time).valueOf())
  );
  return grid;
};
