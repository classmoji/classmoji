export interface BucketCounts {
  graded: number;
  submitted: number;
  unlocked: number;
  locked: number;
  total: number;
}

interface ProgressSummaryCardProps {
  classroomTitle: string;
  classroomSubtitle?: string | null;
  counts: BucketCounts;
}

const ProgressSummaryCard = ({
  classroomTitle,
  classroomSubtitle,
  counts,
}: ProgressSummaryCardProps) => {
  const { graded, submitted, unlocked, total } = counts;
  const completed = graded + submitted;
  const current = unlocked;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  const completedPct = total === 0 ? 0 : (completed / total) * 100;
  const currentPct = total === 0 ? 0 : (current / total) * 100;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight truncate">
            {classroomTitle}
          </h2>
          {classroomSubtitle && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {classroomSubtitle}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl sm:text-3xl font-semibold tracking-tight">
            <span style={{ color: '#619462' }}>{completed}</span>
            <span className="text-gray-400 dark:text-gray-500">/{total}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="flex-1 h-2.5 rounded-full bg-stone-100 dark:bg-neutral-800 overflow-hidden flex">
          {completedPct > 0 && (
            <div
              style={{ width: `${completedPct}%`, backgroundColor: '#619462' }}
              aria-label={`Completed: ${completed}`}
            />
          )}
          {currentPct > 0 && (
            <div
              style={{ width: `${currentPct}%`, backgroundColor: '#D4A289' }}
              aria-label={`Current: ${current}`}
            />
          )}
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 tabular-nums">
          {pct}% complete
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#619462' }} />
          Completed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#D4A289' }} />
          Current
        </span>
      </div>
    </section>
  );
};

export default ProgressSummaryCard;
