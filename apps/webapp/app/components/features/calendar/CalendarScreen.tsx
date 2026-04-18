import { Link } from 'react-router';
import { IconChevron, IconChevronR } from '@classmoji/ui-components';
import type { CalendarEvent, CalendarEventKind } from './CalendarEvent';

interface CalendarScreenProps {
  /** Full year, e.g. 2026. */
  year: number;
  /** 0-indexed month (0 = January). */
  month: number;
  events: CalendarEvent[];
  subscribeUrl?: string | null;
  onPrev?: () => void;
  onNext?: () => void;
  onToday?: () => void;
}

const WEEKDAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const KIND_THEME: Record<CalendarEventKind, { bg: string; color: string }> = {
  lecture: { bg: 'var(--bg-3)', color: 'var(--ink-1)' },
  asgn: { bg: 'var(--peach-soft)', color: 'var(--peach-ink)' },
  quiz: { bg: 'var(--mint-soft)', color: 'var(--mint-ink)' },
  other: { bg: 'var(--bg-3)', color: 'var(--ink-1)' },
};

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function groupEventsByDate(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const grouped: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    if (!grouped[ev.date]) grouped[ev.date] = [];
    grouped[ev.date].push(ev);
  }
  return grouped;
}

export function CalendarScreen({
  year,
  month,
  events,
  subscribeUrl: _subscribeUrl,
  onPrev,
  onNext,
  onToday,
}: CalendarScreenProps) {
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = formatLocalDate(new Date());
  const grouped = groupEventsByDate(events);

  const totalCells = startDow + daysInMonth;
  const trailingPad = (7 - (totalCells % 7)) % 7;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1
          className="display"
          style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          {MONTH_LABELS[month]} {year}
        </h1>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={onToday}>
          Today
        </button>
        <div
          style={{
            display: 'flex',
            gap: 2,
            padding: 3,
            background: 'white',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '5px 10px' }}
            onClick={onPrev}
            aria-label="Previous month"
          >
            <IconChevron size={14} />
          </button>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '5px 10px' }}
            onClick={onNext}
            aria-label="Next month"
          >
            <IconChevronR size={14} />
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          {WEEKDAY_LABELS.map((d, i) => (
            <div
              key={d}
              className="caps"
              style={{
                padding: '10px 14px',
                borderRight: i < 6 ? '1px solid var(--line)' : 'none',
              }}
            >
              {d}
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {Array.from({ length: startDow }).map((_, i) => (
            <div
              key={`pad-start-${i}`}
              style={{
                minHeight: 110,
                borderRight: '1px solid var(--line)',
                borderBottom: '1px solid var(--line)',
                background: 'rgba(0,0,0,0.02)',
              }}
            />
          ))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const cellDate = new Date(year, month, day);
            const dateStr = formatLocalDate(cellDate);
            const isToday = dateStr === todayStr;
            const dayEvents = grouped[dateStr] || [];
            const visibleEvents = dayEvents.slice(0, 3);
            const hiddenCount = dayEvents.length - visibleEvents.length;
            const isLastInRow = ((startDow + i + 1) % 7) === 0;

            return (
              <div
                key={day}
                style={{
                  minHeight: 110,
                  padding: '8px 10px',
                  borderRight: !isLastInRow ? '1px solid var(--line)' : 'none',
                  borderBottom: '1px solid var(--line)',
                  background: isToday ? 'oklch(99% 0.02 285)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                      background: isToday ? 'var(--violet)' : 'transparent',
                      color: isToday ? 'white' : 'var(--ink-2)',
                    }}
                  >
                    {day}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    marginTop: 4,
                  }}
                >
                  {visibleEvents.map((ev, ei) => {
                    const theme = KIND_THEME[ev.kind] ?? KIND_THEME.other;
                    const chipStyle = {
                      background: theme.bg,
                      color: theme.color,
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 10.5,
                      fontWeight: 600,
                      display: 'block',
                      textDecoration: 'none',
                    } as const;
                    if (ev.href) {
                      return (
                        <Link
                          key={`${ev.title}-${ei}`}
                          to={ev.href}
                          className="truncate"
                          style={chipStyle}
                          title={ev.title}
                        >
                          {ev.title}
                        </Link>
                      );
                    }
                    return (
                      <div
                        key={`${ev.title}-${ei}`}
                        className="truncate"
                        style={chipStyle}
                        title={ev.title}
                      >
                        {ev.title}
                      </div>
                    );
                  })}
                  {hiddenCount > 0 && (
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: 'var(--ink-3)',
                        padding: '2px 6px',
                      }}
                    >
                      +{hiddenCount} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {Array.from({ length: trailingPad }).map((_, i) => (
            <div
              key={`pad-end-${i}`}
              style={{
                minHeight: 110,
                borderRight: i < trailingPad - 1 ? '1px solid var(--line)' : 'none',
                borderBottom: '1px solid var(--line)',
                background: 'rgba(0,0,0,0.02)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default CalendarScreen;
