import { useId } from 'react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import AnimatedCounter from './AnimatedCounter';
import { useDarkMode } from '~/hooks';

export interface KpiDelta {
  text: string;
  dir: 'up' | 'down';
}

interface KpiTileProps {
  label: string;
  value: number | string;
  suffix?: string;
  sub?: string;
  delta?: KpiDelta;
  series?: number[];
  format?: (n: number) => string;
}

// Recharts doesn't resolve `var(--accent)` in SVG attributes reliably, so the
// sparkline reads the live accent from `useDarkMode` and passes hex values.
const MiniSparkline = ({ values, accent }: { values: number[]; accent: string }) => {
  const data = values.map((v, i) => ({ i, v }));
  const gradientId = useId();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.4} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={accent}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

const KpiTile = ({ label, value, suffix, sub, delta, series, format }: KpiTileProps) => {
  const { accent } = useDarkMode();
  const deltaClasses =
    delta?.dir === 'up'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';

  return (
    <div className="relative overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-2 text-[28px] leading-none font-medium text-gray-900 dark:text-gray-100">
        <AnimatedCounter value={value} suffix={suffix} format={format} />
      </div>
      {(sub || delta) && (
        <div className="mt-1.5 text-[11.5px] text-gray-500 dark:text-gray-400">
          {sub}
          {delta && (
            <span
              className={`ml-1 inline-flex items-center gap-[3px] rounded px-[5px] py-[1px] text-[11px] font-semibold ${deltaClasses}`}
            >
              {delta.text}
            </span>
          )}
        </div>
      )}
      {series && series.length > 0 && (
        <div
          className="pointer-events-none absolute right-[14px] top-[14px] opacity-70"
          style={{ width: 72, height: 30 }}
        >
          <MiniSparkline values={series} accent={accent} />
        </div>
      )}
    </div>
  );
};

export default KpiTile;
