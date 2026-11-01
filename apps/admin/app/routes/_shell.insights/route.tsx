import { useState } from 'react';
import { Link, useLoaderData, useSearchParams } from 'react-router';
import { Empty, InfoTip, Panel, withParams } from '~/components/ui';
import { BarRow, TimeChart } from '~/components/Chart';
import {
  formatHours,
  OTHER_DOMAINS_LABEL,
  PERSONAL_EMAIL_LABEL,
  UNKNOWN_COUNTRY,
} from '~/utils/dashboard';
import { GROWTH_DEFINITIONS, GROWTH_RANGES, type GrowthSeries } from '~/utils/metricDefinitions';
import { loadInsights, type InsightsView } from './route.server';

export const loader = loadInsights;

export const meta = () => [{ title: 'Insights · Classmoji Admin' }];

type Data = Awaited<ReturnType<typeof loadInsights>>;

const VIEW_LABELS: Record<InsightsView, string> = {
  growth: 'Growth',
  activation: 'Activation',
  adoption: 'Adoption',
  audience: 'Email domains',
};

const Segmented = ({
  param,
  value,
  options,
}: {
  param: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}) => {
  const [params] = useSearchParams();
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 text-sm bg-panel">
      {options.map(o => (
        <Link
          key={o.value}
          to={withParams(params, { [param]: o.value })}
          preventScrollReset
          aria-current={o.value === value ? 'true' : undefined}
          className={`rounded-md px-3 py-1 transition-colors ${
            o.value === value
              ? 'bg-nav-hover text-ink-0 font-medium'
              : 'text-ink-2 hover:text-ink-0'
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
};

const SERIES_LABELS: Record<GrowthSeries, { title: string; noun: string }> = {
  instructors: { title: 'New instructors', noun: 'new instructors' },
  signups: { title: 'First sign-ins', noun: 'first sign-ins' },
  classrooms: { title: 'Classrooms created', noun: 'classrooms' },
};

const Growth = ({ data }: { data: Extract<Data, { view: 'growth' }> }) => {
  const [series, setSeries] = useState<GrowthSeries>('instructors');
  const { growth } = data;
  const values = growth.series[series];
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          {SERIES_LABELS[series].title} per {growth.unit}
          <InfoTip text={GROWTH_DEFINITIONS[series]} />
        </span>
      }
      description={`${total.toLocaleString()} ${SERIES_LABELS[series].noun} in the last ${GROWTH_RANGES[data.range].label}`}
      aside={
        <div className="inline-flex rounded-lg border border-line p-0.5 text-sm">
          {(Object.keys(SERIES_LABELS) as GrowthSeries[]).map(s => (
            <button
              key={s}
              type="button"
              aria-pressed={s === series}
              onClick={() => setSeries(s)}
              className={`rounded-md px-3 py-1 ${
                s === series ? 'bg-nav-hover text-ink-0 font-medium' : 'text-ink-2 hover:text-ink-0'
              }`}
            >
              {SERIES_LABELS[s].title}
            </button>
          ))}
        </div>
      }
    >
      <div className="px-4 pb-4">
        <TimeChart
          periods={growth.periods}
          values={values}
          unit={growth.unit}
          noun={SERIES_LABELS[series].noun}
        />
      </div>
    </Panel>
  );
};

const days = (d: number | null) =>
  d === null ? '—' : d < 1 ? '<1 day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;

const Activation = ({ data }: { data: Extract<Data, { view: 'activation' }> }) => {
  const { funnel, times } = data;
  const top = Math.max(1, funnel.cohortSize);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
      <Panel
        title="Instructor activation"
        description={`Everyone whose first sign-in was since ${new Date(funnel.from).toLocaleDateString()} and who isn't only a student · n = ${funnel.cohortSize}`}
      >
        {funnel.cohortSize === 0 ? (
          <Empty title="No one in this cohort" hint="Pick a longer range." />
        ) : (
          <ul className="px-4 pb-4 space-y-2.5">
            {funnel.steps.map(s => (
              <BarRow
                key={s.label}
                label={s.label}
                value={s.count}
                max={top}
                tone="accent"
                detail={`${s.count} · ${s.pct ?? 0}%${s.medianDays !== null ? ` · ${days(s.medianDays)}` : ''}`}
              />
            ))}
            <li className="pt-2 text-xs text-ink-3">
              Day counts are the median time from first sign-in, among those who got there.
            </li>
          </ul>
        )}
      </Panel>
      <div className="grid gap-4">
        <Panel
          title={
            <span className="inline-flex items-center gap-1.5">
              Still active in week 4
              <InfoTip text="Used Classmoji themselves 21–27 days after their first sign-in. Only people who signed in at least 28 days ago count. History starts Oct 31, 2026." />
            </span>
          }
        >
          <div className="px-4 pb-4">
            <div className="text-2xl font-semibold text-ink-0 tabular-nums">
              {funnel.week4.pct === null ? '—' : `${funnel.week4.pct}%`}
            </div>
            <div className="text-xs text-ink-3">
              {funnel.week4.retained} of {funnel.week4.eligible} old enough to tell
            </div>
          </div>
        </Panel>
        <Panel
          title="Time to first steps"
          description="Last 180 days, with how many got there at all"
        >
          <div className="grid grid-cols-2 gap-4 px-4 pb-4">
            <div>
              <div className="text-xs text-ink-3">Sign-in → created a classroom</div>
              <div className="text-xl font-semibold text-ink-0 tabular-nums mt-0.5">
                {formatHours(times.signupToClassroom.medianHours)}
              </div>
              <div className="text-xs text-ink-3">
                median · {times.signupToClassroom.reached} of {times.signupToClassroom.total} (
                {times.signupToClassroom.pct ?? 0}%)
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-3">Classroom → first assignment</div>
              <div className="text-xl font-semibold text-ink-0 tabular-nums mt-0.5">
                {formatHours(times.classroomToAssignment.medianHours)}
              </div>
              <div className="text-xs text-ink-3">
                median · {times.classroomToAssignment.reached} of{' '}
                {times.classroomToAssignment.total} ({times.classroomToAssignment.pct ?? 0}%),
                classes 14+ days old
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
};

const MiniWeekly = ({
  title,
  periods,
  values,
  noun,
  note,
}: {
  title: string;
  periods: Extract<Data, { view: 'adoption' }>['ai']['periods'];
  values: number[];
  noun: string;
  note?: string;
}) => (
  <Panel title={title} description={note}>
    <div className="px-4 pb-3">
      <TimeChart periods={periods} values={values} unit="week" noun={noun} height={150} />
    </div>
  </Panel>
);

const Adoption = ({ data }: { data: Extract<Data, { view: 'adoption' }> }) => {
  const { adoption, ai, classSizes, largest } = data;
  const maxSize = Math.max(1, ...classSizes.map(b => b.count));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2 items-start">
        <Panel
          title="Used by students, last 30 days"
          description={`Share of ${adoption.total} active classrooms where students actually used each feature`}
        >
          {adoption.total === 0 ? (
            <Empty title="No active classrooms" />
          ) : (
            <ul className="px-4 pb-4 space-y-2.5">
              {adoption.rows.map(r => (
                <BarRow
                  key={r.key}
                  label={r.label}
                  value={r.used}
                  max={adoption.total}
                  detail={`${r.used} · ${Math.round((100 * r.used) / adoption.total)}%${r.setUp !== null ? ` · ${r.setUp} set up` : ''}`}
                />
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Class sizes" description="Active classrooms by accepted students">
          <ul className="px-4 pb-4 space-y-2.5">
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
      <div className="grid gap-4 xl:grid-cols-2">
        <MiniWeekly
          title="Ask Moji conversations per week"
          periods={ai.periods}
          values={ai.askMoji}
          noun="conversations"
          note="Ask Moji only (not quiz chats), never an impersonator's"
        />
        <MiniWeekly
          title="Quiz attempts completed per week"
          periods={ai.periods}
          values={ai.quizCompleted}
          noun="completed attempts"
          note={`Students only · ${ai.quizStarted.reduce((a, b) => a + b, 0)} started in 12 weeks · ${ai.staffPreviews} staff previews left out`}
        />
      </div>
      <Panel title="Largest active classes" description="Accepted students; pending shown apart">
        <div className="px-4 pb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                <th className="font-semibold py-2 pr-4">Class</th>
                <th className="font-semibold py-2 pr-4">Org</th>
                <th className="font-semibold py-2 pr-4 text-right">Students</th>
                <th className="font-semibold py-2 text-right">Pending</th>
              </tr>
            </thead>
            <tbody>
              {largest.map(c => (
                <tr key={c.slug} className="border-t border-line row-hover">
                  <td className="py-2 pr-4">
                    <Link
                      to={`/classrooms/${encodeURIComponent(c.slug)}`}
                      className="font-medium text-ink-0 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-xs text-ink-3 ml-2">{c.slug}</span>
                  </td>
                  <td className="py-2 pr-4 text-ink-2">{c.org ?? '—'}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{c.accepted}</td>
                  <td className="py-2 text-right tabular-nums text-ink-3">{c.pending || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
};

const Audience = ({ data }: { data: Extract<Data, { view: 'audience' }> }) => (
  <Panel
    title="Email domains"
    description={`${data.totalUsers.toLocaleString()} people who have signed in, by their email's domain. Country is a guess from the domain ending; .com/.org schools show as Unknown.`}
  >
    {data.domains.length === 0 ? (
      <Empty title="No emails yet" />
    ) : (
      <div className="px-4 pb-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
              <th className="font-semibold py-2 pr-4">Domain</th>
              <th className="font-semibold py-2 pr-4">Country (guess)</th>
              <th className="font-semibold py-2 pr-4 text-right">People</th>
              <th className="font-semibold py-2 text-right">Instructors</th>
            </tr>
          </thead>
          <tbody>
            {data.domains.map(d => {
              const special = d.school === PERSONAL_EMAIL_LABEL || d.school === OTHER_DOMAINS_LABEL;
              return (
                <tr key={d.school} className="border-t border-line">
                  <td className={`py-2 pr-4 ${special ? 'text-ink-3' : 'font-medium text-ink-0'}`}>
                    {special ? (
                      d.school
                    ) : (
                      <Link
                        to={`/people?q=${encodeURIComponent(`@${d.school}`)}`}
                        className="hover:underline"
                      >
                        {d.school}
                      </Link>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-ink-2">
                    {special || d.country === UNKNOWN_COUNTRY ? '—' : d.country}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{d.users.toLocaleString()}</td>
                  <td className="py-2 text-right tabular-nums">{d.instructors}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </Panel>
);

const Insights = () => {
  const data = useLoaderData<typeof loader>();
  const showRange = data.view === 'growth' || data.view === 'activation';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-ink-1">Insights</h1>
          <Segmented
            param="view"
            value={data.view}
            options={(Object.keys(VIEW_LABELS) as InsightsView[]).map(v => ({
              value: v,
              label: VIEW_LABELS[v],
            }))}
          />
        </div>
        {showRange ? (
          <Segmented
            param="range"
            value={data.range}
            options={Object.entries(GROWTH_RANGES).map(([value, r]) => ({ value, label: r.label }))}
          />
        ) : null}
      </div>
      {data.view === 'growth' ? <Growth data={data} /> : null}
      {data.view === 'activation' ? <Activation data={data} /> : null}
      {data.view === 'adoption' ? <Adoption data={data} /> : null}
      {data.view === 'audience' ? <Audience data={data} /> : null}
    </div>
  );
};

export default Insights;
