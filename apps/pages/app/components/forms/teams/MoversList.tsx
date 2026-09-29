import {
  joinedLeftText,
  moverLine,
  moverPinLine,
  moverRequestLine,
  personName,
  plural,
  TEAMS_LABELS,
  unchangedText,
} from './teamsView.ts';
import type { RunComparison, RunMover } from './types.ts';

/**
 * Who moved between run m and run n: each person whose option (free mode:
 * teammates) changed, from where to where with the rank they gave each, then
 * only the reasons the comparison carries: the pin in run n's setup that names
 * them (and its typed reason), and requests that flipped ("Now kept: …",
 * "No longer kept: …"). Then how many stayed put, and who is in one run only.
 *
 * Presentational: a card with its heading and the number of people who
 * moved; every string is a teamsView template or label.
 */

export interface MoversListProps {
  comparison: Pick<
    RunComparison,
    'moved' | 'unchanged' | 'joined' | 'left' | 'run_number' | 'other_run_number'
  >;
  /** Grouped by option: "on the same project"; free mode: "the same teammates". */
  grouped: boolean;
}

/** The mover line split in two: the name (bold) and " · Ledger (1st) → Studio (2nd)". */
function lineParts(mover: RunMover): [string, string] {
  const name = personName(mover.user);
  const line = moverLine(mover);
  return line.startsWith(name) ? [name, line.slice(name.length)] : ['', line];
}

function MoverRow({ mover }: { mover: RunMover }) {
  const [name, rest] = lineParts(mover);
  const reasons = [
    ...(mover.pin ? [moverPinLine(mover.pin)] : []),
    ...mover.requests.map(moverRequestLine),
  ];
  return (
    <li className="px-4 py-2.5">
      <div className="text-sm text-gray-800 dark:text-gray-100">
        {name ? <b className="font-semibold text-gray-900 dark:text-white">{name}</b> : null}
        {rest}
      </div>
      {reasons.map((reason, index) => (
        <div key={`${index}-${reason}`} className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
          {reason}
        </div>
      ))}
    </li>
  );
}

export function MoversList({ comparison, grouped }: MoversListProps) {
  const footer = [unchangedText(comparison, grouped), ...joinedLeftText(comparison)];
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.whoMoved}
        </h2>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {plural(comparison.moved.length, 'person', 'people')}
        </span>
      </header>
      {comparison.moved.length > 0 ? (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {comparison.moved.map(mover => (
            <MoverRow key={mover.user.user_id} mover={mover} />
          ))}
        </ul>
      ) : null}
      <div
        className={`grid gap-0.5 px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400 ${
          comparison.moved.length > 0 ? 'border-t border-gray-200 dark:border-gray-700' : ''
        }`}
      >
        {footer.map((line, index) => (
          <p key={`${index}-${line}`}>{line}</p>
        ))}
      </div>
    </section>
  );
}

export default MoversList;
