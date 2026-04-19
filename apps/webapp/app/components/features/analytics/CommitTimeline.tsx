import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { useDarkMode } from '~/hooks';
import theme from '~/config/theme';

export type CommitRecord = {
  sha: string;
  author_login: string | null;
  author_email: string | null;
  author_user_id: string | null;
  ts: string;
  message: string;
  additions: number;
  deletions: number;
  parents: string[];
};

export interface CommitTimelineProps {
  commits: CommitRecord[];
  deadline: string | null;
}

/**
 * Buckets commits by UTC day and returns sorted `{day, count}` rows.
 * Exported for testing / reuse by summary widgets.
 */
export function bucketCommitsByDay(commits: CommitRecord[]): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of commits) {
    if (!c.ts) continue;
    // Bucket in UTC by manipulating the ISO string directly to avoid
    // timezone drift (dayjs.utc requires the utc plugin).
    const day = c.ts.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

const CommitTimeline = ({ commits, deadline }: CommitTimelineProps) => {
  const { isDarkMode } = useDarkMode();

  if (!commits || commits.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 text-sm"
        style={{ height: 180 }}
        data-testid="commit-timeline-empty"
      >
        No commits
      </div>
    );
  }

  const data = bucketCommitsByDay(commits);
  const deadlineDay = deadline ? deadline.slice(0, 10) : null;

  const axisTick = { fontSize: 12, fill: isDarkMode ? '#9ca3af' : '#666' };
  const axisLine = { stroke: isDarkMode ? '#4b5563' : '#e0e0e0' };

  return (
    <div style={{ width: '100%', height: 220 }} data-testid="commit-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 12, right: 24, left: 0, bottom: 8 }}
        >
          <defs>
            <linearGradient id="commitTimelineFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.PRIMARY} stopOpacity={0.45} />
              <stop offset="100%" stopColor={theme.PRIMARY} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? '#374151' : '#f0f0f0'} />
          <XAxis dataKey="day" tick={axisTick} axisLine={axisLine} />
          <YAxis allowDecimals={false} tick={axisTick} axisLine={axisLine} />
          <Tooltip
            contentStyle={{
              backgroundColor: isDarkMode ? '#111827' : '#ffffff',
              border: `1px solid ${isDarkMode ? '#374151' : '#e5e7eb'}`,
              borderRadius: 8,
              color: isDarkMode ? '#f3f4f6' : '#111827',
            }}
            labelStyle={{ color: isDarkMode ? '#f3f4f6' : '#111827' }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke={theme.PRIMARY}
            strokeWidth={2}
            fill="url(#commitTimelineFill)"
          />
          {deadlineDay && (
            <ReferenceLine
              x={deadlineDay}
              stroke="#dc2626"
              strokeDasharray="4 4"
              label={{
                value: 'Deadline',
                position: 'top',
                fill: '#dc2626',
                fontSize: 12,
              }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default CommitTimeline;
