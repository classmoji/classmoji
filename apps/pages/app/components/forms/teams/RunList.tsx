import { useId } from 'react';
import { Link } from 'react-router';

import {
  RUN_STATUS_LABELS,
  TEAMS_LABELS,
  firstPicksShort,
  isRunActive,
  runTitle,
  showsPicks,
} from './teamsView.ts';
import type { RunListItemView } from './types.ts';

/**
 * The Runs tab's rail: every run of the set, newest first, each with its
 * status and, once solved, how many got their 1st pick (a run made from a
 * question only: free teams have no picks, `showsPicks`).
 *
 * Wide screens get the list as links; below `lg` it collapses to one pill
 * showing the selected run, a native select over the same runs (the phone's
 * own picker). The route pairs it with a `lg:grid-cols-[188px_minmax(0,1fr)]`
 * split so the rail and the pill switch at the same width.
 *
 * Presentational: the route says which run is on screen, how to link to a run
 * (`runPath`), and what choosing one in the pill does (navigate). Every run
 * string is a teamsView template; the rail's name is TEAMS_LABELS.runs.
 */

export interface RunListProps {
  /** The set's runs; shown newest first whatever order they arrive in. */
  runs: RunListItemView[];
  /** The run on screen; null = none (a compare page may pass its own run). */
  selected: number | null;
  /** The URL of run n (`runPath(paths, n)`). */
  hrefFor: (number: number) => string;
  /** The pill's choice on narrow screens (the route navigates to `hrefFor(n)`). */
  onSelect: (number: number) => void;
}

/** "Solved · 16/21 1st picks", "Solved" (free teams), "Running", "Not solved". */
function runStatusLine(run: RunListItemView): string {
  const status = RUN_STATUS_LABELS[run.status];
  if (showsPicks(run)) return `${status} · ${firstPicksShort(run.first_choice, run.responded)}`;
  return status;
}

function statusTone(run: RunListItemView): string {
  if (isRunActive(run.status)) return 'text-blue-700 dark:text-blue-300';
  if (run.status === 'SOLVED') return 'text-gray-500 dark:text-gray-400';
  return 'text-rose-700 dark:text-rose-300';
}

export function RunList({ runs, selected, hrefFor, onSelect }: RunListProps) {
  const headingId = useId();
  if (runs.length === 0) return null;
  const ordered = [...runs].sort((a, b) => b.number - a.number);

  return (
    <div className="min-w-0">
      {/* Narrow screens: one pill, the selected run, over a native select. */}
      <div className="relative inline-flex max-w-full lg:hidden">
        <select
          value={selected ?? ''}
          onChange={event => {
            const number = Number(event.target.value);
            if (Number.isInteger(number) && number > 0) onSelect(number);
          }}
          aria-label={TEAMS_LABELS.runs}
          className="max-w-full appearance-none truncate rounded-full border border-gray-300 bg-white py-1.5 pl-3.5 pr-8 text-sm font-medium text-gray-900 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:hover:border-gray-500"
        >
          {selected === null ? <option value="" disabled hidden /> : null}
          {ordered.map(run => (
            <option key={run.number} value={run.number}>
              {`${runTitle(run.number)} · ${runStatusLine(run)}`}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-gray-400 dark:text-gray-500"
        >
          ▾
        </span>
      </div>

      {/* Wide screens: the rail. */}
      <nav aria-labelledby={headingId} className="hidden lg:block">
        <h2
          id={headingId}
          className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
        >
          {TEAMS_LABELS.runs}
        </h2>
        <ol className="grid gap-0.5">
          {ordered.map(run => {
            const current = run.number === selected;
            return (
              <li key={run.number}>
                <Link
                  to={hrefFor(run.number)}
                  aria-current={current ? 'page' : undefined}
                  className={`grid gap-px rounded-lg border px-2.5 py-1.5 ${
                    current
                      ? 'border-gray-300 bg-gray-100 dark:border-gray-600 dark:bg-gray-800'
                      : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60'
                  }`}
                >
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    {runTitle(run.number)}
                  </span>
                  <span className={`text-xs tabular-nums ${statusTone(run)}`}>
                    {runStatusLine(run)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

export default RunList;
