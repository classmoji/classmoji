import { useState } from 'react';
import { IconPeople } from '@classmoji/ui-components';
import { GradingStatCard } from './GradingStatCard';
import { GradingQueueRow, type GradingQueueItem } from './GradingQueueRow';
import {
  GitHubStatsPanel,
  type GitHubStatsSnapshot,
} from '~/components/features/analytics';

export interface GradingStats {
  graded: number;
  pending: number;
  regrade: number;
  /** Rounded percent (0-100) or null when no data. */
  focusAvg: number | null;
}

export interface SubmissionAnalyticsEntry {
  deadline: string | null;
  snapshot: GitHubStatsSnapshot | null;
}

interface GradingScreenProps {
  stats: GradingStats;
  queue: GradingQueueItem[];
  /** Per-submission analytics keyed by repository_assignment_id. */
  analytics?: Record<string, SubmissionAnalyticsEntry>;
  /**
   * Trigger a refresh for a given repository_assignment_id. When provided,
   * the detail panel will show a working Refresh button.
   */
  onRefreshSubmission?: (repositoryAssignmentId: string) => void;
  /** Repository-assignment id currently being refreshed, if any. */
  refreshingSubmissionId?: string | null;
  onOpenSubmission?: (id: string) => void;
}

export function GradingScreen({
  stats,
  queue,
  analytics,
  onRefreshSubmission,
  refreshingSubmissionId,
  onOpenSubmission,
}: GradingScreenProps) {
  const focusValue = stats.focusAvg === null ? '—' : `${stats.focusAvg}%`;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleRowClick = (id: string) => {
    setSelectedId(prev => (prev === id ? null : id));
    onOpenSubmission?.(id);
  };

  const selected = selectedId ? (analytics?.[selectedId] ?? null) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1
          className="display"
          style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
        >
          Grading queue
        </h1>
        <span
          style={{
            padding: '4px 10px',
            background: 'var(--violet)',
            color: 'white',
            borderRadius: 99,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {stats.pending} pending
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn">
          <IconPeople size={14} /> Bulk actions
        </button>
      </div>

      {/* Progress overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <GradingStatCard label="Graded" value={stats.graded} color="oklch(55% 0.14 155)" />
        <GradingStatCard label="Pending" value={stats.pending} color="oklch(62% 0.19 285)" />
        <GradingStatCard label="Regrade" value={stats.regrade} color="oklch(62% 0.15 40)" />
        <GradingStatCard label="Focus avg" value={focusValue} color="var(--ink-1)" />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {queue.length === 0 ? (
          <div
            style={{
              padding: '28px 18px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            Nothing to grade right now.
          </div>
        ) : (
          queue.map((q, i) => (
            <GradingQueueRow
              key={q.id}
              item={q}
              last={i === queue.length - 1}
              onClick={handleRowClick}
              snapshot={analytics?.[q.id]?.snapshot ?? null}
              deadline={analytics?.[q.id]?.deadline ?? null}
            />
          ))
        )}
      </div>

      {/* Selected submission detail */}
      {selectedId && selected && (
        <div data-testid="submission-detail">
          <GitHubStatsPanel
            snapshot={selected.snapshot}
            deadline={selected.deadline}
            onRefresh={
              onRefreshSubmission
                ? () => onRefreshSubmission(selectedId)
                : undefined
            }
            refreshing={refreshingSubmissionId === selectedId}
          />
        </div>
      )}
    </div>
  );
}

export default GradingScreen;
