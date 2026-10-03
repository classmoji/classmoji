import { test, expect } from '@playwright/test';
import {
  IDENTITY_QUESTION_TYPES,
  assertFieldsAllowedForAccess,
  isIdentityQuestion,
  parseFormDefinition,
  type FormField,
  type FormOption,
} from '@classmoji/services/form-contract';

import { FORM_PRESETS, QUESTION_PRESETS, presetByKey } from '../../app/components/forms/presets.ts';
import { identityPlan } from '../../app/components/forms/answerCoerce.ts';

/**
 * The form templates (New Form drawer) and the question presets (the
 * builder's "Add a preset" row).
 *
 * ── What is pinned ─────────────────────────────────────────────────────────
 *  - every preset is a definition the contract stores, and its
 *    `requiresClassroom` flag says exactly what the access rule says;
 *  - every call mints fresh ids, so two forms never share field ids;
 *  - the Gender and Project bidding wording, word for word: the Gender help
 *    text is a promise to students, and "What matters more to you?" with its
 *    three labels is the shape `suggestConfig` recognizes to pre-set the
 *    Shifts priority rule, so a reworded label silently loses that default;
 *  - the pitched-idea dropdown shares the ranked question's option ids, which
 *    the team-set owner rule depends on;
 *  - no course name in any preset string (product rule: presets are general).
 *
 * Pure functions, so this runs in the Playwright runner with no browser and no
 * dev stack, like `forms-field-type-coverage.spec.ts`.
 */

const GENDER_HELP =
  'Optional. Used only so no one is placed as the only person of their gender on a team. ' +
  'Only course staff can see it; teammates never do. Skipping it changes nothing about your ' +
  'placement.';

const questionPreset = (key: string) => {
  const preset = QUESTION_PRESETS.find(entry => entry.key === key);
  if (!preset) throw new Error(`no question preset '${key}'`);
  return preset;
};

const optionsOf = (field: FormField): FormOption[] => (field.options as FormOption[]) ?? [];
const labelsOf = (field: FormField): string[] => optionsOf(field).map(option => option.label);
const byLabel = (fields: FormField[], label: string): FormField => {
  const found = fields.find(field => field.label === label);
  if (!found) throw new Error(`no field labelled ${JSON.stringify(label)}`);
  return found;
};

const ALL_PRESETS = [
  ...FORM_PRESETS.map(preset => ({
    name: `form preset ${preset.key}`,
    requiresClassroom: preset.requiresClassroom,
    fields: preset.fields,
  })),
  ...QUESTION_PRESETS.map(preset => ({
    name: `question preset ${preset.key}`,
    requiresClassroom: preset.requiresClassroom,
    fields: preset.fields,
  })),
];

test.describe('every preset', () => {
  for (const preset of ALL_PRESETS) {
    test(`${preset.name} parses, and its classroom flag matches the access rule`, () => {
      const fields = preset.fields();
      expect(() => parseFormDefinition(fields)).not.toThrow();

      const parsed = parseFormDefinition(fields).fields;
      expect(() => assertFieldsAllowedForAccess(parsed, 'CLASSROOM')).not.toThrow();
      if (preset.requiresClassroom) {
        expect(() => assertFieldsAllowedForAccess(parsed, 'PUBLIC')).toThrow();
      } else {
        expect(() => assertFieldsAllowedForAccess(parsed, 'PUBLIC')).not.toThrow();
      }
    });

    test(`${preset.name} mints fresh ids on every call`, () => {
      const idsOf = (fields: FormField[]) =>
        fields.flatMap(field => [field.id, ...optionsOf(field).map(option => option.id)]);
      const first = new Set(idsOf(preset.fields()));
      const second = idsOf(preset.fields());
      expect(second.filter(id => first.has(id))).toEqual([]);
    });
  }

  test('no preset string names a course', () => {
    // Ids are left out: a random uuid is not a string anyone reads.
    const text = JSON.stringify(
      [
        FORM_PRESETS.map(({ label, blurb, suggestedTitle, fields }) => ({
          label,
          blurb,
          suggestedTitle,
          fields: fields(),
        })),
        QUESTION_PRESETS.map(({ label, hint, fields }) => ({ label, hint, fields: fields() })),
      ],
      (key, value) => (key === 'id' || key === 'options_from' ? undefined : value)
    );
    expect(text).not.toMatch(/\bcs\s?\d{2,3}\b|dartmouth|\b2[0-9][FWSX]\b/i);
  });

  test('Project bidding is offered in both places, and only on a classroom form', () => {
    const form = presetByKey('project-bidding');
    expect(form.key).toBe('project-bidding');
    expect(form.label).toBe('Project bidding');
    expect(form.access).toBe('CLASSROOM');
    expect(form.requiresClassroom).toBe(true);
    expect(questionPreset('project-bidding').requiresClassroom).toBe(true);
    expect(questionPreset('gender').requiresClassroom).toBe(false);

    // One field list behind both entries.
    const shape = (fields: FormField[]) =>
      fields.map(field => [field.type, field.label, labelsOf(field)]);
    expect(shape(form.fields())).toEqual(shape(questionPreset('project-bidding').fields()));
  });
});

