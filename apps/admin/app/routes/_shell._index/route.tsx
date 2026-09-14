import { Link, useLoaderData } from 'react-router';

import { formatHours } from '~/utils/dashboard';
import { loadDashboard, type DashboardData } from './route.server';

export const loader = loadDashboard;

export const meta = () => [{ title: 'Dashboard · Classmoji Admin' }];

// ───────── pieces ─────────

const Tile = ({ label, value, sub }: { label: string; value: number; sub?: React.ReactNode }) => (
  <div className="rounded-2xl bg-panel ring-1 ring-line px-4 py-3">
    <div className="text-[11px] uppercase tracking-wider text-ink-4">{label}</div>
    <div className="text-2xl font-semibold text-ink-0 tabular-nums leading-tight mt-1">
      {value.toLocaleString()}
    </div>
    {sub && <div className="text-xs text-ink-3 mt-0.5">{sub}</div>}
  </div>
);

/** "+3 vs previous 7 days", in words rather than color, so it reads in any theme. */
const Delta = ({ now, before }: { now: number; before: number }) => {
  const diff = now - before;
  const sign = diff > 0 ? '+' : '';
  return (
    <span>
      {sign}
      {diff} vs previous 7 days
    </span>
  );
};

const Card = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <h2 className="text-sm font-semibold text-ink-1">{title}</h2>
      {aside && <div className="text-xs text-ink-3">{aside}</div>}
    </div>
    {children}
  </section>
);

const Empty = ({ children }: { children: string }) => (
  <p className="text-sm text-ink-3 py-6 text-center">{children}</p>
);

const TH = ({ children, right }: { children?: string; right?: boolean }) => (
  <th className={`font-semibold py-2 ${right ? 'text-right pl-4' : 'pr-4'}`}>{children}</th>
);

const weekLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * One series of weekly counts as thin bars on a baseline. Single series, so
 * the card title is the legend; the current and peak weeks are labeled, every
 * bar carries a tooltip. Heights are relative to this chart's own max, which
 * is why signups and classrooms get separate charts rather than one axis.
 */
