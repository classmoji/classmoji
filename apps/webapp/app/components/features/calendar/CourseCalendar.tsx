/**
 * The staff calendar: the shared shell and grids, plus the drag layer and the
 * drag-to-select rectangle that only staff get.
 *
 * Everything visible here is shared with the student calendar
 * (`StudentCalendarView`) — instructors assume a class sees what they see, and
 * the two views had drifted into different row heights, different day headers,
 * different labels and different block contents. What is left in this file is
 * exactly the authoring behaviour: drag an event to move it, drag across empty
 * hours to create one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import CalendarShell, { CalendarTypeFilter } from './CalendarShell';
import WeekGrid from './WeekGrid';
import MonthGrid from './MonthGrid';
import CalendarDragLayer, {
  DraggableEvent,
  DroppableCell,
  canDragEvent,
} from './CalendarDragLayer';
import { hourRange } from './geometry';
import { useCalendarNavigation, useEventsByDate } from './useCalendarNavigation';
import { isSameDay } from './utils';
import type { RenderCell, RenderEvent } from './gridRenderProps';
import type { CalendarEventWithLinks } from './types';

interface CourseCalendarProps {
  events: CalendarEventWithLinks[];
  onEventClick?: ((event: CalendarEventWithLinks) => void) | null;
  onEventDrop?: ((event: CalendarEventWithLinks, newStart: Date, newEnd: Date) => void) | null;
  onDeadlineDrop?: ((event: CalendarEventWithLinks, newStart: Date) => void) | null;
  onMonthChange?: ((year: number, month: number) => void) | null;
  /** Week view: drag across hour cells to pick a time range (click = 1 hour). */
  onRangeSelect?: ((start: Date, end: Date) => void) | null;
  canDragDeadlines?: boolean;
  /**
   * Where a starred resource under a month chip points. Passed straight to the
   * month grid; the calendar itself does not read them.
   */
  classSlug?: string;
  rolePrefix?: string;
  pagesUrl?: string;
  slidesUrl?: string;
}

/** The hour cells covered by an in-progress drag-to-select, on one day. */
interface DragSelection {
  dayIndex: number;
  date: Date;
  anchorHour: number;
  hoverHour: number;
}

const CourseCalendar = ({
  events,
  onEventClick,
  onEventDrop,
  onDeadlineDrop,
  onMonthChange,
  onRangeSelect,
  canDragDeadlines = false,
  classSlug,
  rolePrefix,
  pagesUrl,
  slidesUrl,
}: CourseCalendarProps) => {
  const nav = useCalendarNavigation(onMonthChange);
  const eventsFor = useEventsByDate(events, nav.selectedTypes);
  // The whole loaded month, UNFILTERED: the grid must not resize as the reader
  // pages between its weeks or toggles a type in the legend.
  const { startHour, endHour } = useMemo(() => hourRange(events), [events]);

  // Drag-to-select is plain mouse state, not dnd-kit: it picks a range of empty
  // cells rather than moving anything, and routing it through the drag library
  // would put dnd-kit between every click and the grid.
  const [dragSelect, setDragSelect] = useState<DragSelection | null>(null);

  // Finish on mouseup ANYWHERE — the pointer often leaves the grid mid-drag.
  // A plain click yields a one-hour range.
  useEffect(() => {
    if (!dragSelect) return;

    const handleMouseUp = () => {
      const { date, anchorHour, hoverHour } = dragSelect;
      setDragSelect(null);
      if (!onRangeSelect) return;

      const start = new Date(date);
      start.setHours(Math.min(anchorHour, hoverHour), 0, 0, 0);
      const end = new Date(date);
      // Clamped at 24: selecting the 11 PM row ends the range at the NEXT
      // day's midnight, which is what `setHours(24)` builds and what the add
      // modal's `buildEventWindow` rebuilds when it rolls an end past midnight.
      end.setHours(Math.min(Math.max(anchorHour, hoverHour) + 1, 24), 0, 0, 0);
      onRangeSelect(start, end);
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [dragSelect, onRangeSelect]);

  const handleEventClick = useCallback(
    (event: CalendarEventWithLinks) => onEventClick?.(event),
    [onEventClick]
  );

  const renderEvent: RenderEvent = ({ event, placement, className, style, children }) => {
    const draggable = canDragEvent(event, canDragDeadlines, onEventDrop);
    const cursor = draggable
      ? 'cursor-grab active:cursor-grabbing'
      : placement === 'week'
        ? ''
        : 'cursor-pointer';

    return (
      <DraggableEvent
        event={event}
        disabled={!draggable}
        className={`${className} ${cursor}`}
        style={style}
        // A deadline chip looks like every other chip, so say what dragging it
        // would do. Only where it IS draggable, and not on a week block, whose
        // card already fills the space a tooltip would cover.
        title={
          draggable && event.is_deadline && placement !== 'week'
            ? 'Drag to change deadline'
            : undefined
        }
      >
        {children}
      </DraggableEvent>
    );
  };

  const renderCell: RenderCell = ({ dropId, date, hour, dayIndex, className, style, children }) => {
    const isHourCell = hour !== undefined && dayIndex !== undefined;
    const isInSelection =
      isHourCell &&
      dragSelect !== null &&
      dragSelect.dayIndex === dayIndex &&
      hour >= Math.min(dragSelect.anchorHour, dragSelect.hoverHour) &&
      hour <= Math.max(dragSelect.anchorHour, dragSelect.hoverHour);

    return (
      <DroppableCell
        id={dropId}
        className={`${className} ${
          isHourCell && onRangeSelect ? 'cursor-pointer hover:bg-nav-hover/50' : ''
        } ${isInSelection ? '!bg-blue-100/70 dark:!bg-blue-900/40' : ''}`}
        style={style}
        onMouseDown={
          isHourCell && onRangeSelect
            ? e => {
                if (e.button !== 0) return;
                e.preventDefault(); // no text selection while dragging
                setDragSelect({ dayIndex, date, anchorHour: hour, hoverHour: hour });
              }
            : undefined
        }
        onMouseEnter={
          isHourCell && dragSelect && isSameDay(dragSelect.date, date)
            ? () => setDragSelect(s => (s ? { ...s, hoverHour: hour } : s))
            : undefined
        }
      >
        {children}
      </DroppableCell>
    );
  };

  return (
    <CalendarDragLayer view={nav.view} onEventDrop={onEventDrop} onDeadlineDrop={onDeadlineDrop}>
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
            onEventClick={handleEventClick}
            onShowMore={nav.focusDay}
            renderEvent={renderEvent}
            renderCell={renderCell}
            classSlug={classSlug}
            rolePrefix={rolePrefix}
            pagesUrl={pagesUrl}
            slidesUrl={slidesUrl}
          />
        ) : (
          <WeekGrid
            dates={nav.weekDates}
            now={nav.now}
            eventsFor={eventsFor}
            onEventClick={handleEventClick}
            // The strip is the only drop target that keeps an event's time of
            // day, so staff who can drop need it even on an empty week.
            alwaysShowAllDay={Boolean(onEventDrop || onDeadlineDrop)}
            startHour={startHour}
            endHour={endHour}
            renderEvent={renderEvent}
            renderCell={renderCell}
          />
        )}
      </CalendarShell>
    </CalendarDragLayer>
  );
};

export default CourseCalendar;
