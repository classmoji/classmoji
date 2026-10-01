import { Link, useLoaderData, useNavigate } from 'react-router';

import { CompareMetricsTable } from '~/components/forms/teams/CompareMetricsTable.tsx';
import { MoversList } from '~/components/forms/teams/MoversList.tsx';
import { RunList } from '~/components/forms/teams/RunList.tsx';
import {
  backToRunText,
  changedSinceRunText,
  compareTitle,
  openRunText,
  runPath,
} from '~/components/forms/teams/teamsView.ts';
import type { ComparePageData } from '~/components/forms/teams/types.ts';
import { useTeamSetLayoutData } from '~/components/forms/teams/useSetFetcher.ts';

import { loadComparePage, teamsHeaders, type TeamsRouteArgs } from './teamsData.server.ts';

/**
 * Run n compared with run m (`runs/:runNumber/compare/:otherNumber`), inside
 * the set layout's Runs tab.
 *
 * The run rail on the left (run n selected), then the comparison: its title
 * with the settings that changed from run m's setup to run n's, links back to
 * run n and over to run m, the metrics table (each number in both runs and the
 * change, then how many people moved), and who moved with the pin and request
 * facts the comparison carries, closed by how many stayed put and who is in
 * one run only (MoversList's footer).
 *
 * The table and the list stack, table first: the set pages are capped at
 * max-w-7xl, so beside each other the table's labels wrap at every viewport.
 *
 * When either run has no teams (not solved), the comparison's place holds
 * that one sentence (teamsErrors `run_not_solved`), beside the same rail,
 * title and links.
 *
 * Read-only: nothing here posts. The loader gates, reads `compareRuns` with
 * names and writes a VIEW audit row (none when there is nothing to compare);
 * URLs come from the layout's `paths`.
 */

export const loader = (args: TeamsRouteArgs) => loadComparePage(args);

/** `no-store` on every response of a set page (see teamsHeaders). */
export const headers = teamsHeaders;

const LINK_BASE = 'rounded-lg px-3 py-1.5 text-sm font-medium';
const LINK_BACK = `${LINK_BASE} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800`;
const LINK_OPEN = `${LINK_BASE} text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800`;

export default function TeamSetCompare() {
  const { runs, runNumber, otherNumber, comparison, refusal, grouped, ruleLabels } =
    useLoaderData() as ComparePageData;
  const layout = useTeamSetLayoutData();
  const navigate = useNavigate();
  // Always there: this route renders inside the set layout.
  if (!layout) return null;

  const { paths } = layout;
  const hrefFor = (number: number) => runPath(paths, number);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[188px_minmax(0,1fr)]">
      <RunList
        runs={runs}
        selected={runNumber}
        hrefFor={hrefFor}
        onSelect={number => navigate(hrefFor(number))}
      />

      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2
            data-testid="compare-title"
            className="text-base font-semibold text-gray-900 dark:text-white"
          >
            {compareTitle(runNumber, otherNumber)}
          </h2>
          {comparison && comparison.changes.length > 0 ? (
            <span
              data-testid="compare-changes"
              className="max-w-full rounded-2xl border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200"
            >
              {changedSinceRunText(otherNumber, comparison.changes)}
            </span>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Link data-testid="compare-back" to={hrefFor(runNumber)} className={LINK_BACK}>
              {backToRunText(runNumber)}
            </Link>
            <Link data-testid="compare-open" to={hrefFor(otherNumber)} className={LINK_OPEN}>
              {openRunText(otherNumber)}
            </Link>
          </div>
        </div>

        {comparison ? (
          <div className="grid items-start gap-4">
            <CompareMetricsTable
              comparison={comparison}
              ruleLabels={ruleLabels}
              grouped={grouped}
            />
            <MoversList comparison={comparison} grouped={grouped} />
          </div>
        ) : (
          <p
            role="status"
            data-testid="compare-refusal"
            className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            {refusal?.message}
          </p>
        )}
      </div>
    </div>
  );
}
