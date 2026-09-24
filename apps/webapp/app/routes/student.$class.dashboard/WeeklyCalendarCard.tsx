import { Link } from 'react-router';
import dayjs from 'dayjs';
import { useHydrated } from 'remix-utils/use-hydrated';
import { IconArrowRight } from '@tabler/icons-react';
import { getEventTypeLightBg, getEventTypeDarkText } from '~/components/features/calendar/utils';
import type { CalendarEventWithLinks } from '~/components/features/calendar/types';
import { groupByDay, startOfWeek } from './week';

/**
 * The card needs four fields, and it needs id/title to be PRESENT — the
 * dashboard loader maps them through String(...) and the card keys its rows on
 * id. So it picks the fields whose shape has to agree with the shared calendar
 * type and keeps its own, stricter, contract for the rest. event_type stays
 * nullable because the loader passes a missing type through as null rather
 * than inventing one.
 */
export type WeekEvent = Pick<CalendarEventWithLinks, 'start_time' | 'is_deadline'> & {
  id: string;
  title: string;
  event_type?: string | null;
};

interface WeeklyCalendarCardProps {
  events: WeekEvent[];
  /** The server's week start as `YYYY-MM-DD`; only the first-render frame. */
  weekStart: string;
  classSlug: string;
}

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const eventTypeFor = (event: WeekEvent) => {
  if (event.is_deadline) return 'DEADLINE';
  return event.event_type ?? 'OTHER';
};

const formatTime = (date: string | Date) => {
  const d = dayjs(date);
  return d.minute() === 0 ? d.format('h A') : d.format('h:mm A');
};

const EMPTY_GRID: WeekEvent[][] = Array.from({ length: 7 }, () => []);

const WeeklyCalendarCard = ({ events, weekStart, classSlug }: WeeklyCalendarCardProps) => {
  // The week, "today" and each event's day and time all depend on the time
  // zone, and the server renders in UTC. So the server render and the first
  // client render (hydration) both show the server's week with no events and
  // no today circle, and only once hydrated does the card switch to the
  // browser's own week. The card used to take the server's UTC midnight and
  // round it down in the browser, which started US students' strip on Saturday
  // under SUN; computing local values on the first render instead would
  // mismatch the server's markup (React error #418).
  const hydrated = useHydrated();
  const start = hydrated ? startOfWeek() : dayjs(weekStart);
  const end = start.add(6, 'day');
  const today = hydrated ? dayjs().startOf('day') : null;
  const grid = hydrated ? groupByDay(events, start) : EMPTY_GRID;

  // The date range, and only the date range. The card used to lead with
  // "Week 6:", counted from the start of the MONTH rather than the term — so it
  // reset to "Week 1" partway through, named a week nobody in the class would
  // recognise, and wrapped the heading onto two lines saying it. Nothing in the
  // schema records when a term starts, so there is no week number to be right.
  const sameMonth = start.month() === end.month();
  const rangeLabel = sameMonth
    ? `${start.format('MMMM D')}–${end.format('D')}`
    : `${start.format('MMM D')}–${end.format('MMM D')}`;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-line overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
        <h2 className="text-base sm:text-lg font-semibold text-ink-0 tracking-tight">
          {rangeLabel}
        </h2>
        <Link
          to={`/student/${classSlug}/calendar`}
          data-tour="dashboard-view-calendar"
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-line bg-panel hover:bg-nav-hover transition-colors"
        >
          View calendar
          <IconArrowRight size={14} />
        </Link>
      </header>

      <div className="grid grid-cols-7 border-t border-line">
        {grid.map((dayEvents, idx) => {
          const day = start.add(idx, 'day');
          const isTodayDate = today ? day.isSame(today, 'day') : false;
          const isWeekend = idx === 0 || idx === 6;
          const visible = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - visible.length;

          return (
            <div
              key={idx}
              className={`flex flex-col px-2 py-3 border-r border-line last:border-r-0 min-w-0 min-h-[200px] ${
                isWeekend ? 'bg-stone-50/70 dark:bg-neutral-800/30' : ''
              }`}
            >
              <div className="flex flex-col items-center mb-2">
                <span
                  className={`text-xs font-semibold tracking-[0.14em] ${
                    isTodayDate ? 'text-[#858A92]' : 'text-ink-4'
                  }`}
                >
                  {DAY_LABELS[idx]}
                </span>
                <span
                  className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-semibold mt-1 ${
                    isTodayDate ? 'text-white' : 'text-ink-1'
                  }`}
                  style={isTodayDate ? { backgroundColor: 'var(--accent)' } : undefined}
                >
                  {day.date()}
                </span>
              </div>

              <div className="flex flex-col gap-1 min-w-0">
                {visible.map(event => {
                  const type = eventTypeFor(event);
                  return (
                    <div
                      key={event.id}
                      title={event.title}
                      className={`text-xs leading-tight rounded px-1.5 py-1 truncate ${getEventTypeLightBg(type)} ${getEventTypeDarkText(type)}`}
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      {!event.is_deadline && (
                        <div className="text-xs opacity-70 truncate">
                          {formatTime(event.start_time)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {overflow > 0 && (
                  <Link
                    to={`/student/${classSlug}/calendar`}
                    className="text-xs text-ink-3 hover:text-gray-800 dark:hover:text-gray-200 text-center pt-0.5"
                  >
                    +{overflow} more
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default WeeklyCalendarCard;
