import type { ContributorRecord } from './GitHubStatsPanel';

const PALETTE = [
  '#6d5efc',
  '#8a7afd',
  '#a89cff',
  '#c8c0ff',
  '#5a4cf0',
  '#4a3fbb',
  '#f59e0b',
  '#16a34a',
  '#06b6d4',
  '#ec4899',
];

export interface ContributorPiesProps {
  contributors: ContributorRecord[];
}

interface Slice {
  label: string;
  value: number;
  color: string;
  pct: number;
}

function buildSlices(
  rows: Array<{ label: string; value: number }>,
): Slice[] {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return [];
  return rows
    .filter((r) => r.value > 0)
    .map((r, i) => ({
      label: r.label,
      value: r.value,
      color: PALETTE[i % PALETTE.length],
      pct: (r.value / total) * 100,
    }))
    .sort((a, b) => b.value - a.value);
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = {
    x: cx + r * Math.cos(startAngle),
    y: cy + r * Math.sin(startAngle),
  };
  const end = {
    x: cx + r * Math.cos(endAngle),
    y: cy + r * Math.sin(endAngle),
  };
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
  ].join(' ');
}

function Donut({
  slices,
  testId,
}: {
  slices: Slice[];
  testId: string;
}) {
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const r = 55;
  const strokeWidth = 22;

  if (slices.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-gray-500 dark:text-gray-400"
        style={{ height: size }}
        data-testid={`${testId}-empty`}
      >
        No data
      </div>
    );
  }

  // Single-slice → render a full ring
  if (slices.length === 1) {
    return (
      <svg width={size} height={size} data-testid={testId}>
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={slices[0].color}
          strokeWidth={strokeWidth}
        />
      </svg>
    );
  }

  let cursor = -Math.PI / 2; // start at 12 o'clock
  const paths: React.ReactNode[] = [];
  for (const s of slices) {
    const sweep = (s.pct / 100) * Math.PI * 2;
    const end = cursor + sweep;
    const d = describeArc(cx, cy, r, cursor, end);
    paths.push(
      <path
        key={s.label}
        d={d}
        fill="none"
        stroke={s.color}
        strokeWidth={strokeWidth}
      />,
    );
    cursor = end;
  }

  return (
    <svg width={size} height={size} data-testid={testId}>
      {paths}
    </svg>
  );
}

function Legend({ slices }: { slices: Slice[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-700 dark:text-gray-200 justify-center mt-2">
      {slices.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: s.color }}
          />
          <span className="font-medium">{s.label}</span>
          <span className="text-gray-400 dark:text-gray-500">
            {s.pct.toFixed(1)}%
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Side-by-side donuts: commit share and lines-changed share by contributor.
 */
const ContributorPies = ({ contributors }: ContributorPiesProps) => {
  const commitSlices = buildSlices(
    contributors.map((c) => ({ label: c.login, value: c.commits })),
  );
  const lineSlices = buildSlices(
    contributors.map((c) => ({
      label: c.login,
      value: c.additions + c.deletions,
    })),
  );

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 gap-4"
      data-testid="contributor-pies"
    >
      <div className="flex flex-col items-center">
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Commits
        </div>
        <Donut slices={commitSlices} testId="pie-commits" />
        <Legend slices={commitSlices} />
      </div>
      <div className="flex flex-col items-center">
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Lines changed
        </div>
        <Donut slices={lineSlices} testId="pie-lines" />
        <Legend slices={lineSlices} />
      </div>
    </div>
  );
};

export default ContributorPies;