const WeeklyBars = ({ weeks, values }: { weeks: string[]; values: number[] }) => {
  const W = 480;
  const H = 96;
  const PAD_TOP = 18;
  const BASE = H - 16;
  const gap = 2;
  const barW = (W - gap * (values.length - 1)) / values.length;
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const last = values.length - 1;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-24"
      role="img"
      aria-label={`Weekly counts for the last ${values.length} weeks`}
    >
      <line x1={0} x2={W} y1={BASE} y2={BASE} stroke="var(--line)" strokeWidth={1} />
      {values.map((v, i) => {
        const h = v === 0 ? 0 : Math.max(2, ((BASE - PAD_TOP) * v) / max);
        const x = i * (barW + gap);
        const y = BASE - h;
        const r = Math.min(4, barW / 2, h);
        // Rounded at the data end only; square on the baseline.
        const d =
          h === 0
            ? ''
            : `M${x},${BASE} V${y + r} a${r},${r} 0 0 1 ${r},-${r} H${x + barW - r} a${r},${r} 0 0 1 ${r},${r} V${BASE} Z`;
        const labeled = (i === last || i === peak) && v > 0;
        return (
          <g key={weeks[i]}>
            <title>{`Week of ${weekLabel(weeks[i])}: ${v}`}</title>
            {/* Hit target wider than the bar. */}
            <rect x={x - gap / 2} y={0} width={barW + gap} height={H} fill="transparent" />
            {d && <path d={d} fill="var(--accent)" opacity={i === last ? 1 : 0.7} />}
            {labeled && (
              <text
                x={x + barW / 2}
                y={y - 5}
                textAnchor="middle"
                fontSize={11}
                fill="var(--ink-2)"
                className="tabular-nums"
              >
                {v}
              </text>
            )}
          </g>
        );
      })}
      <text x={0} y={H - 3} fontSize={10} fill="var(--ink-4)">
        {weekLabel(weeks[0])}
      </text>
      <text x={W} y={H - 3} fontSize={10} fill="var(--ink-4)" textAnchor="end">
        this week
      </text>
    </svg>
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
  <li className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-sm">
    <span className="text-ink-1 truncate">{label}</span>
    <span
      className="h-2 rounded-full bg-line overflow-hidden"
      role="img"
      aria-label={`${label}: ${detail}`}
    >
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${max > 0 ? (100 * value) / max : 0}%` }}
      />
    </span>
    <span className="text-xs text-ink-2 tabular-nums w-24 text-right">{detail}</span>
  </li>
);

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);

const initials = (u: { name: string | null; login: string | null }) =>
  (u.name ?? u.login ?? '?')
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

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
  const total30 = growth.signups.reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink-1">Dashboard</h1>
        <span className="text-xs text-ink-3">
          As of {new Date(data.generatedAt).toLocaleTimeString([], { timeStyle: 'short' })}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Tile label="Instructors" value={tiles.instructors} sub="own a real classroom" />
        <Tile label="Students" value={tiles.students} sub="enrolled somewhere" />
        <Tile
          label="Active classrooms"
          value={tiles.activeClassrooms}
          sub={`${tiles.archivedClassrooms} archived`}
        />
        <Tile
          label="Signups, 7 days"
          value={tiles.signups7d}
          sub={<Delta now={tiles.signups7d} before={tiles.signupsPrev7d} />}
        />
        <Tile label="Signups, 30 days" value={tiles.signups30d} />
        <Tile label="Active today" value={tiles.activeToday} sub="sessions in last 24h" />
      </div>

      <Card title="Growth" aside={`last ${growth.weeks.length} weeks · ${total30} signups`}>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium text-ink-2 mb-1">Signups per week</div>
            <WeeklyBars weeks={growth.weeks} values={growth.signups} />
          </div>
          <div>
            <div className="text-xs font-medium text-ink-2 mb-1">Classrooms created per week</div>
            <WeeklyBars weeks={growth.weeks} values={growth.classrooms} />
          </div>
        </div>
      </Card>

      <Card
        title="Feature usage"
        aside={`share of ${features.total} active classroom${features.total === 1 ? '' : 's'}`}
      >
        {features.total === 0 ? (
          <Empty>No active classrooms yet.</Empty>
        ) : (
          <ul className="grid gap-x-8 gap-y-2 md:grid-cols-2">
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
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Schools" aside="by account email domain">
          {schools.length === 0 ? (
            <Empty>No users with an email yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <TH>School</TH>
                  <TH>Country</TH>
                  <TH right>Users</TH>
                  <TH right>Instructors</TH>
                </tr>
              </thead>
              <tbody>
                {schools.map(s => (
                  <tr key={s.school} className="border-t border-line">
                    <td className="py-2 pr-4 text-ink-0 font-medium">{s.school}</td>
                    <td className="py-2 pr-4 text-ink-2 text-xs">{s.country}</td>
                    <td className="py-2 pl-4 text-right tabular-nums text-ink-1">{s.users}</td>
                    <td className="py-2 pl-4 text-right tabular-nums text-ink-1">
                      {s.instructors}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Countries" aside="from email TLD; .edu counts as US">
          {countries.length === 0 ? (
            <Empty>No school emails yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <TH>Country</TH>
                  <TH right>Users</TH>
                  <TH right>Instructors</TH>
                </tr>
              </thead>
              <tbody>
                {countries.map(c => (
                  <tr key={c.country} className="border-t border-line">
                    <td className="py-2 pr-4 text-ink-0 font-medium">{c.country}</td>
                    <td className="py-2 pl-4 text-right tabular-nums text-ink-1">{c.users}</td>
                    <td className="py-2 pl-4 text-right tabular-nums text-ink-1">
                      {c.instructors}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Onboarding" aside="how far people get, and how fast">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-4">
              Signup → first classroom
            </div>
            <div className="text-2xl font-semibold text-ink-0 tabular-nums mt-1">
              {formatHours(onboarding.hoursToFirstClassroom)}
            </div>
            <div className="text-xs text-ink-3">median, per instructor</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-4">
              Classroom → first assignment
            </div>
            <div className="text-2xl font-semibold text-ink-0 tabular-nums mt-1">
              {formatHours(onboarding.hoursToFirstAssignment)}
            </div>
            <div className="text-xs text-ink-3">median, per classroom</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-4">
              Students who finished joining
            </div>
            <div className="text-2xl font-semibold text-ink-0 tabular-nums mt-1">
              {pct(onboarding.studentsAccepted30d, onboarding.studentsAdded30d)}%
            </div>
            <div className="text-xs text-ink-3">
              {onboarding.studentsAccepted30d}/{onboarding.studentsAdded30d} added in 30 days
              accepted the Github invite · {onboarding.invitesPending} email invites unclaimed
              {onboarding.invitesStale > 0 ? ` (${onboarding.invitesStale} over a week old)` : ''}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-4">
              Instructors active
            </div>
            <div className="text-2xl font-semibold text-ink-0 tabular-nums mt-1">
              {pct(onboarding.instructorsActive14d, tiles.instructors)}%
            </div>
            <div className="text-xs text-ink-3">
              {onboarding.instructorsActive14d}/{tiles.instructors} signed in within 14 days
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="AI and quizzes"
        aside={`${ai.conversations7d} conversations in 7 days · ${ai.conversations30d} in 30 · ${ai.classroomsUsingAi30d} classroom${ai.classroomsUsingAi30d === 1 ? '' : 's'} using Ask Moji`}
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="text-xs font-medium text-ink-2 mb-1">
              Ask Moji conversations per week
            </div>
            <WeeklyBars weeks={growth.weeks} values={ai.conversations} />
          </div>
          <div>
            <div className="text-xs font-medium text-ink-2 mb-1">Quiz attempts per week</div>
            <WeeklyBars weeks={growth.weeks} values={ai.quizAttempts} />
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Class sizes" aside="active classrooms by students enrolled">
          <ul className="space-y-2">
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
        </Card>

        <Card title="Largest classes" aside="by students enrolled">
          {largestClasses.length === 0 ? (
            <Empty>No classrooms yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <TH>Class</TH>
                  <TH>Org</TH>
                  <TH right>Students</TH>
                </tr>
              </thead>
              <tbody>
                {largestClasses.map(c => (
                  <tr key={c.slug} className="border-t border-line row-hover">
                    <td className="py-2 pr-4 min-w-0">
                      <Link
                        to={`/classrooms/${encodeURIComponent(c.slug)}`}
                        className="text-ink-0 font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <div className="text-ink-3 text-xs truncate">{c.slug}</div>
                    </td>
                    <td className="py-2 pr-4 text-ink-2 text-xs">{c.org ?? '—'}</td>
                    <td className="py-2 pl-4 text-right tabular-nums text-ink-1">{c.students}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent signups">
          {recentUsers.length === 0 ? (
            <Empty>Nobody yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {recentUsers.map(u => (
                <li key={u.id} className="py-2 flex items-center gap-2.5 min-w-0">
                  {u.image ? (
                    <img src={u.image} alt="" className="w-7 h-7 rounded-full shrink-0" />
                  ) : (
                    <span className="w-7 h-7 rounded-full shrink-0 bg-accent-soft text-accent-ink grid place-items-center text-[11px] font-semibold">
                      {initials(u)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      to={u.login ? `/users?q=${encodeURIComponent(u.login)}` : '/users'}
                      className="text-ink-0 font-medium truncate block hover:underline"
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
        </Card>

        <Card title="Recent classrooms">
          {recentClassrooms.length === 0 ? (
            <Empty>No classrooms yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {recentClassrooms.map(c => (
                <li key={c.slug} className="py-2 flex items-center gap-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/classrooms/${encodeURIComponent(c.slug)}`}
                      className="text-ink-0 font-medium truncate block hover:underline"
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
        </Card>
      </div>
    </div>
  );
};

export default AdminDashboard;
