import { Button, Card, Empty, Tag } from 'antd';
import dayjs from 'dayjs';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'view_repo_health',
  });

  const health = await ClassmojiService.repoAnalytics.classroomRepoHealth(
    classroom.id,
  );

  return { classSlug, health };
};

const PALETTE = [
  '#6d5efc',
  '#8a7afd',
  '#a89cff',
  '#5a4cf0',
  '#f59e0b',
  '#16a34a',
  '#06b6d4',
  '#ec4899',
];

function LanguageBar({ langs }: { langs: Record<string, number> }) {
  const entries = Object.entries(langs);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">—</span>;
  }
  const items = entries
    .map(([name, bytes], i) => ({
      name,
      pct: (bytes / total) * 100,
      color: PALETTE[i % PALETTE.length],
    }))
    .sort((a, b) => b.pct - a.pct);
  return (
    <div className="flex flex-col gap-1 min-w-[160px]">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        {items.map((l) => (
          <div
            key={l.name}
            title={`${l.name} · ${l.pct.toFixed(1)}%`}
            style={{ width: `${l.pct}%`, backgroundColor: l.color }}
          />
        ))}
      </div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
        {items
          .slice(0, 3)
          .map((l) => `${l.name} ${l.pct.toFixed(0)}%`)
          .join(' · ')}
      </div>
    </div>
  );
}

const RepoHealth = ({ loaderData }: Route.ComponentProps) => {
  const { health } = loaderData;
  const { repos, unmatched, nextScheduledAt, autoRefreshEvery } = health;

  return (
    <div className="flex flex-col gap-4" data-testid="repo-health">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Repo Health
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Schedule card */}
        <Card
          className="lg:col-span-1 border border-gray-100 dark:border-gray-700"
          data-testid="schedule-card"
        >
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
            Snapshot schedule
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-gray-500 dark:text-gray-400">Auto refresh</dt>
              <dd className="font-medium text-gray-900 dark:text-gray-100">
                every {autoRefreshEvery}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500 dark:text-gray-400">Next run</dt>
              <dd
                className="font-medium text-gray-900 dark:text-gray-100"
                title={new Date(nextScheduledAt).toLocaleString()}
              >
                {dayjs(nextScheduledAt).fromNow()}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500 dark:text-gray-400">
                Refresh on deadline
              </dt>
              <dd>
                <Tag color="success" className="dark:border-green-800">
                  enabled
                </Tag>
              </dd>
            </div>
          </dl>
        </Card>

        {/* Unmatched contributors */}
        <Card
          className="lg:col-span-2 border border-gray-100 dark:border-gray-700"
          data-testid="unmatched-card"
        >
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
            Unmatched contributors
          </div>
          {unmatched.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-3">
              Everyone is linked.
            </div>
          ) : (
            <div className="rounded-lg border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 max-h-80 overflow-y-auto">
              {unmatched.map((u) => (
                <div
                  key={`${u.repo}-${u.login}`}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                  data-testid={`unmatched-${u.login}-${u.repo}`}
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100 truncate">
                      @{u.login}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {u.repo} · {u.commits} commit
                      {u.commits === 1 ? '' : 's'} · first seen{' '}
                      {dayjs(u.firstSeen).fromNow()}
                    </div>
                  </div>
                  <Button size="small" disabled title="Coming soon">
                    Match…
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Repos table */}
      <Card
        className="border border-gray-100 dark:border-gray-700"
        data-testid="repos-card"
      >
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-3">
          Repositories ({repos.length})
        </div>
        {repos.length === 0 ? (
          <Empty
            description={
              <span className="text-gray-500 dark:text-gray-400">
                No repository snapshots yet.
              </span>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-4 font-semibold">Repo</th>
                  <th className="py-2 pr-4 font-semibold">Languages</th>
                  <th className="py-2 pr-4 font-semibold text-right">Commits</th>
                  <th className="py-2 pr-4 font-semibold">Fetched</th>
                  <th className="py-2 pr-4 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((r) => (
                  <tr
                    key={r.name}
                    className="border-b border-gray-50 dark:border-gray-800 last:border-0"
                    data-testid={`repo-row-${r.name}`}
                  >
                    <td className="py-3 pr-4 font-mono text-xs text-gray-800 dark:text-gray-100">
                      {r.name}
                    </td>
                    <td className="py-3 pr-4">
                      <LanguageBar langs={r.langs} />
                    </td>
                    <td className="py-3 pr-4 text-right tabular-nums text-gray-700 dark:text-gray-200">
                      {r.commits.toLocaleString()}
                    </td>
                    <td
                      className="py-3 pr-4 text-gray-600 dark:text-gray-300"
                      title={new Date(r.fetchedAt).toLocaleString()}
                    >
                      {dayjs(r.fetchedAt).fromNow()}
                    </td>
                    <td className="py-3 pr-4">
                      {r.status === 'fresh' ? (
                        <Tag color="success" className="dark:border-green-800">
                          fresh
                        </Tag>
                      ) : (
                        <Tag color="warning" className="dark:border-amber-800">
                          stale
                        </Tag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default RepoHealth;
