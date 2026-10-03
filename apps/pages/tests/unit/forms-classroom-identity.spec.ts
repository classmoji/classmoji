import { test, expect } from '@playwright/test';
import { z } from 'zod';
import {
  buildResponseSchema,
  parseAnswers,
  parseFormDefinition,
  type FormField,
} from '@classmoji/services/form-contract';

import {
  classroomIdentityPlan,
  coerceAnswers,
  coerceValue,
  defaultValueFor,
  exclusiveSelection,
  extractIdentity,
  friendlyErrorMap,
  identityPlan,
  visibleClassroomFields,
} from '../../app/components/forms/answerCoerce.ts';

/**
 * The two pure decisions the classroom fill path rests on.
 *
 * ── Why these are unit-tested ──────────────────────────────────────────────
 * `classroomIdentityPlan` is called TWICE per submission — once by the loader,
 * to decide which questions the page shows, and once by the action, to decide
 * which answers the server writes. Those two calls must agree exactly: a field
 * hidden by one and not answered by the other is a required question nobody can
 * satisfy. The agreement is guaranteed by it being one deterministic function
 * of (fields, identity), which is a property an end-to-end test can only ever
 * sample.
 *
 * `coerceValue` for `roster_select` is here because the type has two answer
 * SHAPES behind one name, and getting the empty case wrong is invisible until
 * somebody submits a form having touched nothing.
 *
 * `identityPlan` and `classroomIdentityPlan` both skip identity questions
 * (`identity_question: true`): an identity answer is never lifted into the
 * response's name/email columns, and never answered from the account. The
 * multiselect `exclusive` rule is here too, because the checkbox logic and the
 * refusal message it mirrors are both pure.
 *
 * No browser, no dev stack — same runner arrangement as `forms-origin.spec.ts`.
 */

const field = (patch: Record<string, unknown>, index = 1): FormField =>
  ({
    id: `dddddddd-dddd-4ddd-8ddd-dddddddddd0${index}`,
    required: false,
    ...patch,
  }) as unknown as FormField;

const ME = { name: 'Maya Chen', email: 'maya.chen@dartmouth.edu' };

test.describe('classroomIdentityPlan', () => {
  test('answers the definition’s own email question from the account', () => {
    const email = field({ type: 'email', label: 'School email', required: true });
    const plan = classroomIdentityPlan([email], ME);

    expect(plan.hiddenIds).toEqual([email.id]);
    expect(plan.injected[email.id]).toBe(ME.email);
  });

  test('answers a name question, but only when the label IS the question', () => {
    const own = field({ type: 'short_text', label: 'Full name' }, 1);
    const project = field({ type: 'short_text', label: 'Project name' }, 2);
    const partner = field({ type: 'short_text', label: 'Your partner’s name' }, 3);
    const team = field({ type: 'short_text', label: 'Team name' }, 4);

    const plan = classroomIdentityPlan([own, project, partner, team], ME);

    expect(plan.hiddenIds).toEqual([own.id]);
    expect(plan.injected[own.id]).toBe(ME.name);
    // The heuristic that only picked a display fallback elsewhere would have
    // matched all three of these on `\bname\b`, and here that would DELETE a
    // real question and answer it with the wrong thing.
    expect(plan.injected[project.id]).toBeUndefined();
    expect(plan.injected[partner.id]).toBeUndefined();
    expect(plan.injected[team.id]).toBeUndefined();
  });

  test.describe('every label spelling that IS the question', () => {
    for (const label of ['Name', 'name', 'Your name', 'Full Name', 'Preferred name', 'Name *']) {
      test(`"${label}" is answered from the account`, () => {
        const own = field({ type: 'short_text', label });
        expect(classroomIdentityPlan([own], ME).injected[own.id]).toBe(ME.name);
      });
    }
  });

  test('leaves a question visible when the account cannot answer it', () => {
    // A domain-restricted email and an account that is not on that domain. The
    // safety valve: hiding this would produce a form whose hidden answer fails
    // validation and which nobody can do anything about.
    const restricted = field({
      type: 'email',
      label: 'Dartmouth email',
      required: true,
      domain: 'dartmouth.edu',
    });

    expect(classroomIdentityPlan([restricted], ME).hiddenIds).toEqual([restricted.id]);
    expect(
      classroomIdentityPlan([restricted], { name: 'Sam', email: 'sam@gmail.com' }).hiddenIds
    ).toEqual([]);
  });

  test('leaves everything visible for an account with no name', () => {
    const own = field({ type: 'short_text', label: 'Name', required: true });
    const plan = classroomIdentityPlan([own], { name: '', email: ME.email });
    expect(plan.hiddenIds).toEqual([]);
  });

  test('touches nothing that is not an identity question', () => {
    const note = field({ type: 'long_text', label: 'Anything else?' }, 1);
    const roster = field({ type: 'roster_select', label: 'Your partner', options: [] }, 2);

    const plan = classroomIdentityPlan([note, roster], ME);
    expect(plan.hiddenIds).toEqual([]);
    expect(visibleClassroomFields([note, roster], plan)).toHaveLength(2);
  });

  test('visibleClassroomFields removes exactly the hidden ids', () => {
    const email = field({ type: 'email', label: 'School email' }, 1);
    const note = field({ type: 'long_text', label: 'Anything else?' }, 2);

    const plan = classroomIdentityPlan([email, note], ME);
    expect(visibleClassroomFields([email, note], plan).map(f => f.id)).toEqual([note.id]);
  });
});

