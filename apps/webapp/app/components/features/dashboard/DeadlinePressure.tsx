import { Card, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { CardHeader } from '~/components';

export interface DeadlineBucket {
  date: string; // YYYY-MM-DD
  assignments: Array<{ id: string; title: string; dueAt: string }>;
}

interface DeadlinePressureProps {
  buckets: DeadlineBucket[];
}

/**
 * Horizontal timeline covering the next 7 days. For each day we render a dot
 * whose size scales with assignment count. Hover reveals the titles.
 */
const DeadlinePressure = ({ buckets }: DeadlinePressureProps) => {
  const today = dayjs().startOf('day');
  const days: Array<{ date: string; label: string; dayLabel: string }> = [];
  for (let i = 0; i < 7; i++) {
    const d = today.add(i, 'day');
    days.push({
      date: d.format('YYYY-MM-DD'),
      label: d.format('MMM D'),
      dayLabel: d.format('ddd'),
    });
  }
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  const maxCount = Math.max(1, ...buckets.map((b) => b.assignments.length));

  return (
    <Card className="h-full" data-testid="deadline-pressure">
      <CardHeader>Deadline Pressure (next 7 days)</CardHeader>

      <div className="flex items-end justify-between gap-2 py-6 min-h-[180px]">
        {days.map((d) => {
          const bucket = byDate.get(d.date);
          const count = bucket?.assignments.length ?? 0;
          // size: 12px (empty) -> 56px (max)
          const size = count === 0 ? 12 : 16 + Math.round((count / maxCount) * 40);
          const assignments = bucket?.assignments ?? [];
          const tooltipContent =
            count === 0 ? (
              <span>No deadlines</span>
            ) : (
              <div className="text-xs">
                {assignments.map((a) => (
                  <div key={a.id} className="truncate">
                    • {a.title}
                  </div>
                ))}
              </div>
            );

          return (
            <div key={d.date} className="flex flex-col items-center gap-2 flex-1 min-w-0">
              <div className="flex-1 flex items-end justify-center w-full">
                <Tooltip title={tooltipContent}>
                  <div
                    data-testid="deadline-dot"
                    className={`rounded-full transition-transform hover:scale-110 cursor-pointer flex items-center justify-center text-[10px] font-bold ${
                      count === 0
                        ? 'bg-gray-200 dark:bg-gray-700'
                        : count >= 3
                          ? 'bg-rose-ink dark:bg-red-500 text-white'
                          : count === 2
                            ? 'bg-amber-ink dark:bg-yellow-500 text-white'
                            : 'bg-primary-500 dark:bg-primary-400 text-white'
                    }`}
                    style={{ width: size, height: size }}
                  >
                    {count > 0 ? count : ''}
                  </div>
                </Tooltip>
              </div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">
                {d.dayLabel}
              </div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
};

export default DeadlinePressure;
