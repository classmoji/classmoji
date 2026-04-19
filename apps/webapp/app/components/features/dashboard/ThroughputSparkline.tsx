import { Card } from 'antd';
import dayjs from 'dayjs';
import { ResponsiveContainer, AreaChart, Area, Tooltip } from 'recharts';
import { CardHeader } from '~/components';

export interface ThroughputPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

interface ThroughputSparklineProps {
  data: ThroughputPoint[];
}

const ACCENT = '#8b5cf6';

interface TooltipPayloadItem {
  payload?: ThroughputPoint;
}

const SparkTooltip = ({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  if (!point) return null;
  return (
    <div className="rounded-md bg-gray-900/90 dark:bg-gray-100/90 px-2 py-1 text-[11px] text-white dark:text-gray-900 shadow">
      <div className="font-semibold tabular-nums">{point.count} graded</div>
      <div className="opacity-80">{dayjs(point.date).format('ddd MMM D')}</div>
    </div>
  );
};

const ThroughputSparkline = ({ data }: ThroughputSparklineProps) => {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  return (
    <Card className="h-full" data-testid="throughput-sparkline">
      <CardHeader>Throughput (7d)</CardHeader>
      <div className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
        {total}
      </div>
      <div style={{ height: 60 }} className="mt-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip content={<SparkTooltip />} cursor={{ stroke: ACCENT, strokeOpacity: 0.3 }} />
            <Area
              type="monotone"
              dataKey="count"
              stroke={ACCENT}
              strokeWidth={2}
              fill="url(#throughputFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
};

export default ThroughputSparkline;
