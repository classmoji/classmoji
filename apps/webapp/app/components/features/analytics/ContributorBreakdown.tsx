import { Button } from 'antd';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import {
  aggregateByContributor,
  commitsPerDayByContributor,
} from '@classmoji/services';
import { useDarkMode } from '~/hooks';
import type { CommitRecord } from './CommitTimeline';
import type { ContributorRecord } from './GitHubStatsPanel';

export interface ContributorBreakdownProps {
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  unmatched: Array<{ login: string; commits: number }>;
  onRequestLink?: (login: string) => void;
}

/**
 * Deterministic login → HSL color. Simple FNV-1a-ish string hash mod 360
 * so the same login always gets the same hue across renders.
 */
export function loginToColor(login: string): string {
  let hash = 2166136261;
  for (let i = 0; i < login.length; i++) {
    hash ^= login.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

const ContributorBreakdown = ({
  commits,
  contributors,
  unmatched,
  onRequestLink,
}: ContributorBreakdownProps) => {
  const { isDarkMode } = useDarkMode();

  if (!commits || commits.length === 0) return null;
  if (!contributors || contributors.length <= 1) return null;

  const byContrib = aggregateByContributor(commits);
  const perDay = commitsPerDayByContributor(commits);

  const logins = byContrib.map(c => c.login);
  const colorMap: Record<string, string> = Object.fromEntries(
    logins.map(l => [l, loginToColor(l)]),
  );

  const commitsPieData = byContrib.map(c => ({
    name: c.login,
    value: c.commits,
  }));
  const linesPieData = byContrib
    .map(c => ({
      name: c.login,
      value: c.additions + c.deletions,
    }))
    .filter(d => d.value > 0);

  const axisTick = { fontSize: 12, fill: isDarkMode ? '#9ca3af' : '#666' };
  const axisLine = { stroke: isDarkMode ? '#4b5563' : '#e0e0e0' };
  const tooltipStyle = {
    backgroundColor: isDarkMode ? '#111827' : '#ffffff',
    border: `1px solid ${isDarkMode ? '#374151' : '#e5e7eb'}`,
    borderRadius: 8,
    color: isDarkMode ? '#f3f4f6' : '#111827',
  };
  const tooltipLabel = { color: isDarkMode ? '#f3f4f6' : '#111827' };

  return (
    <div className="mb-6 space-y-6" data-testid="contributor-breakdown">
      {/* Pies */}
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Contribution Share
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div data-testid="commits-pie">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 text-center">
              Commits
            </div>
            <div style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={commitsPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={70}
                    label={entry =>
                      `${entry.name} ${((entry.percent ?? 0) * 100).toFixed(0)}%`
                    }
                  >
                    {commitsPieData.map(d => (
                      <Cell key={d.name} fill={colorMap[d.name]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} />
                  <Legend
                    wrapperStyle={{
                      fontSize: 12,
                      color: isDarkMode ? '#d1d5db' : '#374151',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div data-testid="lines-pie">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 text-center">
              Lines changed (added + deleted)
            </div>
            <div style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={linesPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={70}
                    label={entry =>
                      `${entry.name} ${((entry.percent ?? 0) * 100).toFixed(0)}%`
                    }
                  >
                    {linesPieData.map(d => (
                      <Cell key={d.name} fill={colorMap[d.name]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} />
                  <Legend
                    wrapperStyle={{
                      fontSize: 12,
                      color: isDarkMode ? '#d1d5db' : '#374151',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* Stacked bar of commits per day by contributor */}
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Commits per Day by Contributor
        </div>
        <div style={{ width: '100%', height: 220 }} data-testid="contributor-stacked-bar">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={perDay}
              margin={{ top: 12, right: 24, left: 0, bottom: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={isDarkMode ? '#374151' : '#f0f0f0'}
              />
              <XAxis dataKey="day" tick={axisTick} axisLine={axisLine} />
              <YAxis allowDecimals={false} tick={axisTick} axisLine={axisLine} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} />
              <Legend
                wrapperStyle={{
                  fontSize: 12,
                  color: isDarkMode ? '#d1d5db' : '#374151',
                }}
              />
              {logins.map(login => (
                <Bar
                  key={login}
                  dataKey={login}
                  stackId="commits"
                  fill={colorMap[login]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Unmatched contributors */}
      {unmatched.length > 0 && (
        <div data-testid="unmatched-contributors">
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
            Unmatched GitHub logins
          </div>
          <div className="rounded-lg border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
            {unmatched.map(u => (
              <div
                key={u.login}
                className="flex items-center justify-between px-3 py-2 text-sm"
                data-testid={`unmatched-row-${u.login}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: loginToColor(u.login) }}
                  />
                  <span className="font-medium text-gray-800 dark:text-gray-100">
                    {u.login}
                  </span>
                  <span className="text-gray-500 dark:text-gray-400">
                    · {u.commits} commit{u.commits === 1 ? '' : 's'}
                  </span>
                </div>
                <Button
                  size="small"
                  onClick={() => onRequestLink?.(u.login)}
                  disabled={!onRequestLink}
                >
                  Link to student
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ContributorBreakdown;
