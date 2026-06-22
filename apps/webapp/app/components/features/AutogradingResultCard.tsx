import { Tag, Tooltip } from 'antd';

// Shared display for an autograding run, reused by the instructor roster table
// (compact pill) and the student's own repo page (full card). Classmoji shows
// the summary; the "View run" link opens GitHub Actions for the live logs.

export interface AutogradingResultData {
  conclusion: string; // 'success' | 'failure' | <job.status>
  total_tests?: number | null;
  passed_tests?: number | null;
  commit_sha?: string | null;
  run_id?: string | null;
  // Prisma stores this as JsonValue; narrowed at render time.
  details?: unknown;
  reported_at?: string | Date | null;
}

interface AutogradingResultCardProps {
  result?: AutogradingResultData | null;
  org?: string | null;
  repoName?: string | null;
  compact?: boolean;
  /**
   * Render without the outer card chrome (ring/background/padding). Used when the
   * card sits inside a container that already supplies a panel — e.g. the modal
   * opened from {@link AutogradingResultPill} — so it doesn't double-card.
   */
  embedded?: boolean;
}

function runUrl(org?: string | null, repoName?: string | null, runId?: string | null) {
  if (!org || !repoName || !runId) return null;
  return `https://github.com/${org}/${repoName}/actions/runs/${runId}`;
}

function shortSha(sha?: string | null) {
  return sha ? sha.slice(0, 7) : null;
}

function relativeTime(value?: string | Date | null) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function summary(result: AutogradingResultData) {
  const total = result.total_tests ?? 0;
  const passed = result.passed_tests ?? 0;
  const allPassed = total > 0 && passed === total;
  return {
    total,
    passed,
    color: allPassed ? 'green' : result.conclusion === 'success' ? 'green' : 'red',
    label: total > 0 ? `${passed}/${total}` : result.conclusion,
  };
}

const AutogradingResultCard = ({
  result,
  org,
  repoName,
  compact,
  embedded,
}: AutogradingResultCardProps) => {
  if (!result) {
    return compact ? (
      <span className="text-xs text-ink-4">—</span>
    ) : (
      <div className="text-sm text-ink-4">
        No autograding run yet. Push to your repo to run the tests.
      </div>
    );
  }

  const { color, label } = summary(result);
  const url = runUrl(org, repoName, result.run_id);

  // Compact pill for the instructor roster table.
  if (compact) {
    const pill = (
      <Tag color={color} className="font-semibold">
        {label}
      </Tag>
    );
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" className="no-underline">
        <Tooltip title="View run on GitHub">{pill}</Tooltip>
      </a>
    ) : (
      pill
    );
  }

  // Full card for the student's own repo page / the pill modal.
  const tests =
    result.details && typeof result.details === 'object'
      ? Object.values(result.details as Record<string, { name?: string; outcome?: string }>)
      : [];
  const sha = shortSha(result.commit_sha);
  const when = relativeTime(result.reported_at);
  const meta = [sha && `commit ${sha}`, when].filter(Boolean).join(' · ');
  const exactWhen = result.reported_at ? new Date(result.reported_at).toLocaleString() : undefined;

  return (
    <div
      className={
        embedded ? '' : 'rounded-xl ring-1 ring-line p-4 bg-white dark:bg-neutral-900'
      }
    >
      {/* Header: title + pass/fail tag. The "View run" link lives in the footer
          so it never collides with the modal's close button. */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-ink-1">Autograding</span>
        <Tag color={color} className="font-semibold">
          {label} passing
        </Tag>
      </div>
      {meta && (
        <p className="mt-1 text-xs text-ink-4" title={exactWhen}>
          {meta}
        </p>
      )}

      {tests.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {tests.map((test, i) => {
            const passed = test.outcome === 'success';
            return (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span
                  className={`shrink-0 ${passed ? 'text-green-600' : 'text-red-600'}`}
                  aria-hidden
                >
                  {passed ? '✓' : '✗'}
                </span>
                <span className="text-ink-2">{test.name ?? `Test ${i + 1}`}</span>
              </li>
            );
          })}
        </ul>
      )}

      {url && (
        <div className="mt-4 flex items-center justify-end">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            View run →
          </a>
        </div>
      )}
    </div>
  );
};

export default AutogradingResultCard;
