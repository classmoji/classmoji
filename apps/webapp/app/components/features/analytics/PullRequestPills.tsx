import type { PRSummary } from './GitHubStatsPanel';

export interface PullRequestPillsProps {
  pr_summary: PRSummary;
}

type Tone = 'green' | 'violet' | 'gray';

function pillClasses(tone: Tone): string {
  switch (tone) {
    case 'green':
      return 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-200 dark:border-green-800/60';
    case 'violet':
      return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-200 dark:border-violet-800/60';
    case 'gray':
    default:
      return 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700';
  }
}

/**
 * Three capsule pills for PR summary. Counts of 0 are hidden.
 */
const PullRequestPills = ({ pr_summary }: PullRequestPillsProps) => {
  const items: Array<{ key: string; count: number; label: string; tone: Tone }> = [
    { key: 'open', count: pr_summary.open, label: 'open', tone: 'green' },
    { key: 'merged', count: pr_summary.merged, label: 'merged', tone: 'violet' },
    { key: 'closed', count: pr_summary.closed, label: 'closed', tone: 'gray' },
  ];

  const visible = items.filter(i => i.count > 0);
  if (visible.length === 0) {
    return (
      <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="pr-pills-empty">
        No pull requests.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" data-testid="pr-pills">
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 self-center mr-1">
        PRs
      </span>
      {visible.map(i => (
        <span
          key={i.key}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${pillClasses(
            i.tone
          )}`}
          data-testid={`pr-pill-${i.key}`}
        >
          <span className="tabular-nums">{i.count}</span>
          <span>{i.label}</span>
        </span>
      ))}
    </div>
  );
};

export default PullRequestPills;
