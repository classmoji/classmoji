import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  /** Slot on the right of the header (e.g., admin "Add event" button). */
  headerActions?: ReactNode;
  /**
   * When provided, event chips become buttons that invoke this callback.
   * Otherwise chips render as `<Link>` to `ev.href` (or plain `<div>` if no href).
   */
  onEventClick?: (event: CalendarEvent) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

const SHORT_MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const HOUR_HEIGHT = 56; // px per hour row in week view
const DAY_START_HOUR = 8; // 8 AM
const DAY_END_HOUR = 19; // 7 PM (exclusive end)

const KIND_TO_EVT_CLASS: Record<CalendarEventKind, string> = {
  lecture: 'evt-lect',
  asgn: 'evt-asgn',
  quiz: 'evt-quiz',
  other: 'evt-oh',
};

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function groupEventsByDate(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
  const grouped: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    if (!grouped[ev.date]) grouped[ev.date] = [];
    grouped[ev.date].push(ev);
  }
  return grouped;
}

function formatHourLabel(hour: number): string {
  const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  return `${h12} ${ampm}`;
}

function formatTimeRange(startMinutes?: number, durationMinutes?: number): string | undefined {
  if (startMinutes === undefined) return undefined;
  const startH = Math.floor(startMinutes / 60);
  const startM = startMinutes % 60;
  const formatOne = (h: number, m: number) => {
    const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    const ampm = h >= 12 ? 'PM' : 'AM';
    return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  };
  if (!durationMinutes) return formatOne(startH, startM);
  const end = startMinutes + durationMinutes;
  const endH = Math.floor(end / 60);
  const endM = end % 60;
  return `${formatOne(startH, startM)}–${formatOne(endH, endM)}`;
}

function buildWeekRangeLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const sameYear = weekStart.getFullYear() === weekEnd.getFullYear();
  if (sameMonth) {
    return `${SHORT_MONTH_LABELS[weekStart.getMonth()]} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }
  if (sameYear) {
    return `${SHORT_MONTH_LABELS[weekStart.getMonth()]} ${weekStart.getDate()} – ${SHORT_MONTH_LABELS[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  }
  return `${SHORT_MONTH_LABELS[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${SHORT_MONTH_LABELS[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
}

interface EventChipProps {
  event: CalendarEvent;
  onEventClick?: (event: CalendarEvent) => void;
  style?: React.CSSProperties;
  showTime?: boolean;
  titleSize?: number;
}

function EventChip({ event, onEventClick, style, showTime = true, titleSize = 11.5 }: EventChipProps) {
  const klass = `evt ${KIND_TO_EVT_CLASS[event.kind] ?? 'evt-oh'}`;
  const timeRange = showTime ? formatTimeRange(event.startMinutes, event.durationMinutes) : undefined;
  const subtitle = timeRange ?? event.subtitle;
  const inner = (
    <>
      <div className="evt-title truncate" style={{ fontSize: titleSize }} title={event.title}>
        {event.title}
      </div>
      {subtitle ? <div className="evt-time truncate">{subtitle}</div> : null}
    </>
  );
  if (onEventClick) {
    return (
      <button
        type="button"
        className={klass}
        style={{ textAlign: 'left', ...style }}
        onClick={(e) => {
          e.stopPropagation();
          onEventClick(event);
        }}
      >
        {inner}
      </button>
    );
  }
  if (event.href) {
    return (
      <Link to={event.href} className={klass} style={{ textDecoration: 'none', ...style }}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={klass} style={style}>
      {inner}
    </div>
  );
}

export function CalendarScreen({
  year,
  month,
  events,
  subscribeUrl: _subscribeUrl,
  onPrev,
  onNext,
  onToday,
  headerActions,
  onEventClick,
}: CalendarScreenProps) {
  const today = useMemo(() => new Date(), []);
  const todayStr = formatLocalDate(today);
  const propMonthDate = useMemo(() => new Date(year, month, 1), [year, month]);

  // Anchor date drives the rendered week. Initialize to today if it falls inside
  // the loader's month, otherwise fall back to the 1st of the loader month.
  const initialAnchor = useMemo(() => {
    if (today.getFullYear() === year && today.getMonth() === month) return today;
    return propMonthDate;
  }, [today, year, month, propMonthDate]);

  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState<Date>(initialAnchor);

  // If the loader's year/month changes (parent navigated months), re-anchor.
  useEffect(() => {
    setAnchor(initialAnchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const grouped = useMemo(() => groupEventsByDate(events), [events]);
  const hours = useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => DAY_START_HOUR + i),
    []
  );

  const navigateBy = (deltaDays: number) => {
    const next = view === 'week' ? addDays(anchor, deltaDays) : new Date(anchor);
    if (view === 'month') next.setMonth(next.getMonth() + (deltaDays > 0 ? 1 : -1));
    setAnchor(next);
    if (next.getFullYear() !== year || next.getMonth() !== month) {
      if (deltaDays < 0) onPrev?.();
      else onNext?.();
    }
  };

  const handleToday = () => {
    setAnchor(new Date());
    if (today.getFullYear() !== year || today.getMonth() !== month) {
      onToday?.();
    }
  };

  const dateRangeLabel =
    view === 'week' ? buildWeekRangeLabel(weekStart) : `${MONTH_LABELS[month]} ${year}`;

  return (
    <div className="panel reveal-enter" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2.5 border-b border-line-cool"
        style={{ padding: '12px 18px' }}
      >
        <button
          type="button"
          className="btn btn-sm"
          style={{ padding: '4px 7px' }}
          onClick={() => navigateBy(-7)}
          aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
        >
          <IconChevron size={14} />
        </button>
        <button
          type="button"
          className="btn btn-sm"
          style={{ padding: '4px 7px' }}
          onClick={() => navigateBy(7)}
          aria-label={view === 'week' ? 'Next week' : 'Next month'}
        >
          <IconChevronR size={14} />
        </button>
        <div style={{ fontSize: 14, fontWeight: 600, marginLeft: 4 }}>{dateRangeLabel}</div>
        <button
          type="button"
          className="btn btn-sm bg-accent-soft text-accent-ink border-accent-soft-2"
          style={{ marginLeft: 6 }}
          onClick={handleToday}
        >
          Today
        </button>
        <div className="flex-1" />
        {headerActions}
        <div
          className="flex"
          style={{ padding: 2, background: 'var(--nav-hover)', borderRadius: 8 }}
        >
          <button
            type="button"
            onClick={() => setView('week')}
            className={view === 'week' ? 'btn btn-sm' : 'btn btn-sm btn-ghost'}
            style={
              view === 'week'
                ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                : { border: '1px solid transparent' }
            }
          >
            Week
          </button>
          <button
            type="button"
            onClick={() => setView('month')}
            className={view === 'month' ? 'btn btn-sm' : 'btn btn-sm btn-ghost'}
            style={
              view === 'month'
                ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                : { border: '1px solid transparent' }
            }
          >
            Month
          </button>
        </div>
      </div>

      {/* Legend */}
      <div
        className="flex"
        style={{ gap: 18, padding: '10px 18px 6px', fontSize: 12, color: 'var(--ink-2)' }}
      >
        {(
          [
            ['Lecture', 'var(--accent)'],
            ['Quiz', 'var(--accent)'],
            ['Assignment', 'var(--accent)'],
            ['Project', 'var(--accent)'],
          ] as Array<[string, string]>
        ).map(([label, color]) => (
          <span
            key={label}
            className="inline-flex items-center"
            style={{ gap: 6 }}
          >
            <span
              style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }}
            />
            {label}
          </span>
        ))}
      </div>

      {view === 'week' ? (
        <WeekView
          weekDays={weekDays}
          grouped={grouped}
          hours={hours}
          todayStr={todayStr}
          onEventClick={onEventClick}
        />
      ) : (
        <MonthView
          year={year}
          month={month}
          grouped={grouped}
          todayStr={todayStr}
          onEventClick={onEventClick}
        />
      )}
    </div>
  );
}

interface WeekViewProps {
  weekDays: Date[];
  grouped: Record<string, CalendarEvent[]>;
  hours: number[];
  todayStr: string;
  onEventClick?: (event: CalendarEvent) => void;
}

// Assign each timed event a lane so overlapping events render side-by-side
// instead of stacking. Classic sweep: within a cluster of mutually
// overlapping events, each event takes the lowest lane not in use at its
// start time; the cluster's `columns` is the max lane count reached.
function computeLaneLayout(events: CalendarEvent[]): Map<CalendarEvent, { lane: number; columns: number }> {
  const result = new Map<CalendarEvent, { lane: number; columns: number }>();
  const sorted = [...events].sort((a, b) => {
    const sa = a.startMinutes ?? 0;
    const sb = b.startMinutes ?? 0;
    if (sa !== sb) return sa - sb;
    return (b.durationMinutes ?? 0) - (a.durationMinutes ?? 0);
  });

  let cluster: CalendarEvent[] = [];
  let clusterEnd = -Infinity;
  const flushCluster = () => {
    if (cluster.length === 0) return;
    const lanes: number[] = []; // lanes[i] = end-minute of event currently occupying lane i
    const assigned = new Map<CalendarEvent, number>();
    for (const ev of cluster) {
      const start = ev.startMinutes ?? 0;
      const end = start + (ev.durationMinutes ?? 0);
      let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(end);
      } else {
        lanes[lane] = end;
      }
      assigned.set(ev, lane);
    }
    const columns = lanes.length;
    for (const ev of cluster) {
      result.set(ev, { lane: assigned.get(ev)!, columns });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const ev of sorted) {
    const start = ev.startMinutes ?? 0;
    const end = start + (ev.durationMinutes ?? 0);
    if (start >= clusterEnd) flushCluster();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flushCluster();
  return result;
}

function WeekView({ weekDays, grouped, hours, todayStr, onEventClick }: WeekViewProps) {
  // All-day / undated events per day (no startMinutes)
  const allDayByCol = weekDays.map((d) => {
    const dateStr = formatLocalDate(d);
    return (grouped[dateStr] ?? []).filter((ev) => ev.startMinutes === undefined);
  });

  const timedByCol = weekDays.map((d) => {
    const dateStr = formatLocalDate(d);
    return (grouped[dateStr] ?? []).filter((ev) => ev.startMinutes !== undefined);
  });

  const laneByCol = timedByCol.map((list) => computeLaneLayout(list));

  const hasAllDay = allDayByCol.some((list) => list.length > 0);

  return (
    <>
      {/* Day headers — desktop */}
      <div
        className="hidden md:grid border-t border-line-cool"
        style={{ gridTemplateColumns: '48px repeat(7, 1fr)' }}
      >
        <div />
        {weekDays.map((d, i) => {
          const isToday = formatLocalDate(d) === todayStr;
          return (
            <div
              key={i}
              className="border-l border-line-cool text-center"
              style={{ padding: '10px 0' }}
            >
              <div className="caps">{WEEKDAY_LABELS[d.getDay()]}</div>
              {isToday ? (
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    color: '#fff',
                    margin: '4px auto 0',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {d.getDate()}
                </div>
              ) : (
                <div style={{ fontSize: 15, marginTop: 4, color: 'var(--ink-1)' }}>
                  {d.getDate()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* All-day row — desktop */}
      {hasAllDay ? (
        <div
          className="hidden md:grid border-t border-line-cool"
          style={{ gridTemplateColumns: '48px repeat(7, 1fr)' }}
        >
          <div className="caps text-right" style={{ padding: '6px 8px 6px 0' }}>
            All
          </div>
          {allDayByCol.map((list, i) => (
            <div
              key={i}
              className="border-l border-line-cool"
              style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}
            >
              {list.map((ev, ei) => (
                <EventChip
                  key={`${ev.id ?? ev.title}-${ei}`}
                  event={ev}
                  onEventClick={onEventClick}
                  showTime={false}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* Hour grid — desktop */}
      <div className="hidden md:block" style={{ overflowY: 'auto', maxHeight: 440 }}>
        {hours.map((h) => (
          <div
            key={h}
            className="border-t border-line-cool"
            style={{
              display: 'grid',
              gridTemplateColumns: '48px repeat(7, 1fr)',
              minHeight: HOUR_HEIGHT,
              position: 'relative',
            }}
          >
            <div
              className="caps text-right"
              style={{ padding: '4px 8px 0 0' }}
            >
              {formatHourLabel(h)}
            </div>
            {weekDays.map((_d, i) => {
              const dayEvents = timedByCol[i].filter((ev) => {
                const startHour = Math.floor((ev.startMinutes ?? 0) / 60);
                return startHour === h;
              });
              return (
                <div
                  key={i}
                  className="border-l border-line-cool"
                  style={{ padding: 4, position: 'relative' }}
                >
                  {dayEvents.map((ev, ei) => {
                    const startMin = ev.startMinutes ?? 0;
                    const minuteOffset = startMin - h * 60;
                    const dur = ev.durationMinutes ?? 60;
                    const top = (minuteOffset / 60) * HOUR_HEIGHT + 4;
                    const height = Math.max(28, (dur / 60) * HOUR_HEIGHT - 6);
                    const layout = laneByCol[i].get(ev) ?? { lane: 0, columns: 1 };
                    // Each lane gets an equal slice of the column's inner
                    // width, separated by a 2px gutter for visual distinction.
                    const widthExpr = `calc((100% - 8px - ${(layout.columns - 1) * 2}px) / ${layout.columns})`;
                    const leftExpr = `calc(4px + ${layout.lane} * ((100% - 8px - ${(layout.columns - 1) * 2}px) / ${layout.columns} + 2px))`;
                    return (
                      <EventChip
                        key={`${ev.id ?? ev.title}-${ei}`}
                        event={ev}
                        onEventClick={onEventClick}
                        style={{
                          position: 'absolute',
                          left: leftExpr,
                          width: widthExpr,
                          top,
                          height,
                          overflow: 'hidden',
                          boxShadow:
                            layout.columns > 1
                              ? '0 0 0 1px var(--panel), 0 1px 2px rgba(20,10,40,0.08)'
                              : undefined,
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Mobile: vertical day list */}
      <div className="block md:hidden border-t border-line-cool">
        {weekDays.map((d, i) => {
          const isToday = formatLocalDate(d) === todayStr;
          const dayEvents = [...allDayByCol[i], ...timedByCol[i]].sort(
            (a, b) => (a.startMinutes ?? -1) - (b.startMinutes ?? -1)
          );
          return (
            <div
              key={i}
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--line-cool)',
              }}
            >
              <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
                <span className="caps">{WEEKDAY_LABELS[d.getDay()]}</span>
                {isToday ? (
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      color: '#fff',
                      display: 'inline-grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {d.getDate()}
                  </span>
                ) : (
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{d.getDate()}</span>
                )}
              </div>
              {dayEvents.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>No events</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvents.map((ev, ei) => (
                    <EventChip
                      key={`${ev.id ?? ev.title}-${ei}`}
                      event={ev}
                      onEventClick={onEventClick}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

interface MonthViewProps {
  year: number;
  month: number;
  grouped: Record<string, CalendarEvent[]>;
  todayStr: string;
  onEventClick?: (event: CalendarEvent) => void;
}

function MonthView({ year, month, grouped, todayStr, onEventClick }: MonthViewProps) {
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = startDow + daysInMonth;
  const trailingPad = (7 - (totalCells % 7)) % 7;

  return (
    <>
      {/* Day-of-week header */}
      <div
        className="hidden md:grid border-t border-line-cool"
        style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}
      >
        {WEEKDAY_LABELS.map((d, i) => (
          <div
            key={d}
            className="caps text-center"
            style={{
              padding: '10px 14px',
              borderLeft: i > 0 ? '1px solid var(--line-cool)' : undefined,
            }}
          >
            {d.toUpperCase()}
          </div>
        ))}
      </div>

      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}
      >
        {Array.from({ length: startDow }).map((_, i) => (
          <div
            key={`pad-start-${i}`}
            className="border-t border-line-cool"
            style={{
              minHeight: 110,
              borderLeft: i > 0 ? '1px solid var(--line-cool)' : undefined,
              background: 'rgba(0,0,0,0.015)',
            }}
          />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const cellDate = new Date(year, month, day);
          const dateStr = formatLocalDate(cellDate);
          const isToday = dateStr === todayStr;
          const dayEvents = grouped[dateStr] ?? [];
          const visible = dayEvents.slice(0, 3);
          const hidden = dayEvents.length - visible.length;
          const colIdx = (startDow + i) % 7;
          return (
            <div
              key={day}
              className="border-t border-line-cool"
              style={{
                minHeight: 110,
                padding: '8px 10px',
                borderLeft: colIdx > 0 ? '1px solid var(--line-cool)' : undefined,
              }}
            >
              <div className="flex justify-end">
                {isToday ? (
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      color: '#fff',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {day}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-2)' }}>
                    {day}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                {visible.map((ev, ei) => (
                  <EventChip
                    key={`${ev.id ?? ev.title}-${ei}`}
                    event={ev}
                    onEventClick={onEventClick}
                    showTime={false}
                    titleSize={10.5}
                  />
                ))}
                {hidden > 0 ? (
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ink-3)', padding: '2px 6px' }}>
                    +{hidden} more
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {Array.from({ length: trailingPad }).map((_, i) => (
          <div
            key={`pad-end-${i}`}
            className="border-t border-line-cool"
            style={{
              minHeight: 110,
              borderLeft: '1px solid var(--line-cool)',
              background: 'rgba(0,0,0,0.015)',
            }}
          />
        ))}
      </div>

      {/* Mobile: vertical list of days that have events */}
      <div className="block md:hidden border-t border-line-cool">
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const cellDate = new Date(year, month, day);
          const dateStr = formatLocalDate(cellDate);
          const dayEvents = grouped[dateStr] ?? [];
          if (dayEvents.length === 0) return null;
          const isToday = dateStr === todayStr;
          return (
            <div key={day} style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-cool)' }}>
              <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
                <span className="caps">{WEEKDAY_LABELS[cellDate.getDay()]}</span>
                {isToday ? (
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      color: '#fff',
                      display: 'inline-grid',
                      placeItems: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {day}
                  </span>
                ) : (
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{day}</span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dayEvents.map((ev, ei) => (
                  <EventChip
                    key={`${ev.id ?? ev.title}-${ei}`}
                    event={ev}
                    onEventClick={onEventClick}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default CalendarScreen;
