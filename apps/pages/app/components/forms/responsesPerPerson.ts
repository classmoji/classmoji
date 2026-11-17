/**
 * The builder's "responses per person" setting: its three values, their
 * labels, and which of them a form can take right now.
 *
 * Pure, so `tests/unit/forms-responses-per-person.spec.ts` checks the rules
 * without rendering. The rules themselves are form.service's (`create` and
 * `update` refuse every case marked unavailable here); this only keeps the
 * builder from offering a choice the save would refuse, and says why.
 */

export type ResponsesPerPerson = 'ONE' | 'REPLACE' | 'MANY';

export const RESPONSES_PER_PERSON_LABELS: Record<ResponsesPerPerson, string> = {
  ONE: 'One response',
  REPLACE: 'One response, editable until the form closes',
  MANY: 'Several responses',
};

const VALUES = Object.keys(RESPONSES_PER_PERSON_LABELS) as ResponsesPerPerson[];

/** A posted value as one of the three, or null for anything else. */
export function responsesPerPersonOf(value: unknown): ResponsesPerPerson | null {
  return typeof value === 'string' && (VALUES as string[]).includes(value)
    ? (value as ResponsesPerPerson)
    : null;
}

export interface ResponsesPerPersonChoice {
  value: ResponsesPerPerson;
  label: string;
  disabled: boolean;
}

/**
 * The three choices for a form, and the one line that says why any of them is
 * unavailable (null when all are).
 *
 *  - Several responses needs a CLASSROOM form: a public filler is an email
 *    address, which holds one response.
 *  - It is unavailable on a form a team set reads, which takes one response
 *    per person.
 *  - Once the form has any response (a draft included), it cannot be switched
 *    to or from Several responses. One response and the editable one stay
 *    interchangeable.
 */
export function responsesPerPersonChoices({
  access,
  current,
  hasResponseRows,
  hasTeamSets,
}: {
  access: 'PUBLIC' | 'CLASSROOM';
  current: ResponsesPerPerson;
  hasResponseRows: boolean;
  hasTeamSets: boolean;
}): { choices: ResponsesPerPersonChoice[]; reason: string | null } {
  let reason: string | null = null;
  const crossesMany = (value: ResponsesPerPerson) => (value === 'MANY') !== (current === 'MANY');

  if (access === 'PUBLIC') {
    reason = 'Several responses needs a classroom form.';
  } else if (hasResponseRows && current === 'MANY') {
    reason = 'Fixed at several responses: the form has responses.';
  } else if (hasResponseRows) {
    reason = 'Several responses is unavailable: the form has responses.';
  } else if (hasTeamSets) {
    reason = 'Several responses is unavailable: a team set uses this form.';
  }

  const choices = VALUES.map(value => ({
    value,
    label: RESPONSES_PER_PERSON_LABELS[value],
    disabled:
      value !== current &&
      ((value === 'MANY' && (access === 'PUBLIC' || hasTeamSets)) ||
        (hasResponseRows && crossesMany(value))),
  }));

  return { choices, reason: choices.some(choice => choice.disabled) ? reason : null };
}
