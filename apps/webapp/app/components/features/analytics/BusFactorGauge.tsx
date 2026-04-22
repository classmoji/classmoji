export interface BusFactorGaugeProps {
  /** Count of contributors holding ≥50% of commits combined. 1 = worst. */
  busFactor: number;
  totalContributors: number;
}

/**
 * Returns the arc path + color for a given bus factor.
 * Arc is a half circle: fraction 0→1 maps to 180° sweep from left to right.
 */
function gaugeArcPath(fraction: number): string {
  const cx = 60;
  const cy = 60;
  const r = 45;
  const clamped = Math.max(0.02, Math.min(1, fraction));
  const angle = Math.PI - clamped * Math.PI; // radians; 0→π
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  const largeArc = clamped > 0.5 ? 1 : 0;
  const startX = cx - r;
  const startY = cy;
  return `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y}`;
}

function toneFor(busFactor: number): { color: string; label: string } {
  if (busFactor <= 1) return { color: '#dc2626', label: 'Critical — one author' };
  if (busFactor === 2) return { color: '#f59e0b', label: 'Shared between two' };
  return { color: '#16a34a', label: 'Healthy distribution' };
}

const BusFactorGauge = ({ busFactor, totalContributors }: BusFactorGaugeProps) => {
  const hasData = totalContributors > 0;
  const clamped = hasData ? Math.max(1, Math.min(busFactor, totalContributors)) : 0;
  const fraction = hasData ? clamped / Math.max(totalContributors, 3) : 0;
  const { color, label } = toneFor(clamped);

  return (
    <div
      className="flex flex-col items-center justify-center"
      data-testid="bus-factor-gauge"
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
        Bus factor
      </div>
      <svg width={120} height={70} viewBox="0 0 120 70" role="img" aria-label="Bus factor gauge">
        {/* Background arc */}
        <path
          d={gaugeArcPath(1)}
          fill="none"
          stroke="currentColor"
          strokeWidth={10}
          strokeLinecap="round"
          className="text-gray-200 dark:text-gray-700"
        />
        {/* Tick marks at 1/3 and 2/3 */}
        {[1 / 3, 2 / 3].map((t) => {
          const angle = Math.PI - t * Math.PI;
          const r1 = 52;
          const r2 = 58;
          const cx = 60;
          const cy = 60;
          return (
            <line
              key={t}
              x1={cx + r1 * Math.cos(angle)}
              y1={cy - r1 * Math.sin(angle)}
              x2={cx + r2 * Math.cos(angle)}
              y2={cy - r2 * Math.sin(angle)}
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-gray-300 dark:text-gray-600"
            />
          );
        })}
        {/* Value arc */}
        {hasData && (
          <path
            d={gaugeArcPath(fraction)}
            fill="none"
            stroke={color}
            strokeWidth={10}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="text-3xl font-bold leading-none text-gray-900 dark:text-gray-100 mt-1 tabular-nums">
        {hasData ? clamped : '—'}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-center">
        {hasData ? label : 'No contributors yet'}
      </div>
    </div>
  );
};

export default BusFactorGauge;
