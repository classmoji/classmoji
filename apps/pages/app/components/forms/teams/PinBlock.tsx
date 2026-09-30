import { useState } from 'react';

import type { TeamSetPinAdd } from '@classmoji/services/team-set-config';

import type { OptionRef, PersonRef, PinTargetOption } from './types.ts';
import { optionLabel, personName, pinTargetLabel, TEAMS_LABELS } from './teamsView.ts';

/**
 * Results: pin the chosen person, under their why facts.
 *
 * Three pins: keep them on their team's option, move them to another option
 * (any option, running or not), or keep them apart from someone. A reason is
 * optional. "Add pin" hands the pin to the route as a patch's `pins.add`
 * entry; the route posts it, and the pin then shows up in the changes not run
 * yet. In free mode there are no options, so only "Keep apart from" is offered.
 *
 * The ids are fixed (one pin block per page) so tests and labels can reach
 * each control.
 */

type PinChoice = 'keep' | 'move' | 'apart';

export const PIN_BLOCK_IDS = {
  keep: 'pin-kind-keep',
  move: 'pin-kind-move',
  apart: 'pin-kind-apart',
  moveTo: 'pin-move-to',
  apartFrom: 'pin-apart-from',
  reason: 'pin-reason',
  add: 'pin-add',
} as const;

/** The schema's limit on a pin reason. */
const REASON_MAX = 200;

export interface PinBlockProps {
  /** The person being pinned. */
  person: PersonRef;
  /** The option of their team in this run; null in free mode. */
  currentOption: OptionRef | null;
  /** Every option a pin can name (RunPageData.pinTargets.options). */
  options: PinTargetOption[];
  /** Everyone they can be kept apart from (RunPageData.pinTargets.people). */
  people: PersonRef[];
  /** The set is locked: nothing can be pinned. */
  disabled?: boolean;
  /** A pin is being saved. */
  busy?: boolean;
  onAddPin: (pin: TeamSetPinAdd) => void;
}

export function PinBlock({
  person,
  currentOption,
  options,
  people,
  disabled = false,
  busy = false,
  onAddPin,
}: PinBlockProps) {
  const moveTargets = currentOption ? options.filter(option => option.id !== currentOption.id) : [];
  const apartTargets = people.filter(other => other.user_id !== person.user_id);

  const [choice, setChoice] = useState<PinChoice>(
    moveTargets.length > 0 ? 'move' : currentOption ? 'keep' : 'apart'
  );
  const [moveTo, setMoveTo] = useState<string>(moveTargets[0]?.id ?? '');
  const [apartFrom, setApartFrom] = useState<string>(apartTargets[0]?.user_id ?? '');
  const [reason, setReason] = useState('');

  // A target can leave the list between renders (fresh loader data): fall back to the first.
  const moveValue = moveTargets.some(option => option.id === moveTo)
    ? moveTo
    : (moveTargets[0]?.id ?? '');
  const apartValue = apartTargets.some(other => other.user_id === apartFrom)
    ? apartFrom
    : (apartTargets[0]?.user_id ?? '');

  const ready =
    (choice === 'keep' && currentOption !== null) ||
    (choice === 'move' && moveValue !== '') ||
    (choice === 'apart' && apartValue !== '');

  function add() {
    const typed = reason.trim();
    const withReason = typed ? { reason: typed } : {};
    let pin: TeamSetPinAdd;
    if (choice === 'apart' && apartValue !== '') {
      pin = { kind: 'apart', user_ids: [person.user_id, apartValue], ...withReason };
    } else if (choice === 'keep' && currentOption !== null) {
      pin = {
        kind: 'on_option',
        user_id: person.user_id,
        option_id: currentOption.id,
        ...withReason,
      };
    } else if (choice === 'move' && moveValue !== '') {
      pin = { kind: 'on_option', user_id: person.user_id, option_id: moveValue, ...withReason };
    } else {
      return;
    }
    onAddPin(pin);
    setReason('');
  }

  const off = disabled || busy;
  const selectClass =
    'max-w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white';
  const rowClass = 'flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300';

  return (
    <div className="grid gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
      {currentOption ? (
        <div className={rowClass}>
          <input
            type="radio"
            id={PIN_BLOCK_IDS.keep}
            name="pin-kind"
            value="keep"
            checked={choice === 'keep'}
            onChange={() => setChoice('keep')}
            disabled={off}
            className="accent-blue-600"
          />
          <label htmlFor={PIN_BLOCK_IDS.keep}>
            {TEAMS_LABELS.keepOn} {optionLabel(currentOption)}
          </label>
        </div>
      ) : null}

      {moveTargets.length > 0 ? (
        <div className={rowClass}>
          <input
            type="radio"
            id={PIN_BLOCK_IDS.move}
            name="pin-kind"
            value="move"
            checked={choice === 'move'}
            onChange={() => setChoice('move')}
            disabled={off}
            className="accent-blue-600"
          />
          <label htmlFor={PIN_BLOCK_IDS.move} id={`${PIN_BLOCK_IDS.move}-label`}>
            {TEAMS_LABELS.moveTo}
          </label>
          <select
            id={PIN_BLOCK_IDS.moveTo}
            aria-labelledby={`${PIN_BLOCK_IDS.move}-label`}
            value={moveValue}
            onChange={event => {
              setMoveTo(event.target.value);
              setChoice('move');
            }}
            disabled={off}
            className={selectClass}
          >
            {moveTargets.map(option => (
              <option key={option.id} value={option.id}>
                {pinTargetLabel(option)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {apartTargets.length > 0 ? (
        <div className={rowClass}>
          <input
            type="radio"
            id={PIN_BLOCK_IDS.apart}
            name="pin-kind"
            value="apart"
            checked={choice === 'apart'}
            onChange={() => setChoice('apart')}
            disabled={off}
            className="accent-blue-600"
          />
          <label htmlFor={PIN_BLOCK_IDS.apart} id={`${PIN_BLOCK_IDS.apart}-label`}>
            {TEAMS_LABELS.keepApartFrom}
          </label>
          <select
            id={PIN_BLOCK_IDS.apartFrom}
            aria-labelledby={`${PIN_BLOCK_IDS.apart}-label`}
            value={apartValue}
            onChange={event => {
              setApartFrom(event.target.value);
              setChoice('apart');
            }}
            disabled={off}
            className={selectClass}
          >
            {apartTargets.map(other => (
              <option key={other.user_id} value={other.user_id}>
                {personName(other)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="grid gap-1">
        <label htmlFor={PIN_BLOCK_IDS.reason} className="text-xs text-gray-500 dark:text-gray-400">
          {TEAMS_LABELS.reason}
        </label>
        <input
          type="text"
          id={PIN_BLOCK_IDS.reason}
          value={reason}
          maxLength={REASON_MAX}
          onChange={event => setReason(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          disabled={off}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
        />
      </div>

      <div>
        <button
          type="button"
          id={PIN_BLOCK_IDS.add}
          onClick={add}
          disabled={off || !ready}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
        >
          {TEAMS_LABELS.addPin}
        </button>
      </div>
    </div>
  );
}

export default PinBlock;
