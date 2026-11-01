import { useState } from 'react';
import { formatPeriodLabel, formatWeekRange } from '~/utils/time';

export interface ChartPeriod {
  start: string;
  end: string;
  partial: boolean;
}

/** Round tick step: 1, 2, 5 × 10ⁿ, giving 3–5 ticks up to `max`. */
const niceTicks = (max: number): number[] => {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * pow).find(s => raw <= s) ?? pow * 10;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
};

/**
 * One series over calendar periods: area + line with a labelled y-axis, the
 * current (partial) period drawn dashed and called out, and an exact value
 * plus its full date range on hover or keyboard focus.
 */
export const TimeChart = ({
  periods,
  values,
  unit,
  noun,
  height = 220,
}: {
  periods: ChartPeriod[];
  values: number[];
  unit: 'day' | 'week';
  noun: string;
  height?: number;
}) => {
  const W = 960;
  const H = height;
  const PAD = { top: 18, right: 14, bottom: 26, left: 40 };
  const ticks = niceTicks(Math.max(...values, 0));
  const top = ticks[ticks.length - 1] || 1;
  const n = values.length;
  const innerW = W - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top);
  const base = H - PAD.bottom;
  const [hover, setHover] = useState<number | null>(null);

  const lastFull = periods[n - 1]?.partial ? n - 2 : n - 1;
  const solid = values.slice(0, Math.max(1, lastFull + 1)).map((v, i) => `${x(i)},${y(v)}`);
  const area = `${PAD.left},${base} ${solid.join(' ')} ${x(Math.max(0, lastFull))},${base}`;

  const label = (i: number) =>
    unit === 'week'
      ? formatWeekRange(periods[i].start, periods[i].end)
      : formatPeriodLabel(periods[i].start);
  const midIdx = Math.floor((n - 1) / 2);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full block"
        style={{ height: H }}
        role="img"
        aria-label={`${noun} per ${unit}: ${values.join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD.left) / innerW) * (n - 1));
          setHover(Math.min(n - 1, Math.max(0, i)));
        }}
      >
        {ticks.map(t => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? 'var(--line-strong)' : 'var(--line)'}
            />
            <text x={PAD.left - 8} y={y(t) + 4} fontSize={11} fill="var(--ink-4)" textAnchor="end">
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        <polygon points={area} fill="var(--accent)" opacity={0.1} />
        <polyline
          points={solid.join(' ')}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {lastFull === n - 2 && n >= 2 ? (
          <>
            <line
              x1={x(n - 2)}
              y1={y(values[n - 2])}
              x2={x(n - 1)}
              y2={y(values[n - 1])}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="4 4"
            />
            <circle
              cx={x(n - 1)}
              cy={y(values[n - 1])}
              r={3.5}
              fill="var(--panel)"
              stroke="var(--accent)"
              strokeWidth={2}
            />
            <text
              x={x(n - 1) - 6}
              y={y(values[n - 1]) - 8}
              fontSize={11}
              fill="var(--ink-3)"
              textAnchor="end"
            >
              {values[n - 1].toLocaleString()} so far
            </text>
          </>
        ) : null}
        {hover !== null ? (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={base}
              stroke="var(--ink-3)"
              strokeDasharray="3 3"
            />
            <circle
              cx={x(hover)}
              cy={y(values[hover])}
              r={4.5}
              fill="var(--accent)"
              stroke="var(--panel)"
              strokeWidth={2}
            />
          </>
        ) : null}
        {n > 0 ? (
          <>
            <text x={PAD.left} y={H - 6} fontSize={11} fill="var(--ink-3)">
              {formatPeriodLabel(periods[0].start)}
            </text>
            {n > 4 ? (
              <text x={x(midIdx)} y={H - 6} fontSize={11} fill="var(--ink-3)" textAnchor="middle">
                {formatPeriodLabel(periods[midIdx].start)}
              </text>
            ) : null}
            <text x={W - PAD.right} y={H - 6} fontSize={11} fill="var(--ink-3)" textAnchor="end">
              {unit === 'week' ? 'this week' : 'today'}
            </text>
          </>
        ) : null}
      </svg>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-0 rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-sm"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: x(hover) > W / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          <div className="font-medium text-ink-0">
            {label(hover)}
            {periods[hover].partial ? ' (so far)' : ''}
          </div>
          <div className="text-ink-2 tabular-nums">
            {values[hover].toLocaleString()} {noun}
          </div>
        </div>
      ) : null}
      {/* Values for keyboard and screen-reader users, without hovering. */}
      <details className="mt-1 text-xs text-ink-3">
        <summary className="cursor-pointer select-none">Show values</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="text-xs">
            <tbody>
              {periods.map((p, i) => (
                <tr key={p.start}>
                  <td className="pr-4 py-0.5 text-ink-2">
                    {label(i)}
                    {p.partial ? ' (so far)' : ''}
                  </td>
                  <td className="tabular-nums text-ink-0">{values[i].toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
};

/** A labelled horizontal bar: label, track, value. */
export const BarRow = ({
  label,
  value,
  max,
  detail,
  tone = 'ink',
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  detail: string;
  tone?: 'ink' | 'accent';
}) => (
  <li className="grid grid-cols-[10rem_1fr_7rem] items-center gap-3 text-sm">
    <span className="text-ink-1 truncate">{label}</span>
    <span
      className="h-2 rounded-full overflow-hidden"
      style={{ background: 'var(--bar-track)' }}
      aria-hidden
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${max > 0 ? Math.min(100, (100 * value) / max) : 0}%`,
          background: tone === 'accent' ? 'var(--accent)' : 'var(--ink-0)',
        }}
      />
    </span>
    <span className="text-xs text-ink-3 tabular-nums text-right">{detail}</span>
  </li>
);
