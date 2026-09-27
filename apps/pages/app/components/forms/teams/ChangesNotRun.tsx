import type { SetupChanges } from './types.ts';
import { TEAMS_LABELS, changesNotRunText, pinDetailText } from './teamsView.ts';

/**
 * Results: the setup's changes since the latest run — the same list as the
 * header chip — with Discard and Run again.
 *
 * Each item is the service's change text; an added pin also shows its reason
 * and who added it (`pinDetailText`). Both buttons are callbacks: the route asks before
 * discarding (ConfirmDialog) and posts the `discard` / `run` intents. Nothing
 * renders when there are no changes.
 */

export interface ChangesNotRunProps {
  /** The set's changes since its latest run (TeamSetLayoutData.changes). */
  changes: SetupChanges;
  viewerId: string;
  onDiscard: () => void;
  onRunAgain: () => void;
  /** A discard or run is in flight. */
  busy?: boolean;
  /** Run again can't start (a run is active, the set is locked). */
  runDisabled?: boolean;
  /** Discard can't be used (the set is locked). */
  discardDisabled?: boolean;
}

export function ChangesNotRun({
  changes,
  viewerId,
  onDiscard,
  onRunAgain,
  busy = false,
  runDisabled = false,
  discardDisabled = false,
}: ChangesNotRunProps) {
  const items = changes.items;
  if (items.length === 0) return null;

  return (
    <section
      id="changes-not-run"
      aria-labelledby="changes-not-run-title"
      className="mb-4 grid gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 dark:border-violet-800 dark:bg-violet-950/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="changes-not-run-title"
          className="text-sm font-semibold text-violet-900 dark:text-violet-200"
        >
          {changesNotRunText(items.length)}
        </h3>
        <span className="flex-1" />
        <button
          type="button"
          id="changes-discard"
          onClick={onDiscard}
          disabled={busy || discardDisabled}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-900/60"
        >
          {TEAMS_LABELS.discard}
        </button>
        <button
          type="button"
          id="changes-run-again"
          onClick={onRunAgain}
          disabled={busy || runDisabled}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
        >
          {TEAMS_LABELS.runAgain}
        </button>
      </div>
      <ul className="grid gap-1 text-sm text-gray-900 dark:text-gray-100">
        {items.map((change, index) => {
          // Only an added pin: on a removed one, "who added it" would read as who removed it.
          const detail =
            change.kind === 'pin' && change.change === 'added'
              ? pinDetailText(change.pin, viewerId)
              : '';
          return (
            <li key={index} data-change={change.kind}>
              {change.text}
              {detail ? (
                <span className="text-gray-500 dark:text-gray-400"> · {detail}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default ChangesNotRun;
