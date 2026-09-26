import { useMemo, useState } from 'react';
import { Link, useLoaderData } from 'react-router';
import { IconTrendingDown, IconTrendingUp } from '@tabler/icons-react';

import { formatHours } from '~/utils/dashboard';
import { loadDashboard, type DashboardData } from './route.server';

export const loader = loadDashboard;

export const meta = () => [{ title: 'Dashboard · Classmoji Admin' }];

// ───────── primitives ─────────

/** Bordered surface every block sits in. */
const Panel = ({ className = '', children }: { className?: string; children: React.ReactNode }) => (
  <section className={`rounded-xl border border-line bg-panel ${className}`}>{children}</section>
);

const PanelHeader = ({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
}) => (
  <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
    <div>
      <h2 className="text-base font-semibold text-ink-0">{title}</h2>
      {description && <p className="text-sm text-ink-3 mt-0.5">{description}</p>}
    </div>
    {aside}
  </div>
);

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

/** Change against the previous period, as a signed percentage. Null when there was nothing before. */
const changePct = (now: number, before: number): number | null =>
  before === 0 ? (now === 0 ? 0 : null) : Math.round((100 * (now - before)) / before);

const TrendPill = ({ change }: { change: number | null }) => {
  if (change === null) return <span className="text-xs text-ink-3">new</span>;
  const Icon = change < 0 ? IconTrendingDown : IconTrendingUp;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-ink-1 tabular-nums">
      <Icon size={14} stroke={1.75} />
      {change > 0 ? '+' : ''}
      {change}%
    </span>
  );
};

/** The big-number card: label and pill up top, value, then a bold line and a muted one. */
const StatCard = ({
  label,
  value,
  pill,
  line,
  sub,
  trend,
}: {
  label: string;
  value: number | string;
  pill?: React.ReactNode;
  line: string;
  sub: string;
  trend?: 'up' | 'down';
}) => {
  const Icon = trend === 'down' ? IconTrendingDown : IconTrendingUp;
  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-3">{label}</span>
        {pill}
      </div>
      <div className="text-3xl font-semibold tracking-tight text-ink-0 tabular-nums mt-2">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-sm font-medium text-ink-0">
        {line}
        {trend && <Icon size={16} stroke={1.75} />}
      </div>
      <div className="text-sm text-ink-3 mt-0.5">{sub}</div>
    </Panel>
  );
};

/** Label, a proportional bar, and the number: one row of a horizontal bar list. */
const BarRow = ({
  label,
  value,
  max,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  detail: string;
}) => (
  <li className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
    <span className="text-ink-1 truncate">{label}</span>
    <span
      className="h-2 rounded-full bg-line overflow-hidden"
      role="img"
      aria-label={`${label}: ${detail}`}
    >
      <span
        className="block h-full rounded-full bg-ink-0"
        style={{ width: `${max > 0 ? (100 * value) / max : 0}%` }}
      />
    </span>
    <span className="text-xs text-ink-3 tabular-nums w-24 text-right">{detail}</span>
  </li>
);

