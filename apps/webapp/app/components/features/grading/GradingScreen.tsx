import { useMemo, useState } from 'react';
import { IconPeople } from '@classmoji/ui-components';
import {
  lateCommitRatio,
  busFactor,
  dumpAndRun,
} from '@classmoji/services/flags';
import { GradingStatCard } from './GradingStatCard';
import { GradingQueueRow, type GradingQueueItem } from './GradingQueueRow';
import EmojiGrader from './EmojiGrader';
import LateOverrideButton from '~/components/ui/buttons/LateOverrideButton';
import {
  GitHubStatsPanel,
  type GitHubStatsSnapshot,
  type EligibleStudent,
} from '~/components/features/analytics';

/**
 * Payload needed to grade + override from inside the queue detail panel.
 * Mirrors the props `EmojiGrader` / `LateOverrideButton` already expect.
 */
export interface SubmissionGradingInfo {
  repositoryAssignmentId: string;
  assignmentId: string;
  studentId: string | null;
  teamId: string | null;
  repoName: string | null;
  isLate: boolean;
  isLateOverride: boolean;
  grades: Array<{
    id: string;
    emoji: string;
    grader: { name: string | null } | null;
    token_transaction: { amount: number } | null;
  }>;
}

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
  /** Repository.id — forwarded to ContributorBreakdown for link-to-student. */
  repositoryId?: string;
}

interface GradingScreenProps {
  stats: GradingStats;
  queue: GradingQueueItem[];
  /** Per-submission analytics keyed by repository_assignment_id. */
  analytics?: Record<string, SubmissionAnalyticsEntry>;
  /** Per-submission grade-state keyed by repository_assignment_id. */
  grading?: Record<string, SubmissionGradingInfo>;
  /** Classroom emoji→grade map, passed to the inline EmojiGrader. */
  emojiMappings?: Record<string, unknown>;
  /**
   * Trigger a refresh for a given repository_assignment_id. When provided,
   * the detail panel will show a working Refresh button.
   */
  onRefreshSubmission?: (repositoryAssignmentId: string) => void;
  /** Repository-assignment id currently being refreshed, if any. */
  refreshingSubmissionId?: string | null;
  onOpenSubmission?: (id: string) => void;
  /** Classroom students eligible to be linked to unmatched contributors. */
  students?: EligibleStudent[];
}

type QueueFilter = 'all' | 'anomalies' | 'late' | 'clean';

interface QueueRowFlags {
  isLate: boolean;
  lateRatio: number;
  lateCommitCount: number;
  isDumpAndRun: boolean;
  busShare: number;
  busLogin: string | null;
  hasAnomaly: boolean;
  isClean: boolean;
}

function computeFlags(
  item: GradingQueueItem,
  entry: SubmissionAnalyticsEntry | undefined,
): QueueRowFlags {
  const isLate = (item.lateHours ?? 0) > 0;
  const snapshot = entry?.snapshot ?? null;
  const deadlineDate = entry?.deadline ? new Date(entry.deadline) : null;

  let lateRatio = 0;
  let lateCommitCount = 0;
  let isDumpAndRun = false;
  let busShare = 0;
  let busLogin: string | null = null;

  if (snapshot) {
    lateRatio = lateCommitRatio(snapshot.commits, deadlineDate);
    if (deadlineDate) {
      const deadlineMs = deadlineDate.getTime();
      for (const c of snapshot.commits) {
        const t = new Date(c.ts).getTime();
        if (!Number.isNaN(t) && t > deadlineMs) lateCommitCount += 1;
      }
    }
    isDumpAndRun = dumpAndRun(snapshot.commits, deadlineDate);
    const bf = busFactor(snapshot.contributors);
    if (bf) {
      busShare = bf.share;
      busLogin = bf.login;
    }
  }

  const hasAnomaly = lateRatio > 0.3 || isDumpAndRun || busShare > 0.7;
  const isClean = !isLate && !hasAnomaly;

  return {
    isLate,
    lateRatio,
    lateCommitCount,
    isDumpAndRun,
    busShare,
    busLogin,
    hasAnomaly,
    isClean,
  };
}

