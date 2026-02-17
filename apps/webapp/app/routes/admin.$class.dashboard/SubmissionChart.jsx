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
import { useDarkMode } from '~/hooks';
import theme from '~/config/theme';

const SubmissionChart = ({ recentRepositoryAssignments }) => {
  const { isDarkMode } = useDarkMode();
  const lastDays = [];
  for (let i = 0; i < 10; i++) {
    lastDays.push(dayjs().subtract(i, 'day'));
  }

  const data = lastDays
    .map(day => ({
      name: day.format('MMM D'),
      count: recentRepositoryAssignments.filter(ra => dayjs(ra.closed_at).isSame(day, 'day')).length,
    }))
    .reverse();

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="text-gray-700 dark:text-gray-300 font-medium">{`${label}`}</p>
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
          fill={theme.PRIMARY}
          radius={[4, 4, 0, 0]}
          activeBar={<Rectangle fill={theme.PRIMARY_600} stroke={theme.PRIMARY_700} strokeWidth={1} />}
        />
      </BarChart>
    </ResponsiveContainer>
  );
};

export default SubmissionChart;
