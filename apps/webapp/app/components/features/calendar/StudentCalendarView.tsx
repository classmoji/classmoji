/**
 * The student calendar: the same shell and the same grids as the staff
 * calendar, with nothing that writes.
 *
 * It is this short on purpose. Instructors assume their class sees what they
 * see, so the two views are the same components with the same geometry; the
 * only difference is that nothing here supplies the drag render props, which is
 * also what keeps `@dnd-kit` out of a student's bundle. A new calendar feature
 * lands in the shared grids and reaches both roles at once — previously it had
 * to be written twice, and in practice was not.
 */

import { useMemo } from 'react';
import CalendarShell, { CalendarTypeFilter } from './CalendarShell';
import WeekGrid from './WeekGrid';
import MonthGrid from './MonthGrid';
import { hourRange } from './geometry';
import { useCalendarNavigation, useEventsByDate } from './useCalendarNavigation';
import type { CalendarEventWithLinks } from './types';

interface StudentCalendarViewProps {
  events: CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  onMonthChange?: (year: number, month: number) => void;
  /** Where a starred resource under a month chip points — see MonthGrid. */
  classSlug?: string;
  pagesUrl?: string;
  slidesUrl?: string;
}

const StudentCalendarView = ({
  events,
  onEventClick,
  onMonthChange,
  classSlug,
  pagesUrl,
  slidesUrl,
}: StudentCalendarViewProps) => {
  const nav = useCalendarNavigation(onMonthChange);
  const eventsFor = useEventsByDate(events, nav.selectedTypes);
  // The whole loaded month, UNFILTERED: the grid must not resize as the reader
  // pages between its weeks or toggles a type in the legend.
  const { startHour, endHour } = useMemo(() => hourRange(events), [events]);

  return (
    <CalendarShell
      currentDate={nav.currentDate}
      weekDates={nav.weekDates}
      view={nav.view}
      onViewChange={nav.setView}
      onPrevious={nav.goPrevious}
      onNext={nav.goNext}
      onToday={nav.goToday}
      legend={
        <CalendarTypeFilter selectedTypes={nav.selectedTypes} onToggleType={nav.toggleType} />
      }
    >
      {nav.view === 'month' ? (
        <MonthGrid
          dates={nav.monthDates}
          currentDate={nav.currentDate}
          now={nav.now}
          eventsFor={eventsFor}
          onEventClick={onEventClick}
          onShowMore={nav.focusDay}
          classSlug={classSlug}
          rolePrefix="student"
          pagesUrl={pagesUrl}
          slidesUrl={slidesUrl}
        />
      ) : (
        <WeekGrid
          dates={nav.weekDates}
          now={nav.now}
          eventsFor={eventsFor}
          onEventClick={onEventClick}
          startHour={startHour}
          endHour={endHour}
        />
      )}
    </CalendarShell>
  );
};

export default StudentCalendarView;
