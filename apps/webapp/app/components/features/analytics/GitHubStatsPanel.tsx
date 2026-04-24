import { Card, Button, Alert, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatsCard from '~/components/shared/stats/StatsCard';
import CommitTimeline, { type CommitRecord } from './CommitTimeline';
import Anomalies from './Anomalies';
import ContributorBreakdown, {
  type EligibleStudent,
} from './ContributorBreakdown';
import HeuristicsChips from './HeuristicsChips';
import PullRequestPills from './PullRequestPills';

export type ContributorRecord = {
  login: string;
  user_id: string | null;
  commits: number;
  additions: number;
  deletions: number;
};

export type PRSummary = { open: number; merged: number; closed: number };

export type GitHubStatsSnapshot = {
  total_commits: number;
  total_additions: number;
  total_deletions: number;
  first_commit_at: string | null;
  last_commit_at: string | null;
  fetched_at: string;
  stale: boolean;
  error: string | null;
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  languages: Record<string, number>;
  pr_summary: PRSummary;
};

export interface GitHubStatsPanelProps {
  snapshot: GitHubStatsSnapshot | null;
  deadline: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Repository.id — forwarded to ContributorBreakdown for link-to-student. */
  repositoryId?: string;
  /** Classroom members eligible to be linked. */
  students?: EligibleStudent[];
  /** Focus percentage (0-100) from quiz focus tracking. Optional. */
  focusPct?: number | null;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function LanguageBar({ languages }: { languages: Record<string, number> }) {
  const entries = Object.entries(languages);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total <= 0) return null;

  const palette = [
    '#6d5efc',
    '#8a7afd',
    '#a89cff',
    '#c8c0ff',
    '#dedaff',
    '#5a4cf0',
    '#4a3fbb',
    '#3a3197',
  ];

  const withPct = entries
    .map(([name, bytes], i) => ({
      name,
      bytes,
      pct: (bytes / total) * 100,
      color: palette[i % palette.length],
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return (
    <div className="space-y-2" data-testid="language-breakdown">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">
        Languages
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        {withPct.map(l => (
          <div
            key={l.name}
            title={`${l.name} · ${l.pct.toFixed(1)}%`}
            style={{ width: `${l.pct}%`, backgroundColor: l.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        {withPct.map(l => (
          <span key={l.name} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: l.color }}
            />
            <span className="font-medium">{l.name}</span>
            <span className="text-gray-400 dark:text-gray-500">{l.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const GitHubStatsPanel = ({
  snapshot,
  deadline,
  onRefresh,
  refreshing = false,
  repositoryId,
  students,
  focusPct,
}: GitHubStatsPanelProps) => {
  if (!snapshot) {
    return (
      <Card
        className="border border-gray-100 dark:border-gray-700"
        data-testid="github-stats-panel-empty"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              GitHub Activity
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              No snapshot yet for this submission.
            </div>
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={onRefresh}
            disabled={!onRefresh}
            loading={refreshing}
          >
            Refresh
          </Button>
        </div>
      </Card>
    );
  }

  const {
    total_commits,
    total_additions,
    total_deletions,
    fetched_at,
    stale,
    error,
    commits,
    contributors,
    languages,
    pr_summary,
  } = snapshot;

  return (
    <Card
      className="border border-gray-100 dark:border-gray-700"
      data-testid="github-stats-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            GitHub Activity
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span data-testid="fetched-at">Updated {dayjs(fetched_at).fromNow()}</span>
            {stale && (
              <Tag color="warning" data-testid="stale-badge">
                Stale
              </Tag>
            )}
          </div>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={onRefresh}
          disabled={!onRefresh}
          loading={refreshing}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          className="mb-4"
          message="Failed to refresh analytics"
          description={error}
          data-testid="snapshot-error"
        />
      )}

      {/* Summary row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6" data-testid="summary-row">
        <StatsCard title="Commits">
          <span data-testid="stat-commits">{formatNumber(total_commits)}</span>
        </StatsCard>
        <StatsCard title="Lines Added">
          <span data-testid="stat-additions" className="text-green-600 dark:text-green-400">
            +{formatNumber(total_additions)}
          </span>
        </StatsCard>
        <StatsCard title="Lines Deleted">
          <span data-testid="stat-deletions" className="text-red-600 dark:text-red-400">
            -{formatNumber(total_deletions)}
          </span>
        </StatsCard>
        <StatsCard title="Contributors">
          <span data-testid="stat-contributors">{formatNumber(contributors.length)}</span>
        </StatsCard>
      </div>

      {/* Commit timeline */}
      <div className="mb-6">
        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold mb-2">
          Commit Timeline
        </div>
        <CommitTimeline commits={commits} deadline={deadline} />
      </div>

      <HeuristicsChips
        snapshot={{
          commits,
          contributors,
          total_additions,
          total_deletions,
        }}
        focusPct={focusPct ?? null}
      />

      <Anomalies
        snapshot={{
          commits,
          contributors,
          total_additions,
          total_deletions,
        }}
        deadline={deadline}
      />

      {/* Contributor breakdown (only when >1 contributor) */}
      {contributors.length > 1 && repositoryId && (
        <ContributorBreakdown
          commits={commits}
          contributors={contributors}
          unmatched={contributors
            .filter(c => !c.user_id)
            .map(c => ({ login: c.login, commits: c.commits }))}
          repositoryId={repositoryId}
          students={students ?? []}
        />
      )}

      {/* Language breakdown */}
      {Object.keys(languages).length > 0 && (
        <div className="mb-4">
          <LanguageBar languages={languages} />
        </div>
      )}

      {/* PR summary */}
      <div data-testid="pr-summary">
        <PullRequestPills pr_summary={pr_summary} />
      </div>
    </Card>
  );
};

export default GitHubStatsPanel;
