import {
  compareRowLabel,
  compareRowsShown,
  compareValueText,
  deltaText,
  deltaTone,
  peopleMovedText,
  runTitle,
  TEAMS_LABELS,
} from './teamsView.ts';
import type { CompareMetricRow, RunComparison } from './types.ts';

/**
 * Run n compared with run m, number by number: the other run's value, this
 * run's, and the change ("+3", "−3", "same", "same count, different
 * projects"). The change is coloured by `deltaTone`: better, worse, the same,
 * or neither (projects running has no better direction).
 *
 * Columns read left to right in time: run m (the earlier one, usually), then
 * run n, then the change from m to n.
 *
 * Last comes the people-moved row: how many of those in both runs changed
 * option (free mode: teammates), "3 of 24". The pick rows ("Got their 1st
 * pick", "Got a top-3 pick") show only when both runs made their teams from a
 * question (`grouped`): free teams have no picks.
 *
 * Presentational: every string is a teamsView template or label.
 */

export interface CompareMetricsTableProps {
  comparison: Pick<
    RunComparison,
    'run_number' | 'other_run_number' | 'metrics' | 'moved' | 'unchanged'
  >;
  /** Question labels by rule id (`ComparePageData.ruleLabels`), for rule-held rows. */
  ruleLabels?: Readonly<Record<string, string>>;
  /** Both runs made their teams from a question (`ComparePageData.grouped`). */
  grouped?: boolean;
}

const TONE_CLASSES: Record<NonNullable<ReturnType<typeof deltaTone>>, string> = {
  better:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  worse:
    'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200',
  same: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
  neutral:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
};

function DeltaBadge({ row }: { row: CompareMetricRow }) {
  const tone = deltaTone(row);
  const text = deltaText(row);
  if (tone === null || text === '') return null;
  return (
    <span
      data-tone={tone}
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${TONE_CLASSES[tone]}`}
    >
      {text}
    </span>
  );
}

const TH_COL =
  'whitespace-nowrap px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';

/** Row labels keep a readable width; a phone scrolls the table sideways instead. */
const TH_ROW = 'min-w-[11rem] px-4 py-2.5 text-left font-normal text-gray-700 dark:text-gray-200';
const TD_NUM =
  'whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-gray-800 dark:text-gray-100';

export function CompareMetricsTable({
  comparison,
  ruleLabels = {},
  grouped = true,
}: CompareMetricsTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <td className="px-4 py-2.5" />
            <th scope="col" className={TH_COL}>
              {runTitle(comparison.other_run_number)}
            </th>
            <th scope="col" className={TH_COL}>
              {runTitle(comparison.run_number)}
            </th>
            <th scope="col" className={TH_COL}>
              {TEAMS_LABELS.change}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {compareRowsShown(comparison.metrics, grouped).map((row, index) => (
            <tr key={`${row.key}-${row.rule_id ?? index}`}>
              <th scope="row" className={TH_ROW}>
                {compareRowLabel(row, ruleLabels)}
              </th>
              <td className={TD_NUM}>{compareValueText(row, 'other')}</td>
              <td className={TD_NUM}>{compareValueText(row, 'run')}</td>
              <td className="px-4 py-2.5 text-right">
                <DeltaBadge row={row} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className={TH_ROW}>
              {TEAMS_LABELS.peopleMoved}
            </th>
            <td className={TD_NUM} />
            <td className={TD_NUM}>{peopleMovedText(comparison)}</td>
            <td className="px-4 py-2.5" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default CompareMetricsTable;
