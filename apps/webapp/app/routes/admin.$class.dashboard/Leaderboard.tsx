import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

interface LeaderboardStudent {
  id: string;
  grade: number;
  name?: string | null;
  avatar_url?: string | null;
  login?: string | null;
}

interface LeaderboardProps {
  students: LeaderboardStudent[];
}

const initialsFor = (s: LeaderboardStudent) => {
  const base = (s.name || s.login || '?').trim();
  const parts = base.split(/\s+/);
  return (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
};

const avatarTintFor = (i: number) => {
  const tints = [
    'bg-stone-900 text-white',
    'bg-emerald-100 text-emerald-700',
    'bg-violet-100 text-violet-700',
    'bg-rose-100 text-rose-700',
    'bg-sky-100 text-sky-700',
    'bg-amber-100 text-amber-700',
  ];
  return tints[i % tints.length];
};

const PAGE_SIZE = 5;

const Leaderboard = ({ students }: LeaderboardProps) => {
  const ranked = [...students].filter(s => s.grade >= 0).sort((a, b) => b.grade - a.grade);
  const max = ranked[0]?.grade || 1;

  const pageSize = PAGE_SIZE;
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(ranked.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, ranked.length);
  const pageItems = ranked.slice(startIdx, endIdx);

  const rangeLabel =
    ranked.length === 0 ? '0 students' : `${startIdx + 1}-${endIdx} of ${ranked.length} students`;

  return (
    <section className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-4 sm:p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Students</h3>
      </div>

      {ranked.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No student grades yet.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2 flex-1">
            {pageItems.map((s, i) => {
              const rank = startIdx + i + 1;
              const pct = Math.max(4, Math.round((s.grade / max) * 100));
              return (
                <li key={s.id} className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-stone-100 dark:bg-neutral-800 text-[10px] font-semibold text-gray-500 dark:text-gray-400 shrink-0">
                    {rank}
                  </span>
                  {s.avatar_url ? (
                    <img
                      src={s.avatar_url}
                      alt=""
                      className="w-8 h-8 rounded-lg shrink-0 object-cover"
                    />
                  ) : (
                    <span
                      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 text-xs font-semibold ${avatarTintFor(rank - 1)}`}
                    >
                      {initialsFor(s)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {s.name || s.login}
                    </div>
                    {s.login && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        @{s.login}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right min-w-[70px]">
                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-200 tabular-nums">
                      {s.grade.toFixed(0)}{' '}
                      <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">
                        pts
                      </span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-stone-100 dark:bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: '#619462' }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 pt-3 border-t border-stone-200/70 dark:border-neutral-800 flex items-center justify-between gap-3 text-xs">
            <span className="text-gray-500 dark:text-gray-400 tabular-nums">{rangeLabel}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                aria-label="Previous page"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-stone-200 dark:ring-neutral-700 text-gray-600 dark:text-gray-300 hover:bg-stone-50 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <IconChevronLeft size={14} />
              </button>
              <span className="inline-flex items-center justify-center min-w-[28px] h-7 px-2 rounded-md ring-1 ring-[#619462]/40 text-[#3f6a40] dark:text-[#9BC39C] font-semibold tabular-nums">
                {currentPage}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                disabled={currentPage === pageCount}
                aria-label="Next page"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-stone-200 dark:ring-neutral-700 text-gray-600 dark:text-gray-300 hover:bg-stone-50 dark:hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <IconChevronRight size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

export default Leaderboard;
