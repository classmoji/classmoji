import { Link } from 'react-router';

export type WeekEventKind = 'lect' | 'quiz' | 'asgn' | 'proj' | 'oh' | 'lecture';

export interface WeekEvent {
  kind: WeekEventKind;
  title: string;
  /** Time/sub-label (e.g., "10:10 AM" or "due 11:59 PM"). */
  sub?: string;
}

export interface WeekDay {
  dow: string;
  day: number;
  today?: boolean;
}

interface WeekStripProps {
  days: WeekDay[];
  events: WeekEvent[][];
  /** Optional header label, e.g. "Week 3: April 12–18". */
  weekLabel?: string;
  calendarHref: string;
  /** Max events shown per day before collapsing into "+N more". */
  maxPerDay?: number;
}

function normalizeKind(kind: WeekEventKind): Exclude<WeekEventKind, 'lecture'> {
  return kind === 'lecture' ? 'lect' : kind;
}

export function WeekStrip({
  days,
  events,
  weekLabel,
  calendarHref,
  maxPerDay = 3,
}: WeekStripProps) {
  return (
    <div className="panel">
      <div className="flex items-center px-[18px] pt-[14px] pb-2">
        <div className="text-sm font-semibold">
          {weekLabel ?? 'This week'}
        </div>
        <div className="flex-1" />
        <Link to={calendarHref} className="btn btn-sm no-underline">
          View calendar →
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-2.5 px-[14px] pt-1 pb-[14px]">
        {days.map((d, i) => {
          const dayEvents = events[i] || [];
          const visible = dayEvents.slice(0, maxPerDay);
          const overflow = dayEvents.length - visible.length;
          return (
            <div
              key={i}
              className="flex flex-col gap-2 min-w-0"
            >
              <div className="text-center mb-1">
                <div className="caps text-[10.5px]">{d.dow}</div>
                {d.today ? (
                  <div className="mx-auto mt-1 grid place-items-center w-[26px] h-[26px] rounded-full bg-violet text-white text-xs font-semibold">
                    {d.day}
                  </div>
                ) : (
                  <div className="text-[15px] text-ink-0 mt-1">{d.day}</div>
                )}
              </div>
              {visible.map((e, j) => {
                const k = normalizeKind(e.kind);
                return (
                  <div key={j} className={`evt evt-${k}`}>
                    <div className="evt-title truncate">{e.title}</div>
                    {e.sub ? <div className="evt-time">{e.sub}</div> : null}
                  </div>
                );
              })}
              {overflow > 0 && (
                <div className="text-[11.5px] text-ink-3 text-center">
                  +{overflow} more
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default WeekStrip;
