import { Link } from 'react-router';
import dayjs, { type Dayjs } from 'dayjs';
import { IconArrowRight } from '@tabler/icons-react';
import {
  getEventTypeLightBg,
  getEventTypeDarkText,
} from '~/components/features/calendar/utils';

export interface WeekEvent {
  id: string;
  title: string;
  start_time: string | Date;
  event_type?: string | null;
  is_deadline?: boolean;
}

interface WeeklyCalendarCardProps {
  events: WeekEvent[];
  weekStart: string | Date;
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

const groupByDay = (events: WeekEvent[], weekStart: Dayjs) => {
  const grid: WeekEvent[][] = Array.from({ length: 7 }, () => []);
  events.forEach(event => {
    const d = dayjs(event.start_time);
    const offset = d.diff(weekStart, 'day');
    if (offset >= 0 && offset < 7) grid[offset].push(event);
  });
  grid.forEach(day =>
    day.sort((a, b) => dayjs(a.start_time).valueOf() - dayjs(b.start_time).valueOf())
  );
  return grid;
};

const WeeklyCalendarCard = ({ events, weekStart, classSlug }: WeeklyCalendarCardProps) => {
  const start = dayjs(weekStart).startOf('day');
  const end = start.add(6, 'day');
  const today = dayjs().startOf('day');
  const grid = groupByDay(events, start);

  const weekNumber = Math.ceil(start.diff(start.startOf('month'), 'day') / 7) + 1;
  const sameMonth = start.month() === end.month();
  const rangeLabel = sameMonth
    ? `${start.format('MMMM D')}–${end.format('D')}`
    : `${start.format('MMM D')}–${end.format('MMM D')}`;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
        <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
          Week {weekNumber}: {rangeLabel}
        </h2>
        <Link
          to={`/student/${classSlug}/calendar`}
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 bg-panel hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
        >
          View calendar
          <IconArrowRight size={14} />
        </Link>
      </header>

      <div className="grid grid-cols-7 border-t border-stone-200 dark:border-neutral-800">
        {grid.map((dayEvents, idx) => {
          const day = start.add(idx, 'day');
          const isTodayDate = day.isSame(today, 'day');
          const isWeekend = idx === 0 || idx === 6;
          const visible = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - visible.length;

          return (
            <div
              key={idx}
              className={`flex flex-col px-2 py-3 border-r border-stone-200 dark:border-neutral-800 last:border-r-0 min-w-0 min-h-[200px] ${
                isWeekend ? 'bg-stone-50/70 dark:bg-neutral-800/30' : ''
              }`}
            >
              <div className="flex flex-col items-center mb-2">
                <span
                  className={`text-[10px] font-semibold tracking-[0.14em] ${
                    isTodayDate
                      ? 'text-[#858A92]'
                      : 'text-gray-400 dark:text-gray-500'
                  }`}
                >
                  {DAY_LABELS[idx]}
                </span>
                <span
                  className={`flex items-center justify-center w-7 h-7 rounded-full text-sm font-semibold mt-1 ${
                    isTodayDate ? 'text-white' : 'text-gray-800 dark:text-gray-200'
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
                      className={`text-[11px] leading-tight rounded px-1.5 py-1 truncate ${getEventTypeLightBg(type)} ${getEventTypeDarkText(type)}`}
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      {!event.is_deadline && (
                        <div className="text-[10px] opacity-70 truncate">
                          {formatTime(event.start_time)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {overflow > 0 && (
                  <Link
                    to={`/student/${classSlug}/calendar`}
                    className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 text-center pt-0.5"
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
