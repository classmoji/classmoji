import {
  BarChart,
  Bar,
  Rectangle,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { useDarkMode } from '~/hooks';

/**
 * Mix a hex color with white (positive `amt`) or black (negative). Used to
 * derive hover/active bar shades from the live accent without plumbing the
 * --accent-hover / --accent-ink CSS variables through Recharts (which
 * sanitizes its fill/stroke props and won't resolve `var(...)`).
 */
function mix(hex: string, amt: number): string {
  const v = hex.replace('#', '');
  if (v.length !== 6) return hex;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  const target = amt >= 0 ? 255 : 0;
  const k = Math.abs(amt);
  const to = (c: number) => Math.round(c + (target - c) * k);
  const hx = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hx(to(r))}${hx(to(g))}${hx(to(b))}`;
}

interface SubmissionChartProps {
  recentRepositoryAssignments: { closed_at?: string | Date }[];
}

const SubmissionChart = ({ recentRepositoryAssignments }: SubmissionChartProps) => {
  const { isDarkMode, accent } = useDarkMode();
  // Recharts sanitizes color values and doesn't resolve `var(--accent)` on
  // SVG attributes reliably, so resolve the accent at the React layer.
  const activeFill = useMemo(() => mix(accent, 0.15), [accent]);
  const activeStroke = useMemo(() => mix(accent, -0.25), [accent]);
  const lastDays = [];
  for (let i = 0; i < 10; i++) {
    lastDays.push(dayjs().subtract(i, 'day'));
  }

  const data = lastDays
    .map(day => ({
      name: day.format('MMM D'),
      count: recentRepositoryAssignments.filter(ra => dayjs(ra.closed_at).isSame(day, 'day'))
        .length,
    }))
    .reverse();

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: { value: number }[];
    label?: string;
  }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-panel dark:bg-panel border border-line dark:border-line rounded-lg shadow-lg p-3">
          <p className="text-ink-1 dark:text-ink-3 font-medium">{`${label}`}</p>
          <p className="text-primary-600 dark:text-primary-400 font-semibold">
            {`${payload[0].value} submission${payload[0].value !== 1 ? 's' : ''}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        width={500}
        height={300}
        data={data}
        margin={{
          top: 20,
          right: 40,
          left: 40,
          bottom: 20,
        }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? '#374151' : '#f0f0f0'} />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12, fill: isDarkMode ? '#9ca3af' : '#666' }}
          axisLine={{ stroke: isDarkMode ? '#4b5563' : '#e0e0e0' }}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 12, fill: isDarkMode ? '#9ca3af' : '#666' }}
          axisLine={{ stroke: isDarkMode ? '#4b5563' : '#e0e0e0' }}
          label={{
            value: 'Submissions',
            angle: -90,
            position: 'insideLeft',
            style: { textAnchor: 'middle', fill: isDarkMode ? '#9ca3af' : '#666' },
          }}
        />

        <Tooltip content={<CustomTooltip />} />
        <Bar
          dataKey="count"
          fill={accent}
          radius={[4, 4, 0, 0]}
          activeBar={
            <Rectangle fill={activeFill} stroke={activeStroke} strokeWidth={1} />
          }
        />
      </BarChart>
    </ResponsiveContainer>
  );
};

export default SubmissionChart;