const Segmented = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) => (
  <div className="inline-flex rounded-lg border border-line p-0.5 text-sm">
    {options.map(o => (
      <button
        key={o.value}
        type="button"
        onClick={() => onChange(o.value)}
        aria-pressed={o.value === value}
        className={`rounded-md px-3 py-1 cursor-pointer transition-colors ${
          o.value === value ? 'bg-nav-hover text-ink-0 font-medium' : 'text-ink-2 hover:text-ink-0'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const NUMERIC_HEADS = new Set(['Users', 'Instructors', 'Students']);

const Table = ({ head, children }: { head: string[]; children: React.ReactNode }) => (
  <div className="mx-6 mb-6 overflow-hidden rounded-lg border border-line">
    <table className="w-full text-sm">
      <thead className="bg-nav-hover">
        <tr className="text-left text-xs text-ink-2">
          {head.map(h => (
            <th
              key={h}
              className={`font-medium py-2.5 px-4 ${NUMERIC_HEADS.has(h) ? 'text-right' : ''}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const Empty = ({ children }: { children: string }) => (
  <p className="px-6 pb-6 text-sm text-ink-3">{children}</p>
);

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ───────── charts ─────────

/** Points and paths for a single series across the plot width. */
const useAreaGeometry = (values: number[], W: number, H: number, pad: PadSpec) => {
  const max = Math.max(1, ...values);
  const n = values.length;
  const innerW = W - pad.left - pad.right;
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - v / max);
  const base = H - pad.bottom;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const area = n > 0 ? `${line} L${x(n - 1)},${base} L${x(0)},${base} Z` : '';
  return { max, n, x, y, base, line, area };
};

interface PadSpec {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type Range = '12w' | '30d' | '7d';
type Series = 'signups' | 'classrooms';

/**
 * Single-series area on a baseline, monochrome: ink line, flat low-opacity ink
 * fill, recessive gridlines, first/last date labels, and a crosshair tooltip
 * on hover. One series per view (the switcher picks it), so no legend.
 */
const AreaChart = ({ labels, values }: { labels: string[]; values: number[] }) => {
  const W = 960;
  const H = 260;
  const PAD = { top: 16, right: 12, bottom: 28, left: 12 };
  const [hover, setHover] = useState<number | null>(null);
  const { max, n, x, y, base, line, area } = useAreaGeometry(values, W, H, PAD);

  return (
    <div className="relative px-6 pb-6">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[260px]"
        role="img"
        aria-label="Trend over the selected range"
        onMouseLeave={() => setHover(null)}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (n - 1));
          setHover(Math.min(n - 1, Math.max(0, i)));
        }}
      >
        {[0.25, 0.5, 0.75].map(s => (
          <line
            key={s}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(max * s)}
            y2={y(max * s)}
            stroke="var(--line)"
            strokeDasharray="3 4"
          />
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} stroke="var(--line)" />
        <path d={area} fill="var(--ink-0)" opacity={0.08} />
        <path d={line} fill="none" stroke="var(--ink-0)" strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && (
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
              r={5}
              fill="var(--ink-0)"
              stroke="var(--panel)"
              strokeWidth={2}
            />
          </>
        )}
        <text x={PAD.left} y={H - 8} fontSize={12} fill="var(--ink-3)">
          {fmtDay(labels[0])}
        </text>
        <text x={W - PAD.right} y={H - 8} fontSize={12} fill="var(--ink-3)" textAnchor="end">
          {fmtDay(labels[n - 1])}
        </text>
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-4 rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-sm"
          style={{
            left: `calc(1.5rem + ${((x(hover) - PAD.left) / W) * 100}%)`,
            transform: x(hover) > W / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
          }}
        >
          <div className="font-medium text-ink-0">{fmtDay(labels[hover])}</div>
          <div className="text-ink-2 tabular-nums">{values[hover].toLocaleString()}</div>
        </div>
      )}
    </div>
  );
};

/** Compact area for a secondary series: same marks, no controls or hover. */
const MiniArea = ({ labels, values }: { labels: string[]; values: number[] }) => {
  const W = 480;
  const H = 120;
  const PAD = { top: 12, right: 8, bottom: 22, left: 8 };
  const { n, base, line, area } = useAreaGeometry(values, W, H, PAD);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-[120px] mt-1"
      role="img"
      aria-label={`${total} in the last ${n} weeks`}
    >
      <title>{`${total} in the last ${n} weeks`}</title>
      <line x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} stroke="var(--line)" />
      <path d={area} fill="var(--ink-0)" opacity={0.08} />
      <path d={line} fill="none" stroke="var(--ink-0)" strokeWidth={2} strokeLinejoin="round" />
      <text x={PAD.left} y={H - 6} fontSize={11} fill="var(--ink-3)">
        {fmtDay(labels[0])}
      </text>
      <text x={W - PAD.right} y={H - 6} fontSize={11} fill="var(--ink-3)" textAnchor="end">
        this week
      </text>
    </svg>
  );
};

const GrowthPanel = ({ growth }: { growth: DashboardData['growth'] }) => {
  const [range, setRange] = useState<Range>('12w');
  const [series, setSeries] = useState<Series>('signups');

  const { labels, values } = useMemo(() => {
    const weekly = series === 'signups' ? growth.signups : growth.classrooms;
    const daily = series === 'signups' ? growth.dailySignups : growth.dailyClassrooms;
    if (range === '12w') return { labels: growth.weeks, values: weekly };
    if (range === '30d') return { labels: growth.days, values: daily };
    return { labels: growth.days.slice(-7), values: daily.slice(-7) };
  }, [growth, range, series]);

  const total = values.reduce((a, b) => a + b, 0);
  const noun = series === 'signups' ? 'signups' : 'classrooms created';
  const span =
    range === '12w'
      ? 'the last 12 weeks'
      : range === '30d'
        ? 'the last 30 days'
        : 'the last 7 days';

  return (
    <Panel>
      <PanelHeader
        title={series === 'signups' ? 'Total signups' : 'Classrooms created'}
        description={`${total.toLocaleString()} ${noun} in ${span}`}
        aside={
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <Segmented
              value={series}
              onChange={setSeries}
              options={[
                { value: 'signups', label: 'Signups' },
                { value: 'classrooms', label: 'Classrooms' },
              ]}
            />
            <Segmented
              value={range}
              onChange={setRange}
              options={[
                { value: '12w', label: 'Last 12 weeks' },
                { value: '30d', label: 'Last 30 days' },
                { value: '7d', label: 'Last 7 days' },
              ]}
            />
          </div>
        }
      />
      <AreaChart labels={labels} values={values} />
    </Panel>
  );
};

