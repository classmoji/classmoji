import { test, expect } from '@playwright/test';
import { z } from 'zod';
import {
  buildResponseSchema,
  parseAnswers,
  parseFormDefinition,
  type FormField,
} from '@classmoji/services/form-contract';
import { coerceAnswers, friendlyErrorMap } from '../../app/components/forms/answerCoerce.ts';

/**
 * The words a person filling in a public form reads when an answer is
 * refused.
 *
 * In the browser, the renderer validates with the contract's schema under
 * `friendlyErrorMap`: those sentences are ours and pinned exactly. When the
 * server refuses (`parseAnswers`, shown by the fill page as the error state),
 * the text is `Invalid answers: <field id>: <message>`: the shape and our own
 * messages are pinned exactly; where the message is zod's default wording,
 * only that it names the one field is.
 */

const definition = parseFormDefinition([
  { type: 'switch', label: 'I agree to the terms', required: true },
  { type: 'short_text', label: 'Full name', required: true },
  { type: 'email', label: 'Email', required: true },
  { type: 'number', label: 'Class year', min: 2020, max: 2035 },
  { type: 'dropdown', label: 'Track', options: ['Design', 'Dev'] },
  { type: 'multiselect', label: 'Tools', options: ['React', 'Node', 'Figma'], max_selections: 2 },
  { type: 'ranked_choice', label: 'Rank', options: ['A', 'B', 'C'], ranks: 2, required: true },
]);
const [agree, fullName, email, year, track, tools, rank] = definition.fields;
const optionIds = (field: FormField) => (field.options as Array<{ id: string }>).map(o => o.id);

/** What the renderer's resolver reports for one field, given raw form values. */
function clientMessage(field: FormField, raw: Record<string, unknown>): string | undefined {
  const result = z
    .object({ answers: buildResponseSchema(definition.fields) })
    .safeParse({ answers: coerceAnswers(definition.fields, raw) }, { errorMap: friendlyErrorMap });
  if (result.success) return undefined;
  return result.error.issues.find(issue => issue.path[1] === field.id)?.message;
}

/** A valid answer set, to change one answer of. */
const valid = (): Record<string, unknown> => ({
  [agree.id]: true,
  [fullName.id]: 'Ada Lovelace',
  [email.id]: 'ada@example.com',
  [rank.id]: optionIds(rank).slice(0, 2),
});

/** What the server's refusal says. */
function serverMessage(answers: Record<string, unknown>): string {
  try {
    parseAnswers(definition.fields, answers);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the answers to be refused');
}

test.describe('the words a form filler reads', () => {
  test('in the browser, each refusal is one of our sentences', () => {
    expect(clientMessage(agree, { ...valid(), [agree.id]: false })).toBe(
      'You need to agree to continue.'
    );
    expect(clientMessage(fullName, { ...valid(), [fullName.id]: '' })).toBe(
      'This one is required.'
    );
    const { [fullName.id]: _gone, ...noName } = valid();
    expect(clientMessage(fullName, noName)).toBe('This one is required.');
    expect(clientMessage(email, { ...valid(), [email.id]: 'not an address' })).toBe(
      'That does not look like an email address.'
    );
    expect(clientMessage(year, { ...valid(), [year.id]: 'abc' })).toBe('Enter a number.');
    expect(clientMessage(rank, { ...valid(), [rank.id]: optionIds(rank).slice(0, 1) })).toBe(
      'Choose at least 2.'
    );
    expect(clientMessage(rank, { ...valid(), [rank.id]: optionIds(rank) })).toBe(
      'Choose at most 2.'
    );
    // The contract's own messages are already written for a person.
    expect(clientMessage(tools, { ...valid(), [tools.id]: optionIds(tools) })).toBe(
      'Pick at most 2'
    );
    expect(clientMessage(track, { ...valid(), [track.id]: 'Neither' })).toBe(
      'Not an option of this field'
    );
    expect(clientMessage(agree, valid())).toBeUndefined();
  });

  test('from the server, the refusal names the field and keeps our messages', () => {
    expect(serverMessage({ ...valid(), [tools.id]: optionIds(tools) })).toBe(
      `Invalid answers: ${tools.id}: Pick at most 2`
    );
    expect(serverMessage({ ...valid(), [track.id]: 'Neither' })).toBe(
      `Invalid answers: ${track.id}: Not an option of this field`
    );
    const [first] = optionIds(rank);
    expect(serverMessage({ ...valid(), [rank.id]: [first, first] })).toBe(
      `Invalid answers: ${rank.id}: Each option may be ranked once`
    );
    // zod's own wording: only that the one field is named.
    for (const answers of [
      { ...valid(), [agree.id]: false },
      { ...valid(), [fullName.id]: '' },
      { ...valid(), [email.id]: 'not an address' },
    ]) {
      const message = serverMessage(answers);
      const [, field] = /^Invalid answers: ([^:;]+): [^;]+$/.exec(message) ?? [];
      expect(Object.keys(answers)).toContain(field);
    }
  });
});
