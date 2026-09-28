import { useState } from 'react';

import { AddPinForm } from './AddPinForm.tsx';
import {
  PIN_KIND_LABELS,
  pinDetailText,
  pinPeopleText,
  SETUP_ROW_IDS,
  TEAMS_LABELS,
} from './teamsView.ts';
import type { PersonRef, PinView, SetupOption, TeamSetConfigPatchInput } from './types.ts';

/**
 * Setup's Pins card: each pin's kind, the people (and project), the reason
 * and who added it (`pinDetailText`: "Has a badge · you", "… · over MCP"),
 * with Remove; "Add pin" opens the add form. Each pin row carries
 * `SETUP_ROW_IDS.pin(id)`, so a Can't-solve link lands on it.
 *
 * Presentational: props in, one patch per change out (`pins.add`,
 * `pins.remove`).
 */

export interface PinsCardProps {
  /** SetupView.pins. */
  pins: readonly PinView[];
  /** The viewer's user id: their pins read "you". */
  viewerId: string;
  /** People the add form offers (SetupView.roster). */
  roster: readonly PersonRef[];
  /** The grouping question's options (SetupView.options); [] in free mode. */
  options: readonly Pick<SetupOption, 'option_id' | 'label'>[];
  /** The set is created or creating: nothing can be added or removed. */
  locked: boolean;
  /** Autosave: the route posts it as `intent: 'patch'`. */
  onPatch: (patch: TeamSetConfigPatchInput) => void;
}

export function PinsCard({ pins, viewerId, roster, options, locked, onPatch }: PinsCardProps) {
  const [adding, setAdding] = useState(false);

  return (
    <section
      id={SETUP_ROW_IDS.pins}
      aria-labelledby="pins-heading"
      className="scroll-mt-24 rounded-xl border border-gray-200 bg-white p-4 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:data-[highlight=true]:ring-blue-400"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="pins-heading" className="text-sm font-semibold text-gray-900 dark:text-white">
          {TEAMS_LABELS.pins}
        </h2>
        <button
          id="pins-add"
          type="button"
          aria-expanded={adding}
          disabled={locked}
          onClick={() => setAdding(open => !open)}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          {TEAMS_LABELS.addPin}
        </button>
      </div>

      {adding && !locked ? (
        <div className="mb-3">
          <AddPinForm
            idPrefix="add-pin"
            roster={roster}
            options={options}
            onAdd={pin => {
              onPatch({ pins: { add: [pin] } });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : null}

      {pins.length > 0 ? (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {pins.map(pin => {
            const rowId = SETUP_ROW_IDS.pin(pin.id);
            const detail = pinDetailText(pin, viewerId);
            return (
              <li
                key={pin.id}
                id={rowId}
                className="flex scroll-mt-24 items-start gap-2.5 rounded-md py-2 data-[highlight=true]:ring-2 data-[highlight=true]:ring-blue-500 dark:data-[highlight=true]:ring-blue-400"
              >
                <span className="mt-0.5 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  {PIN_KIND_LABELS[pin.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    id={`${rowId}-people`}
                    className="block text-sm font-medium text-gray-900 dark:text-white"
                  >
                    {pinPeopleText(pin)}
                  </span>
                  {detail ? (
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{detail}</span>
                  ) : null}
                </span>
                <button
                  id={`${rowId}-remove`}
                  type="button"
                  disabled={locked}
                  aria-labelledby={`${rowId}-remove ${rowId}-people`}
                  onClick={() => onPatch({ pins: { remove: [pin.id] } })}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-red-400"
                >
                  {TEAMS_LABELS.remove}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export default PinsCard;
