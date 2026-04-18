export type WeekEventKind = 'lecture' | 'asgn' | 'quiz';

export interface WeekEvent {
  kind: WeekEventKind;
  title: string;
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
}

const EVENT_THEME: Record<
  WeekEventKind,
  { bg: string; color: string; border: string }
> = {
  lecture: { bg: 'var(--bg-3)', color: 'var(--ink-1)', border: 'var(--line)' },
  asgn: {
    bg: 'var(--peach-soft)',
    color: 'var(--peach-ink)',
    border: 'oklch(88% 0.08 40)',
  },
  quiz: {
    bg: 'var(--mint-soft)',
    color: 'var(--mint-ink)',
    border: 'oklch(88% 0.08 155)',
  },
};

export function WeekStrip({ days, events }: WeekStripProps) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {days.map((d, i) => {
          const dayEvents = events[i] || [];
          return (
            <div
              key={i}
              style={{
                padding: '14px 10px 16px',
                borderRight: i < 6 ? '1px solid var(--line)' : 'none',
                minHeight: 180,
                position: 'relative',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}
              >
                <span
                  className="caps"
                  style={{ color: d.today ? 'var(--violet-ink)' : 'var(--ink-3)' }}
                >
                  {d.dow}
                </span>
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 600,
                    background: d.today ? 'var(--violet)' : 'transparent',
                    color: d.today ? 'white' : 'var(--ink-1)',
                  }}
                >
                  {d.day}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {dayEvents.map((e, ei) => {
                  const theme = EVENT_THEME[e.kind];
                  return (
                    <div
                      key={ei}
                      style={{
                        background: theme.bg,
                        border: `1px solid ${theme.border}`,
                        padding: '5px 7px',
                        borderRadius: 6,
                        fontSize: 11,
                        lineHeight: 1.3,
                        color: theme.color,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 11.5 }}>{e.title}</div>
                      {e.sub ? (
                        <div style={{ opacity: 0.75, fontSize: 10.5 }}>{e.sub}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default WeekStrip;
