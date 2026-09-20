/**
 * The frame both calendars sit in: the panel, the header (previous / Today /
 * next, the range label, the Week|Month toggle), a legend row, and the grid.
 *
 * The label is built here rather than passed in. It is the single thing the two
 * headers disagreed about the longest — one said `September 2026 20 – 26`, the
 * other `Week 6: September 20–26`, where "Week 6" counted weeks within the
 * month and reset to "Week 1" partway through a term — and a slot is exactly
 * what let them disagree. Everything a caller does need to vary (what sits
 * beside the toggle, what the legend says) is a slot.
 */

import type { ReactNode } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { formatDayRange, formatMonthYear, getEventTypeDotColor, getEventTypeLabel } from './utils';
import type { CalendarView } from './useCalendarNavigation';

/**
 * The five types the legend offers, fixed rather than derived from what the
 * loaded month happens to contain. The Prisma enum has four, `DEADLINE` is
 * synthesized, and nothing else can appear — so deriving the list can only ever
 * SHRINK it, which made the filter flicker as you paged between months.
 */
export const CALENDAR_EVENT_TYPES = [
  'OFFICE_HOURS',
  'LECTURE',
  'LAB',
  'ASSESSMENT',
  'DEADLINE',
] as const;

interface CalendarTypeFilterProps {
  /** Empty means "no filter": every type is drawn at full strength. */
  selectedTypes: string[];
  onToggleType: (type: string) => void;
}

/**
 * The legend, which is also the filter. Students had a read-only legend and
 * staff had filter buttons; an instructor demonstrating "click Lecture to see
 * only lectures" was describing a control the class did not have.
 */
export const CalendarTypeFilter = ({ selectedTypes, onToggleType }: CalendarTypeFilterProps) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 sm:px-6 pb-3 text-xs text-gray-600 dark:text-gray-300">
    {CALENDAR_EVENT_TYPES.map(type => {
      const isActive = selectedTypes.length === 0 || selectedTypes.includes(type);
      return (
        <button
          key={type}
          type="button"
          aria-pressed={isActive}
          onClick={() => onToggleType(type)}
          className={`inline-flex items-center gap-1.5 rounded-full px-1 transition-opacity focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${
            isActive ? '' : 'opacity-40'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${getEventTypeDotColor(type)}`} />
          {getEventTypeLabel(type)}
        </button>
      );
    })}
  </div>
);

interface CalendarShellProps {
  currentDate: Date;
  /** Sunday…Saturday of the week on screen; the source of the `20 – 26` range. */
  weekDates: Date[];
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Usually `<CalendarTypeFilter />`; omitted, the row disappears. */
  legend?: ReactNode;
  /** Header controls that belong to one role only, placed before the toggle. */
  actions?: ReactNode;
  children: ReactNode;
}

const navButtonClass =
  'p-1.5 rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-nav-hover transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent';

const toggleButtonClass = (isActive: boolean) =>
  `px-3.5 py-1 text-xs font-medium rounded-full transition-all focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${
    isActive ? 'bg-white dark:bg-neutral-700 text-ink-0 shadow-sm' : 'text-ink-3'
  }`;

const CalendarShell = ({
  currentDate,
  weekDates,
  view,
  onViewChange,
  onPrevious,
  onNext,
  onToday,
  legend,
  actions,
  children,
}: CalendarShellProps) => (
  <section className="rounded-2xl bg-panel ring-1 ring-line overflow-hidden min-h-[calc(100vh-10rem)]">
    <header className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPrevious} aria-label="Previous" className={navButtonClass}>
          <IconChevronLeft size={18} />
        </button>
        <button
          type="button"
          onClick={onToday}
          className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 rounded-full hover:bg-nav-hover transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        >
          Today
        </button>
        <button type="button" onClick={onNext} aria-label="Next" className={navButtonClass}>
          <IconChevronRight size={18} />
        </button>
        <h2 className="ml-2 text-base sm:text-lg font-semibold text-ink-0 tracking-tight">
          {formatMonthYear(currentDate)}
          {view === 'week' && weekDates.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-3">
              {formatDayRange(weekDates[0], weekDates[weekDates.length - 1])}
            </span>
          )}
        </h2>
      </div>

      <div className="flex items-center gap-2">
        {actions}
        {/* The in-classroom tour points at this element by name. */}
        <div
          data-tour="calendar-view-toggle"
          className="flex items-center bg-nav-hover rounded-full p-0.5"
        >
          <button
            type="button"
            onClick={() => onViewChange('week')}
            className={toggleButtonClass(view === 'week')}
          >
            Week
          </button>
          <button
            type="button"
            onClick={() => onViewChange('month')}
            className={toggleButtonClass(view === 'month')}
          >
            Month
          </button>
        </div>
      </div>
    </header>

    {legend}

    {/* One horizontal scroller for the whole grid, so the day header, the
        all-day strip and the hour rows stay column-aligned when scrolled. */}
    <div className="border-t border-line overflow-x-auto">{children}</div>
  </section>
);

export default CalendarShell;
