/**
 * The calendar's navigation state — which date, which view, which types, and
 * what time it is now — for whoever is looking at it.
 *
 * Both calendars kept their own copy of this, and the copies had already
 * drifted: the same localStorage key but different tick intervals, a type
 * filter on one side only, and two spellings of "move a month, then tell the
 * route to fetch it". A viewer's choice of Week or Month is meant to follow
 * them between the staff calendar and the student one, which only works while
 * there is one key and one default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import {
  addMonths,
  addWeeks,
  filterEventsByType,
  getMonthDates,
  getWeekDates,
  groupEventsByDate,
  sortEventsByTime,
} from './utils';
import type { CalendarEventWithLinks } from './types';

export type CalendarView = 'month' | 'week';

/**
 * Where the chosen view is remembered. One key for both roles on purpose — an
 * instructor who works in Month should land in Month when they look at the
 * student view of the same class.
 */
export const CALENDAR_VIEW_STORAGE_KEY = 'classmoji-calendar-view';

/** How often the now-line and the now badge catch up, in ms. */
const NOW_TICK_MS = 60_000;

/**
 * One step forward (`+1`) or back (`-1`) from `date`, in the unit the current
 * view pages by. Pure, so the stepping rule can be tested without a renderer.
 */
export const stepDate = (date: Date, view: CalendarView, delta: number): Date =>
  view === 'month' ? addMonths(date, delta) : addWeeks(date, delta);

/**
 * The selection after one click on the legend. Pure, and exported so the rule
 * can be asserted on its own: an EMPTY list means "no filter, show everything",
 * so turning the only chosen type back off has to empty the list rather than
 * leave it holding the other four.
 */
export const toggleTypeIn = (types: string[], type: string): string[] =>
  types.includes(type) ? types.filter(t => t !== type) : [...types, type];

export interface CalendarNavigation {
  /** The date the header is labelled for, and the week/month the grids draw. */
  currentDate: Date;
  view: CalendarView;
  setView: (view: CalendarView) => void;
  /** Empty means "no filter", i.e. every type is shown. */
  selectedTypes: string[];
  toggleType: (type: string) => void;
  /** Ticks once a minute; the now indicator's only source of truth. */
  now: Date;
  goPrevious: () => void;
  goNext: () => void;
  goToday: () => void;
  /** Open one day in week view — where a cell's "+N more" goes. */
  focusDay: (date: Date) => void;
  /** Sunday…Saturday around `currentDate`. */
  weekDates: Date[];
  /** The 42 cells of `currentDate`'s month, padded from both neighbours. */
  monthDates: Date[];
}

/**
 * @param onMonthChange Told which month is now on screen so the route can fetch
 *   it. Called for every move, including "Today" — the loader is keyed on
 *   year/month and a week step can cross a month boundary.
 */
export const useCalendarNavigation = (
  onMonthChange?: ((year: number, month: number) => void) | null
): CalendarNavigation => {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [view, setView] = useLocalStorageState<CalendarView>(CALENDAR_VIEW_STORAGE_KEY, {
    defaultValue: 'week',
  });
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // The one place that moves the calendar: the fetch is a side effect of the
  // move, not something each button remembers to do for itself.
  const goTo = useCallback(
    (next: Date) => {
      setCurrentDate(next);
      onMonthChange?.(next.getFullYear(), next.getMonth());
    },
    [onMonthChange]
  );

  const goPrevious = useCallback(
    () => goTo(stepDate(currentDate, view, -1)),
    [goTo, currentDate, view]
  );
  const goNext = useCallback(() => goTo(stepDate(currentDate, view, 1)), [goTo, currentDate, view]);
  const goToday = useCallback(() => goTo(new Date()), [goTo]);

  const focusDay = useCallback(
    (date: Date) => {
      setView('week');
      goTo(date);
    },
    [goTo, setView]
  );

  const toggleType = useCallback((type: string) => {
    setSelectedTypes(types => toggleTypeIn(types, type));
  }, []);

  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate]);
  const monthDates = useMemo(() => getMonthDates(currentDate), [currentDate]);

  return {
    currentDate,
    view,
    setView,
    selectedTypes,
    toggleType,
    now,
    goPrevious,
    goNext,
    goToday,
    focusDay,
    weekDates,
    monthDates,
  };
};

/**
 * `events`, filtered by the chosen types and bucketed by local calendar day, as
 * a lookup the grids call per cell. Both calendars grouped events themselves,
 * one through `dayjs` and one through `Date`, keyed on the same local-midnight
 * ISO string — the same thing written twice.
 */
export const useEventsByDate = (
  events: CalendarEventWithLinks[],
  selectedTypes: string[]
): ((date: Date) => CalendarEventWithLinks[]) => {
  const byDate = useMemo(
    () => groupEventsByDate(filterEventsByType(events, selectedTypes)),
    [events, selectedTypes]
  );

  return useCallback(
    (date: Date) => {
      const key = new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
      return sortEventsByTime(byDate[key] ?? []);
    },
    [byDate]
  );
};
