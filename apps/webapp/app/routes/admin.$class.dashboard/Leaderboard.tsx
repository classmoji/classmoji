import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { initialsFor, avatarTintFor } from './leaderboardHelpers';

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
    <section className="rounded-2xl bg-panel ring-1 ring-line p-4 sm:p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink-0">Students</h3>
      </div>

      {ranked.length === 0 ? (
        <p className="text-sm text-ink-3">No student grades yet.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2 flex-1">
            {pageItems.map((s, i) => {
              const rank = startIdx + i + 1;
              const pct = Math.max(4, Math.round((s.grade / max) * 100));
              return (
                <li key={s.id} className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-nav-hover text-xs font-semibold text-ink-3 shrink-0">
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
                    <div className="text-sm font-medium text-ink-0 truncate">
                      {s.name || s.login}
                    </div>
                    {s.login && (
                      <div className="text-xs text-ink-3 truncate">
                        @{s.login}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right min-w-[70px]">
                    <div className="text-sm font-semibold text-ink-1 tabular-nums">
                      {s.grade.toFixed(0)}{' '}
                      <span className="text-xs font-medium text-ink-4">
                        pts
                      </span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-nav-hover overflow-hidden">
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

          <div className="mt-3 pt-3 border-t border-line flex items-center justify-between gap-3 text-xs">
            <span className="text-ink-3 tabular-nums">{rangeLabel}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                aria-label="Previous page"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-line text-gray-600 dark:text-gray-300 hover:bg-nav-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                className="inline-flex items-center justify-center w-7 h-7 rounded-md ring-1 ring-line text-gray-600 dark:text-gray-300 hover:bg-nav-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
