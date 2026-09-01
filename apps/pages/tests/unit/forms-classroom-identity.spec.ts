import { test, expect } from '@playwright/test';
import type { FormField } from '@classmoji/services/form-contract';

import {
  classroomIdentityPlan,
  coerceValue,
  defaultValueFor,
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