const initials = (u: { name: string | null; login: string | null }) =>
  (u.name ?? u.login ?? '?')
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

const Metric = ({ label, value, sub }: { label: string; value: string; sub: string }) => (
  <div>
    <div className="text-sm text-ink-3">{label}</div>
    <div className="text-2xl font-semibold tracking-tight text-ink-0 tabular-nums mt-1">
      {value}
    </div>
    <div className="text-xs text-ink-3">{sub}</div>
  </div>
);

// ───────── page ─────────

const AdminDashboard = () => {
  const data = useLoaderData<DashboardData>();
  const {
    tiles,
    growth,
    schools,
    countries,
    classSizes,
    onboarding,
    ai,
    features,
    largestClasses,
    recentUsers,
    recentClassrooms,
  } = data;
  const maxSize = Math.max(...classSizes.map(b => b.count), 0);
  const activePct = pct(onboarding.instructorsActive14d, tiles.instructors);
  const acceptedPct = pct(onboarding.studentsAccepted30d, onboarding.studentsAdded30d);
  const weekChange = changePct(tiles.signups7d, tiles.signupsPrev7d);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink-0">Dashboard</h1>
        <span className="text-xs text-ink-3">
          As of {new Date(data.generatedAt).toLocaleTimeString([], { timeStyle: 'short' })}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Signups"
          value={tiles.signups30d}
          pill={<TrendPill change={changePct(tiles.signups30d, tiles.signupsPrev30d)} />}
          line={`${tiles.signups7d} in the last 7 days`}
          trend={weekChange !== null && weekChange < 0 ? 'down' : 'up'}
          sub={`Last 30 days · ${tiles.activeToday} active today`}
        />
        <StatCard
          label="Instructors"
          value={tiles.instructors}
          line={`${activePct}% active this fortnight`}
          trend={activePct >= 50 ? 'up' : 'down'}
          sub={`${onboarding.instructorsActive14d} signed in within 14 days`}
        />
        <StatCard
          label="Students"
          value={tiles.students}
          line={`${onboarding.studentsAdded30d} joined in the last 30 days`}
          trend={onboarding.studentsAdded30d > 0 ? 'up' : undefined}
          sub={`${acceptedPct}% of them accepted their invite`}
        />
        <StatCard
          label="Active classrooms"
          value={tiles.activeClassrooms}
          line={`${tiles.classroomsCreated30d} created in the last 30 days`}
          trend={tiles.classroomsCreated30d > 0 ? 'up' : undefined}
          sub={`${tiles.archivedClassrooms} archived`}
        />
      </div>

      <GrowthPanel growth={growth} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Feature usage"
            description={`Share of ${features.total} active classroom${features.total === 1 ? '' : 's'} with at least one of each`}
          />
          {features.total === 0 ? (
            <Empty>No active classrooms yet.</Empty>
          ) : (
            <ul className="px-6 pb-6 space-y-2.5">
              {features.rows.map(f => (
                <BarRow
                  key={f.key}
                  label={f.label}
                  value={f.count}
                  max={features.total}
                  detail={`${pct(f.count, features.total)}% · ${f.count}/${features.total}`}
                />
              ))}
            </ul>
          )}
        </Panel>

        <div className="grid gap-4">
          <Panel>
            <PanelHeader title="Onboarding" description="How far people get, and how fast" />
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-6 pb-6">
              <Metric
                label="Signup → first classroom"
                value={formatHours(onboarding.hoursToFirstClassroom)}
                sub="median per instructor"
              />
              <Metric
                label="Classroom → first assignment"
                value={formatHours(onboarding.hoursToFirstAssignment)}
                sub="median per classroom"
              />
              <Metric
                label="Students who finished joining"
                value={`${acceptedPct}%`}
                sub={`${onboarding.studentsAccepted30d} of ${onboarding.studentsAdded30d} added in 30 days`}
              />
              <Metric
                label="Email invites unclaimed"
                value={String(onboarding.invitesPending)}
                sub={`${onboarding.invitesStale} older than a week`}
              />
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Class sizes" description="Active classrooms by students enrolled" />
            <ul className="px-6 pb-6 space-y-2.5">
              {classSizes.map(b => (
                <BarRow
                  key={b.label}
                  label={`${b.label} students`}
                  value={b.count}
                  max={maxSize}
                  detail={`${b.count} class${b.count === 1 ? '' : 'es'}`}
                />
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <Panel>
        <PanelHeader
          title="AI and quizzes"
          description={`${ai.conversations7d} Ask Moji conversations in 7 days · ${ai.conversations30d} in 30 · ${ai.classroomsUsingAi30d} classroom${ai.classroomsUsingAi30d === 1 ? '' : 's'} using it`}
        />
        <div className="grid gap-4 md:grid-cols-2 px-6 pb-6">
          <div className="rounded-lg border border-line">
            <div className="px-4 pt-3 text-sm font-medium text-ink-0">Ask Moji conversations</div>
            <div className="px-4 text-xs text-ink-3">per week, last 12 weeks</div>
            <MiniArea labels={growth.weeks} values={ai.conversations} />
          </div>
          <div className="rounded-lg border border-line">
            <div className="px-4 pt-3 text-sm font-medium text-ink-0">Quiz attempts</div>
            <div className="px-4 text-xs text-ink-3">per week, last 12 weeks</div>
            <MiniArea labels={growth.weeks} values={ai.quizAttempts} />
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Schools"
            description="By account email domain; country from its TLD"
          />
          {schools.length === 0 ? (
            <Empty>No users with an email yet.</Empty>
          ) : (
            <Table head={['School', 'Country', 'Users', 'Instructors']}>
              {schools.map(s => (
                <tr key={s.school} className="border-t border-line">
                  <td className="py-2.5 px-4 text-ink-0 font-medium">{s.school}</td>
                  <td className="py-2.5 px-4 text-ink-2">{s.country}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink-1">{s.users}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink-1">
                    {s.instructors}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Countries" description=".edu counts as United States" />
          {countries.length === 0 ? (
            <Empty>No school emails yet.</Empty>
          ) : (
            <Table head={['Country', 'Users', 'Instructors']}>
              {countries.map(c => (
                <tr key={c.country} className="border-t border-line">
                  <td className="py-2.5 px-4 text-ink-0 font-medium">{c.country}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink-1">{c.users}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink-1">
                    {c.instructors}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Largest classes" description="By students enrolled" />
          {largestClasses.length === 0 ? (
            <Empty>No classrooms yet.</Empty>
          ) : (
            <Table head={['Class', 'Org', 'Students']}>
              {largestClasses.map(c => (
                <tr key={c.slug} className="border-t border-line row-hover">
                  <td className="py-2.5 px-4 min-w-0">
                    <Link
                      to={`/classrooms/${encodeURIComponent(c.slug)}`}
                      className="text-ink-0 font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <div className="text-ink-3 text-xs truncate">{c.slug}</div>
                  </td>
                  <td className="py-2.5 px-4 text-ink-2 text-xs">{c.org ?? '—'}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-ink-1">{c.students}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <div className="grid gap-4">
          <Panel>
            <PanelHeader title="Recent signups" />
            {recentUsers.length === 0 ? (
              <Empty>Nobody yet.</Empty>
            ) : (
              <ul className="px-6 pb-6 divide-y divide-line">
                {recentUsers.map(u => (
                  <li key={u.id} className="py-2.5 flex items-center gap-3 min-w-0">
                    {u.image ? (
                      <img src={u.image} alt="" className="w-8 h-8 rounded-full shrink-0" />
                    ) : (
                      <span className="w-8 h-8 rounded-full shrink-0 bg-nav-hover text-ink-1 grid place-items-center text-xs font-semibold">
                        {initials(u)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        to={u.login ? `/users?q=${encodeURIComponent(u.login)}` : '/users'}
                        className="text-sm text-ink-0 font-medium truncate block hover:underline"
                      >
                        {u.name ?? u.login ?? '—'}
                      </Link>
                      <div className="text-ink-3 text-xs truncate">
                        {u.login ? `@${u.login}` : u.id}
                      </div>
                    </div>
                    <span className="text-xs text-ink-3 tabular-nums shrink-0">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Recent classrooms" />
            {recentClassrooms.length === 0 ? (
              <Empty>No classrooms yet.</Empty>
            ) : (
              <ul className="px-6 pb-6 divide-y divide-line">
                {recentClassrooms.map(c => (
                  <li key={c.slug} className="py-2.5 flex items-center gap-3 min-w-0">
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/classrooms/${encodeURIComponent(c.slug)}`}
                        className="text-sm text-ink-0 font-medium truncate block hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-ink-3 text-xs truncate">
                        {c.slug}
                        {c.org ? ` · ${c.org}` : ''}
                      </div>
                    </div>
                    <span className="text-xs text-ink-3 tabular-nums shrink-0">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;
