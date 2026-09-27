import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { TeamSetPinAdd } from '@classmoji/services/team-set-config';

import { PIN_KIND_LABELS, TEAMS_LABELS, personName } from './teamsView.ts';
import type { PersonRef, PinView, SetupOption } from './types.ts';

/**
 * The form that adds one pin: Together / Apart (two people), On (a person and
 * a project) or Not on (a person and one or more projects), with an optional
 * reason. It hands the pin back as a patch's `pins.add` entry; the id and the
 * who-added stamps are the service's.
 *
 * Used by the Pins card, and by a Projects table row's "+ Add person", which
 * fixes the pin to that row's project (`optionId`): no kind or project pickers.
 *
 * Every control's id starts with `idPrefix`, so several forms can be on the
 * page at once.
 *
 * Opening the form moves focus into it (the chosen kind, else the first
 * picker); closing it — Add pin or Cancel — puts focus back on the control
 * that opened it.
 *
 * Presentational: props in, the pin out.
 */

export interface AddPinFormProps {
  /** People the pickers offer (SetupView.roster). */
  roster: readonly PersonRef[];
  /** The grouping question's options (SetupView.options); [] in free mode, where only Together and Apart are offered. */
  options: readonly Pick<SetupOption, 'option_id' | 'label'>[];
  /** Pins the person to this project (kind On); the kind and project pickers are left out. */
  optionId?: string;
  /** People the person pickers leave out (e.g. those already pinned to `optionId`). */
  excludeUserIds?: readonly string[];
  /** Prefix of every control id: `${idPrefix}-kind-together`, `${idPrefix}-person-a`, …, `${idPrefix}-submit`. */
  idPrefix: string;
  disabled?: boolean;
  /** The pin, ready for `patch.pins.add`. */
  onAdd: (pin: TeamSetPinAdd) => void;
  onCancel: () => void;
}

type Kind = PinView['kind'];

const KIND_ORDER: readonly Kind[] = ['together', 'apart', 'on_option', 'not_options'];

/** TeamSetConfig pins: `reason` is at most 200 characters. */
const REASON_MAX = 200;

const fieldClass =
  'block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-white';

const labelClass =
  'mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400';

export function AddPinForm({
  roster,
  options,
  optionId,
  excludeUserIds = [],
  idPrefix,
  disabled = false,
  onAdd,
  onCancel,
}: AddPinFormProps) {
  const kinds: readonly Kind[] = optionId
    ? ['on_option']
    : options.length > 0
      ? KIND_ORDER
      : ['together', 'apart'];

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    formRef.current
      ?.querySelector<HTMLElement>(
        '[aria-pressed="true"]:not([disabled]), select:not([disabled]), input:not([disabled])'
      )
      ?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const [kind, setKind] = useState<Kind>(kinds[0]);
  const [personA, setPersonA] = useState('');
  const [personB, setPersonB] = useState('');
  const [option, setOption] = useState(optionId ?? '');
  const [notOn, setNotOn] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const excluded = new Set(excludeUserIds);
  const people = roster.filter(person => !excluded.has(person.user_id));
  const pair = kind === 'together' || kind === 'apart';

  let pin: TeamSetPinAdd | null = null;
  const why = reason.trim() === '' ? {} : { reason: reason.trim() };
  if (pair && personA && personB && personA !== personB) {
    pin = { kind, user_ids: [personA, personB], ...why };
  } else if (kind === 'on_option' && personA && option) {
    pin = { kind, user_id: personA, option_id: option, ...why };
  } else if (kind === 'not_options' && personA && notOn.length > 0) {
    pin = { kind, user_id: personA, option_ids: notOn, ...why };
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pin || disabled) return;
    onAdd(pin);
    setPersonA('');
    setPersonB('');
    setOption(optionId ?? '');
    setNotOn([]);
    setReason('');
  };

  const personSelect = (id: string, value: string, set: (next: string) => void, skip?: string) => (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={event => set(event.target.value)}
      className={fieldClass}
    >
      <option value="">—</option>
      {people
        .filter(person => person.user_id !== skip)
        .map(person => (
          <option key={person.user_id} value={person.user_id}>
            {personName(person)}
          </option>
        ))}
    </select>
  );

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      data-testid={idPrefix}
      className="space-y-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800"
    >
      {kinds.length > 1 ? (
        <div>
          <span id={`${idPrefix}-kind-label`} className={labelClass}>
            {TEAMS_LABELS.kind}
          </span>
          <div
            role="group"
            aria-labelledby={`${idPrefix}-kind-label`}
            className="inline-flex flex-wrap gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-900"
          >
            {kinds.map(each => (
              <button
                key={each}
                id={`${idPrefix}-kind-${each}`}
                type="button"
                aria-pressed={each === kind}
                disabled={disabled}
                onClick={() => setKind(each)}
                className={`rounded-md px-2.5 py-1 text-sm disabled:opacity-60 ${
                  each === kind
                    ? 'bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-white'
                    : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
                }`}
              >
                {PIN_KIND_LABELS[each]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={pair ? 'grid gap-2 sm:grid-cols-2' : ''}>
        <div>
          <label htmlFor={`${idPrefix}-person-a`} className={labelClass}>
            {TEAMS_LABELS.person}
          </label>
          {personSelect(`${idPrefix}-person-a`, personA, setPersonA)}
        </div>
        {pair ? (
          <div>
            <label htmlFor={`${idPrefix}-person-b`} className={labelClass}>
              {TEAMS_LABELS.otherPerson}
            </label>
            {personSelect(`${idPrefix}-person-b`, personB, setPersonB, personA)}
          </div>
        ) : null}
      </div>

      {kind === 'on_option' && !optionId ? (
        <div>
          <label htmlFor={`${idPrefix}-option`} className={labelClass}>
            {TEAMS_LABELS.project}
          </label>
          <select
            id={`${idPrefix}-option`}
            value={option}
            disabled={disabled}
            onChange={event => setOption(event.target.value)}
            className={fieldClass}
          >
            <option value="">—</option>
            {options.map(each => (
              <option key={each.option_id} value={each.option_id}>
                {each.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {kind === 'not_options' ? (
        <fieldset>
          <legend className={labelClass}>{TEAMS_LABELS.projects}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {options.map(each => (
              <label
                key={each.option_id}
                className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-200"
              >
                <input
                  id={`${idPrefix}-not-${each.option_id}`}
                  type="checkbox"
                  checked={notOn.includes(each.option_id)}
                  disabled={disabled}
                  onChange={event =>
                    setNotOn(current =>
                      event.target.checked
                        ? [...current, each.option_id]
                        : current.filter(id => id !== each.option_id)
                    )
                  }
                />
                {each.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div>
        <label htmlFor={`${idPrefix}-reason`} className={labelClass}>
          {TEAMS_LABELS.reason}
        </label>
        <input
          id={`${idPrefix}-reason`}
          type="text"
          value={reason}
          maxLength={REASON_MAX}
          disabled={disabled}
          onChange={event => setReason(event.target.value)}
          className={fieldClass}
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          id={`${idPrefix}-cancel`}
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {TEAMS_LABELS.cancel}
        </button>
        <button
          id={`${idPrefix}-submit`}
          type="submit"
          disabled={disabled || pin === null}
          className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
        >
          {TEAMS_LABELS.addPin}
        </button>
      </div>
    </form>
  );
}

export default AddPinForm;