test.describe('Gender', () => {
  test('the question, its help text and its options, word for word', () => {
    const [question, describe, ...rest] = parseFormDefinition(
      questionPreset('gender').fields()
    ).fields;
    expect(rest).toEqual([]);

    expect(question.type).toBe('multiselect');
    expect(question.label).toBe('How do you describe your gender?');
    expect(question.help).toBe(GENDER_HELP);
    expect(question.required).toBe(false);
    expect(labelsOf(question)).toEqual([
      'Woman',
      'Man',
      'Non-binary',
      'Prefer to self-describe',
      'Prefer not to say',
    ]);

    expect(describe.type).toBe('short_text');
    expect(describe.label).toBe("If you'd like, describe it in your own words");
    expect(describe.required).toBe(false);
  });

  test('only "Prefer not to say" is exclusive', () => {
    const [question] = parseFormDefinition(questionPreset('gender').fields()).fields;
    expect(
      optionsOf(question)
        .filter(option => option.exclusive === true)
        .map(option => option.label)
    ).toEqual(['Prefer not to say']);
    // The flag is stored as `true` or not at all.
    for (const option of optionsOf(question)) {
      expect(option.exclusive === true || !('exclusive' in option)).toBe(true);
    }
  });

  test('both questions are identity questions, of types that may carry the flag', () => {
    const fields = parseFormDefinition(questionPreset('gender').fields()).fields;
    for (const field of fields) {
      expect(isIdentityQuestion(field), String(field.label)).toBe(true);
      expect(IDENTITY_QUESTION_TYPES).toContain(field.type);
    }
  });

  test('the self-description is never taken for the respondent name', () => {
    // `identityPlan` lifts a short_text whose label says "name" into the
    // response's name column, which no identity mask covers. The flag is
    // removed first so this checks the WORDING, not the flag's own skip.
    const fields = parseFormDefinition(questionPreset('gender').fields()).fields.map(
      field => ({ ...field, identity_question: undefined }) as FormField
    );
    expect(identityPlan(fields).nameFieldId).toBeNull();
  });
});

test.describe('Project bidding', () => {
  const parsed = () => parseFormDefinition(questionPreset('project-bidding').fields()).fields;

  test('the questions, in order, word for word', () => {
    expect(parsed().map(field => [field.type, field.label, field.required])).toEqual([
      ['dropdown', 'Did you pitch one of these projects? If so, which one?', false],
      ['ranked_choice', "Rank the projects you'd like to work on", true],
      ['roster_select', 'Who would you like to work with?', false],
      ['roster_select', "Anyone you'd rather not work with?", false],
      ['dropdown', 'What matters more to you?', false],
      ['long_text', 'Anything else we should know?', false],
    ]);
  });

  test('"What matters more to you?" has exactly its three options', () => {
    expect(labelsOf(byLabel(parsed(), 'What matters more to you?'))).toEqual([
      'The project',
      'The people',
      'Both equally',
    ]);
  });

  test('the pitched-idea dropdown takes its options from the ranked question, ids included', () => {
    const fields = parsed();
    const ranked = byLabel(fields, "Rank the projects you'd like to work on");
    const pitched = byLabel(fields, 'Did you pitch one of these projects? If so, which one?');

    expect(pitched.options_from).toBe(ranked.id);
    expect(optionsOf(pitched)).toEqual(optionsOf(ranked));
    expect(ranked.ranks).toBe(3);
    expect(optionsOf(ranked).length).toBeGreaterThanOrEqual(3);
  });

  test('the link survives an edit of the project list', () => {
    // The instructor replaces the placeholder projects; the next save copies
    // the new list into the pitched-idea dropdown.
    const fields = questionPreset('project-bidding').fields();
    const ranked = byLabel(fields, "Rank the projects you'd like to work on");
    const edited = fields.map(field =>
      field.id === ranked.id
        ? { ...field, options: [{ label: 'Tide pools' }, { label: 'Night sky' }], ranks: 2 }
        : field
    );

    const saved = parseFormDefinition(edited).fields;
    const pitched = byLabel(saved, 'Did you pitch one of these projects? If so, which one?');
    expect(optionsOf(pitched)).toEqual(
      optionsOf(byLabel(saved, "Rank the projects you'd like to work on"))
    );
    expect(labelsOf(pitched)).toEqual(['Tide pools', 'Night sky']);
  });

  test('both people pickers take several classmates from the roster', () => {
    for (const label of [
      'Who would you like to work with?',
      "Anyone you'd rather not work with?",
    ]) {
      const field = byLabel(parsed(), label);
      expect(field.optionSource, label).toBe('roster');
      expect(field.multiple, label).toBe(true);
    }
    expect(byLabel(parsed(), "Anyone you'd rather not work with?").help).toBe(
      'Only course staff see this.'
    );
  });

  test('no Project bidding question is an identity question', () => {
    for (const field of parsed()) expect(isIdentityQuestion(field)).toBe(false);
  });
});
