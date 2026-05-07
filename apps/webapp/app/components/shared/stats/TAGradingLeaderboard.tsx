interface GradingLeaderboardItem {
  id: string;
  login: string | null;
  name: string | null;
  progress: number;
  gradedCount?: number;
  gradedThisWeek?: number;
}

interface TAGradingLeaderboardProps {
  progress: GradingLeaderboardItem[];
  bare?: boolean;
}

const initialsFor = (name: string | null, login: string | null) => {
  const base = (name || login || '?').trim();
  const parts = base.split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
};

const avatarTintFor = (i: number) => {
  const tints = [
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
    'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  ];
  return tints[i % tints.length];
};

const TAGradingLeaderboard = ({ progress, bare = false }: TAGradingLeaderboardProps) => {
  const sorted = [...progress].sort((a, b) => {
    const aCount = a.gradedCount ?? a.progress;
    const bCount = b.gradedCount ?? b.progress;
    return bCount - aCount;
  });

  const body = (
    <>
      {!bare && (
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">
          TA grading
        </h3>
      )}
      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No TAs assigned yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((item, i) => {
            const total = item.gradedCount ?? Math.round(item.progress);
            const thisWeek = item.gradedThisWeek;
            return (
              <li key={item.id} className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0 text-xs font-semibold ${avatarTintFor(i)}`}
                >
                  {initialsFor(item.name, item.login)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {item.name || item.login}
                  </div>
                  {thisWeek !== undefined && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {thisWeek} graded this week
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums leading-none">
                    {total}
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500 mt-0.5">
                    {item.gradedCount !== undefined ? 'total' : '%'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  if (bare) return body;

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 h-full">
      {body}
    </section>
  );
};

export default TAGradingLeaderboard;