test.describe('roster_select has two answer shapes', () => {
  const single = field({ type: 'roster_select', multiple: false }, 1);
  const many = field({ type: 'roster_select', multiple: true }, 2);

  test('an untouched control starts as the shape its answer schema wants', () => {
    expect(defaultValueFor(single)).toBe('');
    expect(defaultValueFor(many)).toEqual([]);
  });

  test('blank means "nothing chosen", in each shape', () => {
    expect(coerceValue(single, '')).toBeUndefined();
    // NOT undefined: a multi-pick answer is a list, and an empty list is how
    // "I picked nobody" is spelled. `undefined` would make an optional field
    // absent and a required one fail with the wrong reason.
    expect(coerceValue(many, '')).toEqual([]);
  });

  test('a chosen person is kept, and empty slots are dropped', () => {
    expect(coerceValue(single, 'user-1')).toBe('user-1');
    expect(coerceValue(many, ['user-1', '', 'user-2'])).toEqual(['user-1', 'user-2']);
    // A single value where a list is expected — what a form-encoded post gives
    // for a one-item multi-select.
    expect(coerceValue(many, 'user-1')).toEqual(['user-1']);
  });
});

test.describe('identity questions are never the respondent’s identity', () => {
  test('identityPlan skips a flagged name question', () => {
    const chosen = field({ type: 'short_text', label: 'Chosen name', identity_question: true }, 1);
    const plan = identityPlan([chosen]);
    expect(plan.nameFieldId).toBeNull();
  });

  test('and picks the next unflagged one instead', () => {
    const chosen = field({ type: 'short_text', label: 'Chosen name', identity_question: true }, 1);
    const full = field({ type: 'short_text', label: 'Full name' }, 2);
    const email = field({ type: 'email', label: 'School email' }, 3);

    const plan = identityPlan([chosen, full, email]);
    expect(plan.nameFieldId).toBe(full.id);
    expect(plan.emailFieldId).toBe(email.id);
  });

  test('a flagged answer never becomes the name column', () => {
    const chosen = field({ type: 'short_text', label: 'Chosen name', identity_question: true }, 1);
    const identity = extractIdentity(
      [chosen],
      { [chosen.id]: 'Answer Staff Must Not See' },
      { email: 'sam@example.edu', name: 'Sam Rivera' }
    );
    expect(identity).toEqual({ email: 'sam@example.edu', name: 'Sam Rivera' });

    // With no fallback the column is empty, not the answer.
    expect(extractIdentity([chosen], { [chosen.id]: 'Answer Staff Must Not See' }).name).toBeNull();
  });

  test('the flag survives the contract, so the stored definition is what is checked', () => {
    const [chosen] = parseFormDefinition([
      { type: 'short_text', label: 'Chosen name', identity_question: true },
    ]).fields;
    expect(identityPlan([chosen]).nameFieldId).toBeNull();
  });

  test('classroomIdentityPlan leaves a flagged name question for the member to answer', () => {
    const preferred = field(
      { type: 'short_text', label: 'Preferred name', identity_question: true },
      1
    );
    const plan = classroomIdentityPlan([preferred], ME);

    expect(plan.hiddenIds).toEqual([]);
    expect(plan.injected[preferred.id]).toBeUndefined();
    expect(visibleClassroomFields([preferred], plan)).toHaveLength(1);
  });
});

test.describe('multiselect exclusive options', () => {
  const definition = parseFormDefinition([
    {
      type: 'multiselect',
      label: 'How do you describe your gender? (pick any that apply)',
      identity_question: true,
      options: [
        { label: 'Woman' },
        { label: 'Man' },
        { label: 'Non-binary' },
        { label: 'Prefer not to say', exclusive: true },
      ],
    },
  ]);
  const [question] = definition.fields;
  const options = question.options as Array<{ id: string; label: string; exclusive?: true }>;
  const [woman, man, nonBinary, preferNot] = options.map(option => option.id);

  test('ticking the exclusive option leaves only it', () => {
    expect(exclusiveSelection(options, [woman, nonBinary, preferNot], preferNot)).toEqual([
      preferNot,
    ]);
  });

  test('ticking any other option drops the exclusive one', () => {
    expect(exclusiveSelection(options, [man, preferNot], man)).toEqual([man]);
    expect(exclusiveSelection(options, [woman, nonBinary], nonBinary)).toEqual([woman, nonBinary]);
  });

  test('a field with no exclusive option is left alone', () => {
    const plain = options.map(({ id, label }) => ({ id, label }));
    expect(exclusiveSelection(plain, [woman, preferNot], preferNot)).toEqual([woman, preferNot]);
  });

  test('the renderer’s validation refuses a combination on the field, with the server’s message', () => {
    const message = '"Prefer not to say" can\'t be combined with other choices';

    // What the renderer's resolver runs: coerce, then the contract's schema
    // under the friendly error map.
    const client = z
      .object({ answers: buildResponseSchema(definition.fields) })
      .safeParse(
        { answers: coerceAnswers(definition.fields, { [question.id]: [woman, preferNot] }) },
        { errorMap: friendlyErrorMap }
      );
    expect(client.success).toBe(false);
    expect(
      client.error?.issues.map(issue => ({ path: issue.path, message: issue.message }))
    ).toEqual([{ path: ['answers', question.id], message }]);

    // What the server runs. Same field id, same words.
    let issues: z.ZodIssue[] = [];
    try {
      parseAnswers(definition.fields, { [question.id]: [woman, preferNot] });
    } catch (error) {
      issues = (error as { issues?: z.ZodIssue[] }).issues ?? [];
    }
    expect(issues.map(issue => ({ path: issue.path, message: issue.message }))).toEqual([
      { path: [question.id], message },
    ]);

    // The exclusive option alone, and the others together, are answers.
    expect(parseAnswers(definition.fields, { [question.id]: [preferNot] })).toEqual({
      [question.id]: [preferNot],
    });
    expect(parseAnswers(definition.fields, { [question.id]: [woman, man] })).toEqual({
      [question.id]: [woman, man],
    });
  });
});
