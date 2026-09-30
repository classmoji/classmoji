import { IconAlertTriangle, IconCheck, IconCircleX } from '@tabler/icons-react';

import { CHECK_LEVEL_LABELS, listJoin, SETUP_ROW_IDS, TEAMS_LABELS } from './teamsView.ts';
import type { CheckLine } from './types.ts';

/**
 * Setup's checks: passed lines, warnings and errors, as the service words
 * them (`CheckLine.message` is facts only; `names` are the people a check
 * names, resolved at read time). Errors block Run; the header's Run button
 * shows them and the server refuses anyway, so this list only reports.
 *
 * "Check again" is a callback: the route revalidates (checks are computed by
 * the setup loader), nothing is posted.
 *
 * Presentational: props in, callbacks out.
 */

export interface ChecksListProps {
  /** SetupView.checks, passed checks included (`level: 'ok'`). */
  checks: readonly CheckLine[];
  /** Re-read the checks (the route: `useRevalidator().revalidate()`). */
  onCheckAgain: () => void;
  /** A re-read is in flight: the button is disabled. */
  busy?: boolean;
}

const LEVEL_ORDER: Readonly<Record<CheckLine['level'], number>> = { error: 0, warning: 1, ok: 2 };

/** Errors first, then warnings, then passed checks; the service's order within a level. */
function ordered(checks: readonly CheckLine[]): CheckLine[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => LEVEL_ORDER[a.check.level] - LEVEL_ORDER[b.check.level] || a.index - b.index)
    .map(entry => entry.check);
}

function LevelIcon({ level }: { level: CheckLine['level'] }) {
  switch (level) {
    case 'error':
      return (
        <>
          <IconCircleX size={16} aria-hidden="true" className="text-red-600 dark:text-red-400" />
          <span className="sr-only">{CHECK_LEVEL_LABELS.error}</span>
        </>
      );
    case 'warning':
      return (
        <>
          <IconAlertTriangle
            size={16}
            aria-hidden="true"
            className="text-amber-600 dark:text-amber-400"
          />
          <span className="sr-only">{CHECK_LEVEL_LABELS.warning}</span>
        </>
      );
    case 'ok':
      return (
        <>
          <IconCheck size={16} aria-hidden="true" className="text-green-600 dark:text-green-400" />
          <span className="sr-only">{CHECK_LEVEL_LABELS.ok}</span>
        </>
      );
  }
}

const LINE_TONE: Readonly<Record<CheckLine['level'], string>> = {
  error: 'text-red-800 dark:text-red-200',
  warning: 'text-amber-900 dark:text-amber-200',
  ok: 'text-gray-700 dark:text-gray-300',
};

export function ChecksList({ checks, onCheckAgain, busy = false }: ChecksListProps) {
  return (
    <section
      id={SETUP_ROW_IDS.checks}
      aria-labelledby="checks-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white p-4 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="checks-heading" className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.checks}
        </h2>
        <button
          id="checks-again"
          type="button"
          onClick={onCheckAgain}
          disabled={busy}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          {TEAMS_LABELS.checkAgain}
        </button>
      </div>
      {checks.length > 0 ? (
        <ul className="space-y-1.5">
          {ordered(checks).map((check, index) => (
            <li
              key={`${check.level}-${check.code}-${index}`}
              data-level={check.level}
              className={`flex items-start gap-2 text-sm ${LINE_TONE[check.level]}`}
            >
              <span className="mt-0.5 shrink-0">
                <LevelIcon level={check.level} />
              </span>
              <span className="min-w-0">
                {check.message}
                {check.names && check.names.length > 0 ? (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {listJoin(check.names)}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default ChecksList;
