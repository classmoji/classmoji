import { Suspense } from 'react';
import { Await, Link, useLoaderData } from 'react-router';
import { Avatar, Empty, InfoTip, Panel, Sparkline } from '~/components/ui';
import { InsightsSections } from '~/components/InsightsSections';
import { relativeTime } from '~/utils/time';
import type { Kpi } from '~/utils/metrics.server';
import { loadHome, type HomeData } from './route.server';

export const loader = loadHome;

export const meta = () => [{ title: 'Home · Classmoji Admin' }];

const Change = ({ kpi }: { kpi: Kpi }) => {
  if (kpi.previousToDate === null) return null;
  const diff = kpi.value - kpi.previousToDate;
  if (diff === 0)
    return <span className="text-[11px] font-semibold text-ink-3">same as last wk</span>;
  return (
    <span
      className={`text-[11px] font-semibold ${diff > 0 ? 'text-mint-ink' : 'text-rose-ink'}`}
      title={`Last week by this point: ${kpi.previousToDate.toLocaleString()}`}
    >
      {diff > 0 ? '+' : '−'}
      {Math.abs(diff).toLocaleString()} vs last wk
    </span>
  );
};

const KpiTile = ({ kpi }: { kpi: Kpi }) => (
  <div className="rounded-xl border border-line bg-panel px-3.5 py-3 min-w-0 flex flex-col">
    <div className="flex items-center justify-between gap-1 text-xs text-ink-3">
      <span className="truncate">{kpi.label}</span>
      <InfoTip text={kpi.definition} />
    </div>
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
      <span className="text-xl font-semibold text-ink-0 tabular-nums">
        {kpi.value.toLocaleString()}
      </span>
      <Change kpi={kpi} />
    </div>
    {kpi.series ? (
      <Sparkline
        values={kpi.series}
        label={`${kpi.label} per week, last ${kpi.series.length} weeks: ${kpi.series.join(', ')}`}
      />
    ) : (
      <div className="text-xs text-ink-3 mt-1.5">{kpi.sub || 'this week'}</div>
    )}
  </div>
);

const KpiPlaceholders = () => (
  <>
    {Array.from({ length: 6 }, (_, i) => (
      <div
        key={i}
        aria-hidden
        className="rounded-xl border border-line bg-panel px-3.5 py-3 h-[104px] animate-pulse"
      />
    ))}
  </>
);

const Activity = ({ entries }: { entries: HomeData['activity'] }) => (
  <Panel
    title="Latest activity"
    description="First sign-ins, new classrooms, admin actions, feedback"
    aside={
      <Link to="/ops/activity" className="text-xs text-ink-3 hover:text-ink-1">
        Admin log →
      </Link>
    }
  >
    {entries.length === 0 ? (
      <Empty title="Nothing yet" />
    ) : (
      <ul>
        {entries.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className="flex items-center gap-2.5 px-4 py-2 border-t border-line text-sm min-w-0"
          >
            <Avatar name={e.actor.name} size={22} />
            <span className="min-w-0 flex-1 truncate text-ink-1">
              {e.actor.id ? (
                <Link
                  to={`/people/${e.actor.id}`}
                  className="font-semibold text-ink-0 hover:underline"
                >
                  {e.actor.name}
                </Link>
              ) : (
                <b className="font-semibold text-ink-0">{e.actor.name}</b>
              )}{' '}
              {e.href ? (
                <Link to={e.href} className="hover:underline">
                  {e.text}
                </Link>
              ) : (
                e.text
              )}
            </span>
            <span className="text-xs text-ink-4 tabular-nums whitespace-nowrap">
              {relativeTime(e.at)}
            </span>
          </li>
        ))}
      </ul>
    )}
  </Panel>
);

const Home = () => {
  const data = useLoaderData<typeof loader>();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mt-2">
        <h1 className="text-lg font-semibold text-ink-1">Home</h1>
        <span className="text-xs text-ink-3">
          Updated {new Date(data.generatedAt).toLocaleTimeString([], { timeStyle: 'short' })} ·
          weeks start Monday, {data.timeZone.replace('_', ' ')}
        </span>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {/* Streamed: the slowest queries on the page (route.server.ts). */}
        <Suspense fallback={<KpiPlaceholders />}>
          <Await
            resolve={data.kpis}
            errorElement={
              <div className="col-span-full text-xs text-ink-3">
                {"The weekly numbers couldn't load. Reload to try again."}
              </div>
            }
          >
            {kpis => kpis.map(k => <KpiTile key={k.key} kpi={k} />)}
          </Await>
        </Suspense>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start">
        <InsightsSections
          range={data.range}
          growth={data.growth}
          activation={data.activation}
          adoption={data.adoption}
          audience={data.audience}
        />
        <div className="xl:sticky xl:top-4">
          <Activity entries={data.activity} />
        </div>
      </div>
    </div>
  );
};

export default Home;
