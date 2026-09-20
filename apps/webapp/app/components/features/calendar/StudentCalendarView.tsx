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

import CalendarShell, { CalendarTypeFilter } from './CalendarShell';
import WeekGrid from './WeekGrid';
import MonthGrid from './MonthGrid';
import { useCalendarNavigation, useEventsByDate } from './useCalendarNavigation';
import type { CalendarEventWithLinks } from './types';

interface StudentCalendarViewProps {
  events: CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  onMonthChange?: (year: number, month: number) => void;
}

const StudentCalendarView = ({ events, onEventClick, onMonthChange }: StudentCalendarViewProps) => {
  const nav = useCalendarNavigation(onMonthChange);
  const eventsFor = useEventsByDate(events, nav.selectedTypes);

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
        />
      ) : (
        <WeekGrid
          dates={nav.weekDates}
          now={nav.now}
          eventsFor={eventsFor}
          onEventClick={onEventClick}
        />
      )}
    </CalendarShell>
  );
};

export default StudentCalendarView;
