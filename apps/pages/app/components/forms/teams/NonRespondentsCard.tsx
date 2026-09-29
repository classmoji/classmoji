import {
  nonRespondentChoices,
  nonRespondentsCountText,
  SETUP_ROW_IDS,
  TEAMS_LABELS,
} from './teamsView.ts';
import type { NonRespondentsMode, SetupView, TeamSetConfigPatchInput } from './types.ts';

/**
 * Setup's "People who didn't answer" card: Spread them out / Group them
 * together / Leave them out, and how many that is.
 *
 * With no stored setting (`mode` null) the default applies, and `resolved` is
 * the mode a run would use (the service's answer, which may differ from the
 * default's usual pick when that can't form teams), so the control shows
 * `resolved` pressed and marks it Default — never as a choice someone saved
 * (`nonRespondentChoices`). Pressing the pressed button does nothing; pressing
 * another saves that mode (`patch.non_respondents`).
 *
 * The line under the control for each mode comes in through `modeNotes`
 * (teamsView's `nonRespondentModeNotes`, which words Group by whether the set
 * is made from a question); this card writes no sentences of its own.
 *
 * Presentational: props in, one patch per change out.
 */

export interface NonRespondentsCardProps {
  /** SetupView.non_respondents: the stored mode (null = default), what a run uses, and the count. */
  nonRespondents: SetupView['non_respondents'];
  /** People on the roster (SetupView.readiness.roster), for "3 of 24". */
  roster: number;
  /** The set is created or creating: the control is disabled. */
  locked: boolean;
  /** Autosave: the route posts it as `intent: 'patch'`. */
  onPatch: (patch: TeamSetConfigPatchInput) => void;
  /** The line shown under the control for the pressed mode; none shown when absent. */
  modeNotes?: Partial<Record<NonRespondentsMode, string>>;
}

export function NonRespondentsCard({
  nonRespondents,
  roster,
  locked,
  onPatch,
  modeNotes,
}: NonRespondentsCardProps) {
  const choices = nonRespondentChoices(nonRespondents);
  const pressed = choices.find(choice => choice.pressed)?.mode ?? nonRespondents.resolved;
  const note = modeNotes?.[pressed] ?? null;

  return (
    <section
      id={SETUP_ROW_IDS.nonRespondents}
      aria-labelledby="nr-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white p-4 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="nr-heading" className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.nonRespondents}
        </h2>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {nonRespondentsCountText(nonRespondents.count, roster)}
        </span>
      </div>
      <div
        role="group"
        aria-labelledby="nr-heading"
        className="flex flex-wrap gap-0.5 rounded-lg border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-800"
      >
        {choices.map(({ mode, label, pressed: on, isDefault }) => (
          <button
            key={mode}
            id={`nr-${mode}`}
            type="button"
            aria-pressed={on}
            disabled={locked}
            onClick={() => {
              if (on) return;
              onPatch({ non_respondents: mode });
            }}
            className={`flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${
              on
                ? 'bg-white font-semibold text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
            }`}
          >
            {label}
            {isDefault ? ' ' : null}
            {isDefault ? (
              <span className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-[11px] font-normal uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {TEAMS_LABELS.defaultChip}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {note ? (
        <p data-nr-note={pressed} className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {note}
        </p>
      ) : null}
    </section>
  );
}

export default NonRespondentsCard;
