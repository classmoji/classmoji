import dayjs from 'dayjs';

interface GradingProgressItem {
  id?: string;
  title: string;
  progress: number;
  student_deadline: string | Date | null;
  [key: string]: unknown;
}

interface StatsGradingProgressProps {
  gradingProgress: GradingProgressItem[];
  bare?: boolean;
}

const statusForPct = (pct: number) => {
  if (pct >= 100) {
    return {
      label: 'Done',
      className: 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]',
    };
  }
  if (pct > 0) {
    return {
      label: 'In progress',
      className: 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]',
    };
  }
  return {
    label: 'Not started',
    className: 'bg-stone-100 text-gray-600 dark:bg-neutral-800 dark:text-gray-300',
  };
};

const StatsGradingProgress = ({ gradingProgress, bare = false }: StatsGradingProgressProps) => {
  const rows = gradingProgress
    .filter(a => a.student_deadline && dayjs().isAfter(dayjs(a.student_deadline)))
    .sort((a, b) => b.progress - a.progress);

  const body = (
    <>
      {!bare && (
        <h3 className="text-base font-semibold text-ink-0 mb-4">
          Grading progress
        </h3>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">
          No past-deadline assignments yet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-4 text-xs font-semibold tracking-[0.08em] uppercase text-ink-4 pb-2 border-b border-line">
            <span>Assignment</span>
            <span>Progress</span>
            <span className="text-right">Status</span>
          </div>
          <ul className="divide-y divide-line">
            {rows.slice(0, 5).map(a => {
              const pct = Math.round(a.progress);
              const status = statusForPct(pct);
              return (
                <li
                  key={a.id ?? a.title}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] gap-4 items-center py-2"
                >
                  <span className="text-sm text-ink-1 truncate">
                    {a.title}
                  </span>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-1.5 rounded-full bg-nav-hover overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: pct >= 100 ? '#619462' : '#758CA0',
                        }}
                      />
                    </div>
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300 tabular-nums min-w-[36px] text-right">
                      {pct}%
                    </span>
                  </div>
                  <span
                    className={`justify-self-end inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${status.className}`}
                  >
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );

  if (bare) return body;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 h-full flex flex-col">
      {body}
    </section>
  );
};

export default StatsGradingProgress;
