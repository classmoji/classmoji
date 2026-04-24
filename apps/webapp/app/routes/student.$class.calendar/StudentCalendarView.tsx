import { useEffect, useMemo, useState } from 'react';
import useLocalStorageState from 'use-local-storage-state';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import dayjs from 'dayjs';
import {
  addMonths,
  addWeeks,
  getEventTypeDotColor,
  getEventTypeDarkText,
  getEventTypeLabel,
  getEventTypeLightBg,
  getMonthDates,
  getMonthName,
  getWeekDates,
  isCurrentMonth,
  isSameDay,
  isToday,
} from '~/components/features/calendar/utils';
import type { CalendarEventWithLinks } from '~/components/features/calendar/types';

const HOUR_HEIGHT_PX = 64; // h-16
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22; // exclusive upper bound for positioning; last label is 9 PM
const HOURS: number[] = [];
for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) HOURS.push(h);

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const formatHourLabel = (hour: number) => {
  const h12 = hour % 12 || 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return { h: h12, suffix };
};

const isOutsideWindow = (event: CalendarEventWithLinks) => {
  if (event.is_deadline) return true;
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  const startHour = start.getHours() + start.getMinutes() / 60;
  const endHour = end.getHours() + end.getMinutes() / 60;
  return startHour < DAY_START_HOUR || startHour >= DAY_END_HOUR || endHour <= DAY_START_HOUR;
};

interface StudentCalendarViewProps {
  events: CalendarEventWithLinks[];
  onEventClick?: (event: CalendarEventWithLinks) => void;
  onMonthChange?: (year: number, month: number) => void;
}

