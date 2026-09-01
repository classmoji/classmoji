import { test, expect } from '@playwright/test';
import type { FormField } from '@classmoji/services/form-contract';

import { identityPlan } from '../../app/components/forms/answerCoerce.ts';
import { answerColumnFields } from '../../app/components/forms/answerFormat.ts';

/**
 * Which of a form's questions become COLUMNS in the staff responses table.
 *
 * ── Why this is a unit test ────────────────────────────────────────────────
 * The rule is a pure function of the definition, and the property that matters
 * is an AGREEMENT between two places: `extractIdentity` lifts a response's name
 * and email out of the answers using the ids `identityPlan` names, and the table
 * shows those two as its own Name and Email columns. If the column rule
 * disagreed with the identity rule by so much as one field, the table would
 * either print the same answer twice (which is what it did — three of the CS52
 * waitlist's five columns were duplicates, and the table outgrew its container
 * because of it) or hide a question that is not shown anywhere else.
 *
 * An end-to-end test can only sample one definition's worth of that. These
 * assert the rule itself, including the case with no identity questions at all,
 * which is the one a screenshot of a real form will never show.
 */

let seq = 0;
const field = (patch: Record<string, unknown>): FormField =>
  ({
    id: `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(++seq).padStart(2, '0')}`,
    required: false,
    ...patch,
  }) as unknown as FormField;

/** The CS52 waitlist, which is the shape that produced the bug. */
const waitlist = () => {
  const banner = field({ type: 'banner', text: 'FIFO, no guarantees.', tone: 'info' });
  const name = field({ type: 'short_text', label: 'Full name', required: true });
  const email = field({ type: 'email', label: 'School email', required: true });
  const scale = field({
    type: 'opinion_scale',
    label: 'How familiar are you with the material?',
    scale: { min: 1, max: 10 },
  });
  const hopes = field({ type: 'long_text', label: 'What are you hoping to get out of the class?' });
  return { banner, name, email, scale, hopes, fields: [banner, name, email, scale, hopes] };
};

test.describe('answerColumnFields', () => {
  test('drops the questions already standing as the Name and Email columns', () => {
    const form = waitlist();
    const columns = answerColumnFields(form.fields, 3);

    expect(columns.map(column => column.label)).toEqual([
      'How familiar are you with the material?',
      'What are you hoping to get out of the class?',
    ]);
  });

  test('drops exactly what identityPlan claims — no second heuristic', () => {
    const form = waitlist();
    const plan = identityPlan(form.fields);
    const columnIds = new Set(answerColumnFields(form.fields, 3).map(column => column.id));

    // The agreement, stated directly: whatever the identity rule consumes is
    // what the table stops showing twice, and nothing else.
    expect(plan.emailFieldId).toBe(form.email.id);
    expect(plan.nameFieldId).toBe(form.name.id);
    expect(columnIds.has(form.email.id)).toBe(false);
    expect(columnIds.has(form.name.id)).toBe(false);
  });

  test('a form with dedicated identity inputs loses no columns', () => {
    // No email question and no name-ish short text: the identity came from the
    // renderer's own inputs, so every question is a candidate — none of them is
    // being shown anywhere else on the row.
    const fields = [
      field({ type: 'dropdown', label: 'Which section?', options: [] }),
      field({ type: 'switch', label: 'I have read the syllabus' }),
    ];

    expect(answerColumnFields(fields, 3).map(column => column.label)).toEqual([
      'Which section?',
      'I have read the syllabus',
    ]);
  });

  test('display blocks and wide fields are still not columns', () => {
    const fields = [
      field({ type: 'heading', label: 'Part one' }),
      field({ type: 'matrix', label: 'Rate each', matrix: { rows: [], columns: [] } }),
      field({ type: 'number', label: 'How many terms?' }),
    ];

    expect(answerColumnFields(fields, 3).map(column => column.label)).toEqual(['How many terms?']);
  });

  test('the cap counts columns that survived, not questions that were asked', () => {
    // The identity questions come out FIRST and the limit applies to what is
    // left. Slicing first would have spent two of the three slots on the
    // duplicates and shown one real answer.
    const form = waitlist();
    const extra = field({ type: 'short_text', label: 'Anything else?' });

    expect(answerColumnFields([...form.fields, extra], 3).map(column => column.label)).toEqual([
      'How familiar are you with the material?',
      'What are you hoping to get out of the class?',
      'Anything else?',
    ]);
    expect(answerColumnFields([...form.fields, extra], 2)).toHaveLength(2);
  });
});