const FILTER_OPTIONS: Array<{ key: QueueFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'anomalies', label: 'Anomalies' },
  { key: 'late', label: 'Late' },
  { key: 'clean', label: 'Clean' },
];

export function GradingScreen({
  stats,
  queue,
  analytics,
  grading,
  emojiMappings,
  onRefreshSubmission,
  refreshingSubmissionId,
  onOpenSubmission,
  students,
}: GradingScreenProps) {
  const focusValue = stats.focusAvg === null ? '—' : `${stats.focusAvg}%`;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');

  const flagsById = useMemo(() => {
    const map = new Map<string, QueueRowFlags>();
    for (const q of queue) {
      map.set(q.id, computeFlags(q, analytics?.[q.id]));
    }
    return map;
  }, [queue, analytics]);

  const counts = useMemo(() => {
    let all = 0;
    let anomalies = 0;
    let late = 0;
    let clean = 0;
    for (const q of queue) {
      const f = flagsById.get(q.id);
      if (!f) continue;
      all += 1;
      if (f.hasAnomaly) anomalies += 1;
      if (f.isLate) late += 1;
      if (f.isClean) clean += 1;
    }
    return { all, anomalies, late, clean };
  }, [queue, flagsById]);

  const filteredQueue = useMemo(() => {
    const term = search.trim().toLowerCase();
    const base =
      filter === 'all'
        ? queue
        : queue.filter(q => {
            const f = flagsById.get(q.id);
            if (!f) return false;
            if (filter === 'anomalies') return f.hasAnomaly;
            if (filter === 'late') return f.isLate;
            return f.isClean;
          });
    if (!term) return base;
    return base.filter(q => {
      const repoName = grading?.[q.id]?.repoName ?? '';
      const haystack = `${q.name} ${q.assignment} ${repoName}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [queue, flagsById, filter, search, grading]);

  const handleRowClick = (id: string) => {
    setSelectedId(prev => (prev === id ? null : id));
    setDrawerId(prev => (prev === id ? null : id));
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
        {/* Filter pill toolbar */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800"
          data-testid="queue-filter-toolbar"
        >
          <div className="relative flex-1 max-w-[320px]">
            <svg
              aria-hidden
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search students, assignments, repos…"
              data-testid="queue-search-input"
              className="w-full pl-8 pr-3 py-1.5 text-[12.5px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2"
              style={{ outlineColor: 'var(--accent)' }}
              onFocus={e => {
                e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent)';
              }}
              onBlur={e => {
                e.currentTarget.style.boxShadow = '';
              }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-[14px] leading-none w-5 h-5 rounded-full grid place-items-center"
              >
                ×
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            {FILTER_OPTIONS.map(opt => {
              const active = filter === opt.key;
              const n = counts[opt.key];
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setFilter(opt.key)}
                  data-testid={`queue-pill-${opt.key}`}
                  className={[
                    'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-colors',
                    active
                      ? 'text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 ring-1 ring-gray-200 dark:ring-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700',
                  ].join(' ')}
                  style={
                    active
                      ? {
                          backgroundColor: 'var(--accent)',
                          boxShadow: 'inset 0 0 0 1px var(--accent)',
                        }
                      : undefined
                  }
                >
                  <span>{opt.label}</span>
                  <span
                    className={[
                      'tabular-nums text-[11px] px-1.5 rounded-full',
                      active
                        ? 'bg-white/20 text-white'
                        : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400',
                    ].join(' ')}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {filteredQueue.length === 0 ? (
          <div
            style={{
              padding: '28px 18px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            {queue.length === 0
              ? 'Nothing to grade right now.'
              : 'No submissions match this filter.'}
          </div>
        ) : (
          filteredQueue.map((q, i) => {
            const f = flagsById.get(q.id);
            const isOpen = drawerId === q.id;
            const isLast = i === filteredQueue.length - 1;
            return (
              <div key={q.id}>
                <GradingQueueRow
                  item={q}
                  last={isLast && !isOpen}
                  onClick={handleRowClick}
                  snapshot={analytics?.[q.id]?.snapshot ?? null}
                  deadline={analytics?.[q.id]?.deadline ?? null}
                />
                {isOpen && f && (f.hasAnomaly || f.isLate) && (
                  <div
                    data-testid="anomaly-drawer"
                    className="px-5 py-3 bg-amber-50/60 dark:bg-amber-900/10 border-b border-amber-200/60 dark:border-amber-800/40 text-[12.5px] text-gray-700 dark:text-gray-300"
                    style={{ borderBottomWidth: isLast ? 0 : 1 }}
                  >
                    <div className="font-semibold text-gray-900 dark:text-gray-100 mb-1">
                      Why flagged
                    </div>
                    <ul className="list-disc pl-5 space-y-0.5">
                      {f.isDumpAndRun && (
                        <li>80% of commits landed in the final 24 hours before deadline.</li>
                      )}
                      {f.lateRatio > 0.3 && (
                        <li>
                          {(f.lateRatio * 100).toFixed(0)}% of commits (
                          {f.lateCommitCount}) after deadline
                          {q.lateHours ? ` (${q.lateHours}h late)` : ''}.
                        </li>
                      )}
                      {f.busShare > 0.7 && (
                        <li>
                          Bus factor: {f.busLogin ? `@${f.busLogin} ` : ''}authored{' '}
                          {(f.busShare * 100).toFixed(0)}% of commits.
                        </li>
                      )}
                      {f.isLate && f.lateRatio <= 0.3 && !f.isDumpAndRun && (
                        <li>
                          Submitted {q.lateHours ? `${q.lateHours}h ` : ''}after the grading
                          deadline.
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Selected submission detail */}
      {selectedId && selected && (
        <div data-testid="submission-detail" className="flex flex-col gap-3">
          {grading?.[selectedId] && emojiMappings && (
            <div
              data-testid="submission-grader-bar"
              className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            >
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[12px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold">
                  Grade
                </span>
                {grading[selectedId].grades.length === 0 ? (
                  <span className="text-[12.5px] text-gray-500 dark:text-gray-400">
                    No grade yet — pick an emoji to assign.
                  </span>
                ) : (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {grading[selectedId].grades.map(g => (
                      <span
                        key={g.id}
                        title={g.grader?.name ? `by ${g.grader.name}` : 'Grade'}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200/70 dark:border-amber-800/50 text-[13px]"
                      >
                        <span>{g.emoji}</span>
                        {g.grader?.name && (
                          <span className="text-[11px] text-gray-500 dark:text-gray-400">
                            {g.grader.name}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <EmojiGrader
                  repositoryAssignment={{
                    id: grading[selectedId].repositoryAssignmentId,
                    assignment_id: grading[selectedId].assignmentId,
                    studentId: grading[selectedId].studentId ?? undefined,
                    teamId: grading[selectedId].teamId ?? undefined,
                    grades: grading[selectedId].grades,
                    repository: grading[selectedId].repoName
                      ? { name: grading[selectedId].repoName }
                      : null,
                  }}
                  emojiMappings={emojiMappings}
                />
                <LateOverrideButton
                  repositoryAssignment={{
                    id: grading[selectedId].repositoryAssignmentId,
                    is_late: grading[selectedId].isLate,
                    is_late_override: grading[selectedId].isLateOverride,
                  }}
                />
              </div>
            </div>
          )}
          <GitHubStatsPanel
            snapshot={selected.snapshot}
            deadline={selected.deadline}
            onRefresh={
              onRefreshSubmission
                ? () => onRefreshSubmission(selectedId)
                : undefined
            }
            refreshing={refreshingSubmissionId === selectedId}
            repositoryId={selected.repositoryId}
            students={students}
          />
        </div>
      )}
    </div>
  );
}

export default GradingScreen;