const StudentCalendarView = ({ events, onEventClick, onMonthChange }: StudentCalendarViewProps) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useLocalStorageState('classmoji-calendar-view', {
    defaultValue: 'week',
  });
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const dates = useMemo(
    () => (view === 'month' ? getMonthDates(currentDate) : getWeekDates(currentDate)),
    [currentDate, view]
  );

  const weekDates = useMemo(() => getWeekDates(currentDate), [currentDate]);

  const handlePrev = () => {
    const next = view === 'month' ? addMonths(currentDate, -1) : addWeeks(currentDate, -1);
    setCurrentDate(next);
    onMonthChange?.(next.getFullYear(), next.getMonth());
  };

  const handleNext = () => {
    const next = view === 'month' ? addMonths(currentDate, 1) : addWeeks(currentDate, 1);
    setCurrentDate(next);
    onMonthChange?.(next.getFullYear(), next.getMonth());
  };

  const handleToday = () => {
    const today = new Date();
    setCurrentDate(today);
    onMonthChange?.(today.getFullYear(), today.getMonth());
  };

  const eventsByDay = useMemo(() => {
    const grouped: Record<string, CalendarEventWithLinks[]> = {};
    events.forEach(e => {
      const key = dayjs(e.start_time).startOf('day').toISOString();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(e);
    });
    Object.values(grouped).forEach(list =>
      list.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    );
    return grouped;
  }, [events]);

  const getEventsForDate = (date: Date) => {
    const key = dayjs(date).startOf('day').toISOString();
    return eventsByDay[key] ?? [];
  };

  const legendTypes = useMemo(() => {
    const present = new Set<string>();
    events.forEach(e => {
      if (e.is_deadline) {
        present.add('DEADLINE');
      } else if (e.event_type) {
        present.add(e.event_type);
      }
    });
    return Array.from(present);
  }, [events]);

  const weekRangeLabel = useMemo(() => {
    const start = dayjs(weekDates[0]);
    const end = dayjs(weekDates[6]);
    const weekNumber = Math.ceil(start.diff(start.startOf('month'), 'day') / 7) + 1;
    const sameMonth = start.month() === end.month();
    const range = sameMonth
      ? `${start.format('MMMM D')}–${end.format('D')}`
      : `${start.format('MMM D')}–${end.format('MMM D')}`;
    return `Week ${weekNumber}: ${range}`;
  }, [weekDates]);

  const monthLabel = `${getMonthName(currentDate)} ${currentDate.getFullYear()}`;

  const renderWeek = () => {
    const todayIsInWeek = weekDates.some(d => isSameDay(d, now));
    const nowHourFloat = now.getHours() + now.getMinutes() / 60;
    const showTimeLine =
      todayIsInWeek && nowHourFloat >= DAY_START_HOUR && nowHourFloat <= DAY_END_HOUR;
    const timeLineTop = (nowHourFloat - DAY_START_HOUR) * HOUR_HEIGHT_PX;

    const hasAnyAllDay = weekDates.some(d =>
      getEventsForDate(d).some(e => isOutsideWindow(e))
    );

    return (
      <div>
        {/* Day header row */}
        <div
          className="grid border-b border-stone-200 dark:border-neutral-800"
          style={{ gridTemplateColumns: '4rem repeat(7, minmax(0, 1fr))' }}
        >
          <div />
          {weekDates.map((d, idx) => {
            const isDayToday = isToday(d);
            return (
              <div key={idx} className="flex flex-col items-center py-4">
                <span className="text-[10px] font-semibold tracking-[0.16em] text-gray-400 dark:text-gray-500">
                  {DAY_LABELS[idx]}
                </span>
                <span
                  className={`mt-2 flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold ${
                    isDayToday ? 'text-white' : 'text-gray-800 dark:text-gray-200'
                  }`}
                  style={isDayToday ? { backgroundColor: 'var(--accent)' } : undefined}
                >
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {/* All-day / deadline strip */}
        {hasAnyAllDay && (
          <div
            className="grid border-b border-stone-200 dark:border-neutral-800"
            style={{ gridTemplateColumns: '4rem repeat(7, minmax(0, 1fr))' }}
          >
            <div />
            {weekDates.map((date, dayIdx) => {
              const allDay = getEventsForDate(date).filter(isOutsideWindow);
              return (
                <div
                  key={dayIdx}
                  className="px-1.5 py-1.5 border-l border-stone-200/70 dark:border-neutral-800 first:border-l-0 flex flex-col gap-1 min-h-[2.25rem]"
                >
                  {allDay.map(event => {
                    const type = event.is_deadline
                      ? 'DEADLINE'
                      : (event.event_type ?? 'OTHER');
                    const start = new Date(event.start_time);
                    return (
                      <button
                        key={event.id}
                        type="button"
                        onClick={() => onEventClick?.(event)}
                        className={`text-left rounded-md px-2 py-1 ${getEventTypeLightBg(type)} ${getEventTypeDarkText(type)} hover:shadow-sm transition-shadow`}
                      >
                        <div className="text-[12px] font-semibold leading-tight truncate">
                          {event.title}
                        </div>
                        {event.is_deadline && (
                          <div className="text-[10px] opacity-80 leading-tight truncate">
                            due{' '}
                            {dayjs(start).format(
                              start.getMinutes() === 0 ? 'h A' : 'h:mm A'
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {/* Grid body */}
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: '4rem repeat(7, minmax(0, 1fr))',
            height: `${HOURS.length * HOUR_HEIGHT_PX}px`,
          }}
        >
          {/* Hour labels + horizontal rules */}
          <div className="relative">
            {HOURS.map((hour, i) => {
              const { h, suffix } = formatHourLabel(hour);
              return (
                <div
                  key={hour}
                  className="absolute right-3 text-[11px] font-medium text-gray-400 dark:text-gray-500 flex flex-col items-end leading-tight"
                  style={{ top: `${i * HOUR_HEIGHT_PX + 4}px` }}
                >
                  <span>{h}</span>
                  <span>{suffix}</span>
                </div>
              );
            })}
          </div>

          {/* Horizontal hour lines across all 7 day columns (skip top edge) */}
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{ left: '4rem', right: 0 }}
          >
            {HOURS.map((hour, i) =>
              i === 0 ? null : (
                <div
                  key={hour}
                  className="absolute left-0 right-0 border-t border-stone-200/70 dark:border-neutral-800"
                  style={{ top: `${i * HOUR_HEIGHT_PX}px` }}
                />
              )
            )}
          </div>

          {/* Day columns with events */}
          {weekDates.map((date, dayIdx) => {
            const dayEvents = getEventsForDate(date).filter(e => !isOutsideWindow(e));
            const isDayToday = isSameDay(date, now);
            return (
              <div
                key={dayIdx}
                className="relative border-l border-stone-200/70 dark:border-neutral-800 first:border-l-0"
                style={{ gridColumn: dayIdx + 2 }}
              >
                {dayEvents.map(event => {
                  const start = new Date(event.start_time);
                  const end = new Date(event.end_time);
                  const startFrac =
                    start.getHours() + start.getMinutes() / 60 - DAY_START_HOUR;
                  const durationHours = Math.max(
                    0.75,
                    (end.getTime() - start.getTime()) / (1000 * 60 * 60)
                  );
                  const top = startFrac * HOUR_HEIGHT_PX;
                  const height = durationHours * HOUR_HEIGHT_PX - 4;
                  const type = event.event_type ?? 'OTHER';
                  return (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => onEventClick?.(event)}
                      className={`absolute left-2 right-2 rounded-lg px-2.5 py-1.5 text-left overflow-hidden transition-all hover:shadow-sm focus:outline-hidden focus:ring-2 focus:ring-violet-400/50 ${getEventTypeLightBg(type)} ${getEventTypeDarkText(type)}`}
                      style={{ top: `${top}px`, height: `${height}px` }}
                    >
                      <div className="text-[13px] font-semibold leading-tight truncate">
                        {event.title}
                      </div>
                      <div className="text-[11px] opacity-80 leading-tight truncate mt-0.5">
                        {dayjs(start).format(start.getMinutes() === 0 ? 'h A' : 'h:mm A')}
                      </div>
                    </button>
                  );
                })}

                {/* Current-time indicator — only on today's column */}
                {isDayToday && showTimeLine && (
                  <div
                    className="absolute left-0 right-0 pointer-events-none z-20 flex items-center"
                    style={{ top: `${timeLineTop}px` }}
                  >
                    <div
                      className="w-2 h-2 rounded-full -ml-1 shrink-0"
                      style={{ backgroundColor: 'var(--accent)' }}
                    />
                    <div className="flex-1 h-px" style={{ backgroundColor: 'var(--accent)' }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderMonth = () => {
    const weeks: Date[][] = [];
    for (let i = 0; i < dates.length; i += 7) weeks.push(dates.slice(i, i + 7));

    return (
      <div>
        <div className="grid grid-cols-7 border-b border-stone-200 dark:border-neutral-800">
          {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(d => (
            <div
              key={d}
              className="py-3 text-center text-[10px] font-semibold tracking-[0.16em] text-gray-400 dark:text-gray-500"
            >
              {d}
            </div>
          ))}
        </div>
        <div>
          {weeks.map((week, wIdx) => (
            <div
              key={wIdx}
              className="grid grid-cols-7 border-b border-stone-200 dark:border-neutral-800 last:border-b-0"
            >
              {week.map((date, dIdx) => {
                const dayEvents = getEventsForDate(date);
                const inMonth = isCurrentMonth(date, currentDate);
                const isDayToday = isToday(date);
                const visible = dayEvents.slice(0, 3);
                const overflow = dayEvents.length - visible.length;
                return (
                  <div
                    key={dIdx}
                    className={`min-h-[110px] p-2 border-l border-stone-200/70 dark:border-neutral-800 first:border-l-0 flex flex-col gap-1 ${
                      !inMonth ? 'bg-stone-50/70 dark:bg-neutral-900/40' : ''
                    }`}
                  >
                    <div className="flex justify-end">
                      <span
                        className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${
                          isDayToday
                            ? 'text-white'
                            : inMonth
                              ? 'text-gray-800 dark:text-gray-200'
                              : 'text-gray-400 dark:text-gray-600'
                        }`}
                        style={isDayToday ? { backgroundColor: 'var(--accent)' } : undefined}
                      >
                        {date.getDate()}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {visible.map(event => {
                        const type = event.event_type ?? 'OTHER';
                        return (
                          <button
                            type="button"
                            key={event.id}
                            onClick={() => onEventClick?.(event)}
                            className={`text-left text-[11px] rounded px-1.5 py-1 truncate ${getEventTypeLightBg(type)} ${getEventTypeDarkText(type)}`}
                          >
                            {event.title}
                          </button>
                        );
                      })}
                      {overflow > 0 && (
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 pl-1">
                          +{overflow} more
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 overflow-hidden min-h-[calc(100vh-10rem)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Previous"
            className="p-1.5 rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-stone-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <IconChevronLeft size={18} />
          </button>
          <button
            type="button"
            onClick={handleToday}
            className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 rounded-full hover:bg-stone-100 dark:hover:bg-neutral-800 transition-colors"
          >
            Today
          </button>
          <button
            type="button"
            onClick={handleNext}
            aria-label="Next"
            className="p-1.5 rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-stone-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <IconChevronRight size={18} />
          </button>
          <h2 className="ml-2 text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
            {view === 'week' ? weekRangeLabel : monthLabel}
          </h2>
        </div>

        <div className="flex items-center bg-stone-100 dark:bg-neutral-800 rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setView('week')}
            className={`px-3.5 py-1 text-xs font-medium rounded-full transition-all ${
              view === 'week'
                ? 'bg-white dark:bg-neutral-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            Week
          </button>
          <button
            type="button"
            onClick={() => setView('month')}
            className={`px-3.5 py-1 text-xs font-medium rounded-full transition-all ${
              view === 'month'
                ? 'bg-white dark:bg-neutral-700 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            Month
          </button>
        </div>
      </header>

      {legendTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 sm:px-6 pb-3 text-xs text-gray-600 dark:text-gray-300">
          {legendTypes.map(type => (
            <span key={type} className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${getEventTypeDotColor(type)}`} />
              {getEventTypeLabel(type)}
            </span>
          ))}
        </div>
      )}

      <div className="border-t border-stone-200 dark:border-neutral-800 overflow-x-auto">
        {view === 'week' ? renderWeek() : renderMonth()}
      </div>
    </section>
  );
};

export default StudentCalendarView;
