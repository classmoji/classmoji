/**
 * The versioned field-definition contract (formContract.ts).
 *
 * Pure — no database, no env. Covers a valid definition for EVERY field type in
 * the registry (so a new type without tests is visible), the rejections the
 * server must make whatever the client sent, and the answer schemas the
 * renderer and the submit path share.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFINITION_VERSION,
  FIELD_TYPES,
  FIELD_TYPE_REGISTRY,
  CLASSROOM_ONLY_FIELD_TYPES,
  FORM_LIMITS,
  FORM_ANSWERS_INVALID,
  FORM_ANSWERS_TOO_LARGE,
  FORM_DEFINITION_INVALID,
  FORM_DEFINITION_TOO_LARGE,
  FORM_FIELD_ACCESS_VIOLATION,
  FORM_REPEAT_CONTEXT_MISSING,
  IDENTITY_QUESTION_TYPES,
  answersByteSize,
  assertFieldsAllowedForAccess,
  assertGalleryRoles,
  galleryRoleOf,
  buildResponseSchema,
  exceedsMaxDepth,
  flattenFields,
  identityQuestionIds,
  isIdentityQuestion,
  parseAnswers,
  parseFormDefinition,
  requiresResolvedContext,
  resolveSharedOptions,
  withoutAnswers,
  type FormField,
  type FormOption,
} from '../formContract.ts';

/** One valid raw definition entry per registry type, keyed by type. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  short_text: { type: 'short_text', label: 'Full Name', required: true },
  long_text: { type: 'long_text', label: 'What do you hope to get out of the class?' },
  email: { type: 'email', label: 'Dartmouth Email', required: true, domain: 'dartmouth.edu' },
  number: { type: 'number', label: 'Class year', min: 2020, max: 2035 },
  dropdown: { type: 'dropdown', label: 'Track', options: ['Design', 'Dev'] },
  multiselect: {
    type: 'multiselect',
    label: 'Tools used',
    options: [{ label: 'React' }, { label: 'Node' }, 'Figma'],
  },
  switch: { type: 'switch', label: 'I understand there is no Canvas', required: true },
  opinion_scale: {
    type: 'opinion_scale',
    label: 'Familiarity',
    scale: { min: 1, max: 10, minLabel: 'Never tried it', maxLabel: 'In my sleep' },
  },
  roster_select: {
    type: 'roster_select',
    label: 'People you would like to work with',
    optionSource: 'roster',
    multiple: true,
    options: [{ label: 'Jordan Okafor' }, { label: 'Sam Whitfield' }],
  },
  ranked_choice: {
    type: 'ranked_choice',
    label: 'Rank your project choices',
    options: ['Course Copilot', 'Trail Conditions', 'Study Buddy'],
    ranks: 3,
  },
  matrix: {
    type: 'matrix',
    label: 'Teamwork',
    matrix: {
      rows: ['Attended meetings', 'Communicated clearly'],
      columns: [{ label: 'Never' }, { label: 'Sometimes', description: 'Most weeks' }, 'Always'],
      required_rows: 'all',
    },
  },
  repeat_group: {
    type: 'repeat_group',
    label: 'Review each teammate',
    repeat: {
      over: 'teammates',
      scope: { by: 'tag', tag_id: '11111111-1111-4111-8111-111111111111' },
      exclude_self: true,
      require_all_targets: true,
    },
    fields: [
      { type: 'opinion_scale', label: 'Contribution', scale: { min: 1, max: 5 }, required: true },
      { type: 'long_text', label: 'Comments' },
    ],
  },
  heading: { type: 'heading', text: 'About you' },
  paragraph: { type: 'paragraph', text: 'Tell us a little about your background.' },
  banner: { type: 'banner', text: 'This waitlist is FIFO.', tone: 'info' },
};

const parseOne = (raw: Record<string, unknown>): FormField =>
  parseFormDefinition([raw]).fields[0] as FormField;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

describe('formContract — definitions', () => {
  it('has a sample for every registry type (a new type must add one)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...FIELD_TYPES].sort());
  });

  it.each(FIELD_TYPES)('accepts a valid %s definition', type => {
    const field = parseOne(SAMPLES[type]);
    expect(field.type).toBe(type);
    expect(field.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('wraps a bare field array into the versioned envelope', () => {
    const definition = parseFormDefinition([SAMPLES.short_text]);
    expect(definition.definition_version).toBe(DEFINITION_VERSION);
    expect(definition.fields).toHaveLength(1);
  });

  it('accepts the envelope form too, and round-trips minted ids', () => {
    const once = parseFormDefinition([SAMPLES.dropdown]);
    const twice = parseFormDefinition(once);
    expect(twice.fields[0].id).toBe(once.fields[0].id);
    expect((twice.fields[0].options as { id: string }[])[0].id).toBe(
      (once.fields[0].options as { id: string }[])[0].id
    );
  });

  it('normalizes bare-string options into {id,label} objects', () => {
    const field = parseOne(SAMPLES.dropdown);
    expect(field.options).toEqual([
      { id: expect.any(String), label: 'Design' },
      { id: expect.any(String), label: 'Dev' },
    ]);
  });

  it('keeps option descriptions (the rubric text on a matrix column)', () => {
    const field = parseOne(SAMPLES.matrix);
    const columns = (field.matrix as { columns: { description?: string }[] }).columns;
    expect(columns[1].description).toBe('Most weeks');
  });

  it('rejects an unknown field type', () => {
    expect(codeOf(() => parseFormDefinition([{ type: 'file_upload', label: 'CV' }]))).toBe(
      FORM_DEFINITION_INVALID
    );
  });

  it('rejects a nested repeat_group', () => {
    const nested = {
      ...SAMPLES.repeat_group,
      fields: [SAMPLES.repeat_group],
    };
    let message = '';
    try {
      parseFormDefinition([nested]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("'repeat_group' is not allowed inside a repeat group");
  });

  it('rejects duplicate field ids across the definition', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(
      codeOf(() =>
        parseFormDefinition([
          { ...SAMPLES.short_text, id },
          { ...SAMPLES.long_text, id },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects a repeat-group child id that collides with a top-level field id', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const group = {
      ...SAMPLES.repeat_group,
      fields: [{ ...SAMPLES.long_text, id }],
    };
    expect(codeOf(() => parseFormDefinition([{ ...SAMPLES.short_text, id }, group]))).toBe(
      FORM_DEFINITION_INVALID
    );
  });

  it('rejects more than MAX_FIELDS fields, counting repeat-group children', () => {
    const many = Array.from({ length: FORM_LIMITS.MAX_FIELDS + 1 }, (_, index) => ({
      type: 'short_text',
      label: `Q${index}`,
    }));
    expect(codeOf(() => parseFormDefinition(many))).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects more than MAX_OPTIONS options on a field', () => {
    const options = Array.from({ length: FORM_LIMITS.MAX_OPTIONS + 1 }, (_, i) => `Option ${i}`);
    expect(codeOf(() => parseFormDefinition([{ type: 'dropdown', label: 'Pick', options }]))).toBe(
      FORM_DEFINITION_INVALID
    );
  });

  it('rejects a matrix over the row and column caps', () => {
    const rows = Array.from({ length: FORM_LIMITS.MAX_MATRIX_ROWS + 1 }, (_, i) => `Row ${i}`);
    const columns = Array.from({ length: FORM_LIMITS.MAX_MATRIX_COLUMNS + 1 }, (_, i) => `C${i}`);
    expect(
      codeOf(() =>
        parseFormDefinition([
          { type: 'matrix', label: 'Grid', matrix: { rows, columns: ['A', 'B'] } },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
    expect(
      codeOf(() =>
        parseFormDefinition([
          { type: 'matrix', label: 'Grid', matrix: { rows: ['A', 'B'], columns } },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects an over-long label and over-long help text', () => {
    expect(
      codeOf(() =>
        parseFormDefinition([
          { type: 'short_text', label: 'x'.repeat(FORM_LIMITS.MAX_LABEL_CHARS + 1) },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
    expect(
      codeOf(() =>
        parseFormDefinition([
          { type: 'short_text', label: 'Name', help: 'x'.repeat(FORM_LIMITS.MAX_HELP_CHARS + 1) },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects a definition over the serialized byte cap', () => {
    // Under the field cap and under every per-field cap, but too big overall.
    const fields = Array.from({ length: 40 }, (_, index) => ({
      type: 'dropdown',
      label: `Q${index}`,
      options: Array.from({ length: 30 }, (_, o) => ({
        label: `Option ${o}`,
        description: 'd'.repeat(1900),
      })),
    }));
    expect(codeOf(() => parseFormDefinition(fields))).toBe(FORM_DEFINITION_TOO_LARGE);
  });

  it('rejects ranks exceeding the option count', () => {
    expect(
      codeOf(() =>
        parseFormDefinition([
          { type: 'ranked_choice', label: 'Rank', options: ['A', 'B'], ranks: 5 },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects an unknown key on a field (strict definitions)', () => {
    expect(
      codeOf(() => parseFormDefinition([{ type: 'short_text', label: 'Name', kind: 'waitlist' }]))
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects scope.by=tag without a tag_id', () => {
    const group = {
      ...SAMPLES.repeat_group,
      repeat: { ...(SAMPLES.repeat_group.repeat as object), scope: { by: 'tag' } },
    };
    expect(codeOf(() => parseFormDefinition([group]))).toBe(FORM_DEFINITION_INVALID);
  });

  it('flattenFields reaches repeat-group children', () => {
    const { fields } = parseFormDefinition([SAMPLES.short_text, SAMPLES.repeat_group]);
    expect(flattenFields(fields)).toHaveLength(4);
  });
});

describe('formContract — access modes', () => {
  it('derives the classroom-only set from the registry', () => {
    expect([...CLASSROOM_ONLY_FIELD_TYPES].sort()).toEqual(['repeat_group', 'roster_select']);
    for (const type of CLASSROOM_ONLY_FIELD_TYPES) {
      expect(FIELD_TYPE_REGISTRY[type].classroomOnly).toBe(true);
    }
  });

  it.each(CLASSROOM_ONLY_FIELD_TYPES)('rejects %s on a PUBLIC form', type => {
    const { fields } = parseFormDefinition([SAMPLES[type]]);
    expect(codeOf(() => assertFieldsAllowedForAccess(fields, 'PUBLIC'))).toBe(
      FORM_FIELD_ACCESS_VIOLATION
    );
    expect(() => assertFieldsAllowedForAccess(fields, 'CLASSROOM')).not.toThrow();
  });

  it('rejects a classroom-only type buried inside a repeat group on a PUBLIC form', () => {
    const group = {
      ...SAMPLES.repeat_group,
      fields: [SAMPLES.roster_select],
    };
    const { fields } = parseFormDefinition([group]);
    expect(codeOf(() => assertFieldsAllowedForAccess(fields, 'PUBLIC'))).toBe(
      FORM_FIELD_ACCESS_VIOLATION
    );
  });

  it('allows an all-public definition on a PUBLIC form', () => {
    const publicTypes = FIELD_TYPES.filter(type => !FIELD_TYPE_REGISTRY[type].classroomOnly);
    const { fields } = parseFormDefinition(publicTypes.map(type => SAMPLES[type]));
    expect(() => assertFieldsAllowedForAccess(fields, 'PUBLIC')).not.toThrow();
  });
});

describe('formContract — answers', () => {
  const waitlist = parseFormDefinition([
    SAMPLES.banner,
    SAMPLES.short_text,
    SAMPLES.email,
    SAMPLES.opinion_scale,
    SAMPLES.long_text,
  ]).fields;

  const byType = (fields: FormField[], type: string) =>
    fields.find(field => field.type === type) as FormField;

  it('accepts a complete answer set', () => {
    const answers = {
      [byType(waitlist, 'short_text').id]: 'Maya Chen',
      [byType(waitlist, 'email').id]: 'maya.r.chen.28@dartmouth.edu',
      [byType(waitlist, 'opinion_scale').id]: 7,
      [byType(waitlist, 'long_text').id]: 'Ship something real.',
    };
    expect(parseAnswers(waitlist, answers)).toMatchObject({
      [byType(waitlist, 'short_text').id]: 'Maya Chen',
    });
  });

  it('rejects an answer keyed to an unknown field', () => {
    const answers = {
      [byType(waitlist, 'short_text').id]: 'Maya Chen',
      [byType(waitlist, 'email').id]: 'maya.r.chen.28@dartmouth.edu',
      [byType(waitlist, 'opinion_scale').id]: 7,
      'not-a-field': 'smuggled',
    };
    expect(codeOf(() => parseAnswers(waitlist, answers))).toBe(FORM_ANSWERS_INVALID);
  });

  it('rejects an answer keyed to a DISPLAY block', () => {
    const answers = {
      [byType(waitlist, 'short_text').id]: 'Maya Chen',
      [byType(waitlist, 'email').id]: 'maya.r.chen.28@dartmouth.edu',
      [byType(waitlist, 'opinion_scale').id]: 7,
      [byType(waitlist, 'banner').id]: 'x',
    };
    expect(codeOf(() => parseAnswers(waitlist, answers))).toBe(FORM_ANSWERS_INVALID);
  });

  it('requires the required fields and tolerates the optional ones', () => {
    expect(codeOf(() => parseAnswers(waitlist, {}))).toBe(FORM_ANSWERS_INVALID);
    expect(() =>
      parseAnswers(waitlist, {
        [byType(waitlist, 'short_text').id]: 'Maya Chen',
        [byType(waitlist, 'email').id]: 'maya.r.chen.28@dartmouth.edu',
        [byType(waitlist, 'opinion_scale').id]: 7,
      })
    ).not.toThrow();
  });

  it('enforces the email domain restriction', () => {
    expect(
      codeOf(() =>
        parseAnswers(waitlist, {
          [byType(waitlist, 'short_text').id]: 'Maya Chen',
          [byType(waitlist, 'email').id]: 'maya@gmail.com',
          [byType(waitlist, 'opinion_scale').id]: 7,
        })
      )
    ).toBe(FORM_ANSWERS_INVALID);
  });

  it('keeps opinion_scale answers inside the configured range', () => {
    const base = {
      [byType(waitlist, 'short_text').id]: 'Maya Chen',
      [byType(waitlist, 'email').id]: 'maya.r.chen.28@dartmouth.edu',
    };
    expect(
      codeOf(() => parseAnswers(waitlist, { ...base, [byType(waitlist, 'opinion_scale').id]: 11 }))
    ).toBe(FORM_ANSWERS_INVALID);
  });

  it('treats a required switch as an acknowledgment: false is not an answer', () => {
    const { fields } = parseFormDefinition([SAMPLES.switch]);
    expect(codeOf(() => parseAnswers(fields, { [fields[0].id]: false }))).toBe(
      FORM_ANSWERS_INVALID
    );
    expect(() => parseAnswers(fields, { [fields[0].id]: true })).not.toThrow();
  });

  it('validates a matrix answer against its own rows and columns', () => {
    const { fields } = parseFormDefinition([{ ...SAMPLES.matrix, required: true }]);
    const field = fields[0];
    const { rows, columns } = field.matrix as {
      rows: { id: string }[];
      columns: { id: string }[];
    };

    expect(() =>
      parseAnswers(fields, {
        [field.id]: { [rows[0].id]: columns[0].id, [rows[1].id]: columns[2].id },
      })
    ).not.toThrow();

    // A row left out, with required_rows: 'all'.
    expect(
      codeOf(() => parseAnswers(fields, { [field.id]: { [rows[0].id]: columns[0].id } }))
    ).toBe(FORM_ANSWERS_INVALID);
    // A column id that is not a column of this matrix.
    expect(
      codeOf(() =>
        parseAnswers(fields, {
          [field.id]: { [rows[0].id]: rows[1].id, [rows[1].id]: columns[0].id },
        })
      )
    ).toBe(FORM_ANSWERS_INVALID);
    // An unknown row key.
    expect(
      codeOf(() =>
        parseAnswers(fields, {
          [field.id]: {
            [rows[0].id]: columns[0].id,
            [rows[1].id]: columns[0].id,
            'ghost-row': columns[0].id,
          },
        })
      )
    ).toBe(FORM_ANSWERS_INVALID);
    // Not an object at all.
    expect(codeOf(() => parseAnswers(fields, { [field.id]: 'Always' }))).toBe(FORM_ANSWERS_INVALID);
  });

  it("honours required_rows: 'any'", () => {
    const { fields } = parseFormDefinition([
      {
        ...SAMPLES.matrix,
        required: true,
        matrix: { ...(SAMPLES.matrix.matrix as object), required_rows: 'any' },
      },
    ]);
    const field = fields[0];
    const { rows, columns } = field.matrix as {
      rows: { id: string }[];
      columns: { id: string }[];
    };
    expect(() =>
      parseAnswers(fields, { [field.id]: { [rows[0].id]: columns[0].id } })
    ).not.toThrow();
    expect(codeOf(() => parseAnswers(fields, { [field.id]: {} }))).toBe(FORM_ANSWERS_INVALID);
  });

  it('requires exactly `ranks` unique choices when the field is required', () => {
    const { fields } = parseFormDefinition([{ ...SAMPLES.ranked_choice, required: true }]);
    const field = fields[0];
    const ids = (field.options as { id: string }[]).map(option => option.id);

    expect(() => parseAnswers(fields, { [field.id]: ids })).not.toThrow();
    // Duplicate option.
    expect(codeOf(() => parseAnswers(fields, { [field.id]: [ids[0], ids[0], ids[1]] }))).toBe(
      FORM_ANSWERS_INVALID
    );
    // Too few for a required field.
    expect(codeOf(() => parseAnswers(fields, { [field.id]: [ids[0]] }))).toBe(FORM_ANSWERS_INVALID);
    // Not an option of this field.
    expect(codeOf(() => parseAnswers(fields, { [field.id]: [ids[0], ids[1], 'other'] }))).toBe(
      FORM_ANSWERS_INVALID
    );
  });

  it('allows fewer than `ranks` choices when the field is optional', () => {
    const { fields } = parseFormDefinition([SAMPLES.ranked_choice]);
    const ids = (fields[0].options as { id: string }[]).map(option => option.id);
    expect(() => parseAnswers(fields, { [fields[0].id]: [ids[0]] })).not.toThrow();
  });

  it('rejects an answer set over the byte cap before validating it', () => {
    const { fields } = parseFormDefinition([SAMPLES.long_text]);
    expect(
      codeOf(() =>
        parseAnswers(fields, { [fields[0].id]: 'x'.repeat(FORM_LIMITS.MAX_ANSWERS_BYTES + 10) })
      )
    ).toBe(FORM_ANSWERS_TOO_LARGE);
  });
});

// ─── The nesting guard ──────────────────────────────────────────────────────

/**
 * `JSON.parse` accepts far deeper nesting than `JSON.stringify` can walk. A
 * ~40KB body of `[[[[…]]]]` parses fine and then overflows the stack the moment
 * anything serializes it — and a RangeError carries no `code`, so it missed
 * every `error.code === …` branch on the submission paths and surfaced as a 500
 * to an anonymous caller. Denial of service for the price of forty kilobytes.
 *
 * 20,000 is chosen empirically, not decoratively: 5,000 still serializes on this
 * Node, 10,000 does not. Building the value with a loop rather than a recursive
 * helper keeps the TEST from overflowing on its own fixture.
 */
const nested = (depth: number): unknown => {
  let value: unknown = [];
  for (let i = 0; i < depth; i++) value = [value];
  return value;
};

describe('formContract — deeply nested answers', () => {
  it('confirms the hazard is real: JSON.stringify cannot walk the fixture', () => {
    expect(() => JSON.stringify(nested(20_000))).toThrow(RangeError);
  });

  it('sizes an unserializable value as infinite rather than throwing', () => {
    expect(answersByteSize(nested(20_000))).toBe(Number.POSITIVE_INFINITY);
    // And still measures an ordinary one exactly.
    expect(answersByteSize({ a: 'bc' })).toBe(10);
  });

  it('spots excessive depth without recursing itself', () => {
    expect(exceedsMaxDepth(nested(20_000))).toBe(true);
    expect(exceedsMaxDepth(nested(FORM_LIMITS.MAX_ANSWER_DEPTH + 1))).toBe(true);
    expect(exceedsMaxDepth(nested(2))).toBe(false);
    // A cycle is not a hang: the walk stops at the limit like anything else.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(exceedsMaxDepth(cyclic)).toBe(true);
  });

  it('refuses a pathologically nested answer set as TOO_LARGE, never a RangeError', () => {
    const { fields } = parseFormDefinition([SAMPLES.long_text]);
    const answers = { [fields[0].id]: nested(20_000) };

    // The code matters more than the refusal: every submission path branches on
    // it, and an uncoded error is what became a 500.
    expect(codeOf(() => parseAnswers(fields, answers))).toBe(FORM_ANSWERS_TOO_LARGE);

    let thrown: unknown;
    try {
      parseAnswers(fields, answers);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect((thrown as { code?: string }).code).toBe(FORM_ANSWERS_TOO_LARGE);
  });

  it('still accepts the deepest shape a real form can produce', () => {
    // answers[group][target][field][row] = column — a matrix inside a repeat
    // group, which is the deepest legitimate answer in the product.
    const deepest = { g: { u: { f: { row: 'col' } } } };
    expect(exceedsMaxDepth(deepest)).toBe(false);
  });
});

describe('formContract — repeat groups', () => {
  const { fields } = parseFormDefinition([SAMPLES.repeat_group]);
  const group = fields[0];
  const inner = group.fields as FormField[];
  const scaleId = inner.find(field => field.type === 'opinion_scale')!.id;
  const commentId = inner.find(field => field.type === 'long_text')!.id;

  const alice = 'a0000000-0000-4000-8000-000000000001';
  const bob = 'a0000000-0000-4000-8000-000000000002';
  const ctx = { resolved: { [group.id]: [{ user_id: alice }, { user_id: bob }] } };

  it('reports that the definition needs per-respondent resolution', () => {
    expect(requiresResolvedContext(fields)).toBe(true);
    expect(requiresResolvedContext(parseFormDefinition([SAMPLES.short_text]).fields)).toBe(false);
  });

  it('throws when no resolved context is supplied', () => {
    expect(codeOf(() => buildResponseSchema(fields))).toBe(FORM_REPEAT_CONTEXT_MISSING);
  });

  it('accepts one nested answer object per resolved teammate', () => {
    const answers = {
      [group.id]: {
        [alice]: { [scaleId]: 5, [commentId]: 'Great' },
        [bob]: { [scaleId]: 3 },
      },
    };
    expect(parseAnswers(fields, answers, ctx)).toBeTruthy();
  });

  it('rejects a review aimed at someone who is not a resolved teammate', () => {
    const answers = {
      [group.id]: {
        [alice]: { [scaleId]: 5 },
        [bob]: { [scaleId]: 3 },
        'c0000000-0000-4000-8000-000000000009': { [scaleId]: 1 },
      },
    };
    expect(codeOf(() => parseAnswers(fields, answers, ctx))).toBe(FORM_ANSWERS_INVALID);
  });

  it('requires every resolved teammate when require_all_targets is set', () => {
    const answers = { [group.id]: { [alice]: { [scaleId]: 5 } } };
    expect(codeOf(() => parseAnswers(fields, answers, ctx))).toBe(FORM_ANSWERS_INVALID);
  });

  it('validates the inner fields with their own rules', () => {
    const answers = {
      [group.id]: {
        [alice]: { [scaleId]: 99 },
        [bob]: { [scaleId]: 3 },
      },
    };
    expect(codeOf(() => parseAnswers(fields, answers, ctx))).toBe(FORM_ANSWERS_INVALID);
  });

  it('rejects an unknown key inside a teammate block', () => {
    const answers = {
      [group.id]: {
        [alice]: { [scaleId]: 5, sneaky: 1 },
        [bob]: { [scaleId]: 3 },
      },
    };
    expect(codeOf(() => parseAnswers(fields, answers, ctx))).toBe(FORM_ANSWERS_INVALID);
  });

  it('lets a partial review through when require_all_targets is off', () => {
    const relaxed = parseFormDefinition([
      {
        ...SAMPLES.repeat_group,
        repeat: { ...(SAMPLES.repeat_group.repeat as object), require_all_targets: false },
      },
    ]).fields;
    const relaxedGroup = relaxed[0];
    const relaxedScale = (relaxedGroup.fields as FormField[]).find(
      field => field.type === 'opinion_scale'
    )!.id;
    const relaxedCtx = {
      resolved: { [relaxedGroup.id]: [{ user_id: alice }, { user_id: bob }] },
    };
    expect(() =>
      parseAnswers(relaxed, { [relaxedGroup.id]: { [alice]: { [relaxedScale]: 4 } } }, relaxedCtx)
    ).not.toThrow();
  });
});

describe('formContract — gallery roles', () => {
  it('accepts a role on the field types it reads, and keeps it through a re-parse', () => {
    const { fields } = parseFormDefinition([
      { type: 'short_text', label: 'Project title', gallery_role: 'title' },
      { type: 'long_text', label: 'Summary', gallery_role: 'summary' },
      { ...SAMPLES.multiselect, gallery_role: 'tags' },
      { ...SAMPLES.roster_select, gallery_role: 'team' },
      { type: 'short_text', label: 'Tags', gallery_role: 'tags' },
    ]);
    const roles = ['title', 'summary', 'tags', 'team', 'tags'];
    expect(fields.map(field => galleryRoleOf(field))).toEqual(roles);
    expect(parseFormDefinition(fields).fields.map(field => galleryRoleOf(field))).toEqual(roles);
  });

  it('rejects an unknown role', () => {
    expect(
      codeOf(() => parseOne({ type: 'short_text', label: 'Title', gallery_role: 'hero' }))
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('rejects a role on a display block', () => {
    expect(codeOf(() => parseOne({ ...SAMPLES.heading, gallery_role: 'title' }))).toBe(
      FORM_DEFINITION_INVALID
    );
  });

  // The strict schemas reject ANY unknown key today, so these assert the
  // message: only the new pairing/nesting check produces it.
  it('rejects a role on a field type it cannot read', () => {
    expect(() => parseOne({ type: 'long_text', label: 'Title', gallery_role: 'title' })).toThrow(
      /title gallery role needs a short_text field/
    );
    expect(() => parseOne({ ...SAMPLES.number, gallery_role: 'tags' })).toThrow(
      /tags gallery role needs/
    );
  });

  it('rejects a role inside a repeat group', () => {
    const group = {
      ...SAMPLES.repeat_group,
      fields: [{ type: 'long_text', label: 'Comments', gallery_role: 'detail' }],
    };
    expect(() => parseOne(group)).toThrow(/inside a repeat group/);
  });

  it('rejects a team role on a single-select roster', () => {
    expect(() =>
      parseOne({ ...SAMPLES.roster_select, multiple: false, gallery_role: 'team' })
    ).toThrow(/team gallery role needs a roster select that allows several people/);
  });

  it('assertGalleryRoles wants exactly one title and at most one of each single role', () => {
    const withRole = (id: string, type: string, role: string) =>
      ({ id, type, label: id, gallery_role: role }) as FormField;
    const title = withRole('t1', 'short_text', 'title');
    const summary = withRole('s1', 'long_text', 'summary');

    expect(codeOf(() => assertGalleryRoles([summary]))).toBe(FORM_DEFINITION_INVALID);
    expect(codeOf(() => assertGalleryRoles([title, withRole('t2', 'short_text', 'title')]))).toBe(
      FORM_DEFINITION_INVALID
    );
    expect(
      codeOf(() => assertGalleryRoles([title, summary, withRole('s2', 'long_text', 'summary')]))
    ).toBe(FORM_DEFINITION_INVALID);
    expect(
      codeOf(() =>
        assertGalleryRoles([
          title,
          summary,
          withRole('d1', 'long_text', 'detail'),
          withRole('d2', 'long_text', 'detail'),
          withRole('l1', 'short_text', 'link'),
          withRole('l2', 'short_text', 'link'),
        ])
      )
    ).toBeUndefined();
  });
});

describe('formContract — identity questions', () => {
  it.each([...IDENTITY_QUESTION_TYPES])('accepts identity_question on %s', type => {
    const field = parseOne({ ...SAMPLES[type], identity_question: true });
    expect(field.identity_question).toBe(true);
    expect(isIdentityQuestion(field)).toBe(true);
  });

  it('refuses it on every other input type', () => {
    const refused = FIELD_TYPES.filter(
      type => FIELD_TYPE_REGISTRY[type].kind === 'input' && !IDENTITY_QUESTION_TYPES.includes(type)
    );
    expect([...refused].sort()).toEqual([
      'email',
      'matrix',
      'ranked_choice',
      'repeat_group',
      'roster_select',
    ]);
    for (const type of refused) {
      const fn = () => parseFormDefinition([{ ...SAMPLES[type], identity_question: true }]);
      expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
      expect(messageOf(fn)).toContain(`is a ${type} field; identity_question is allowed only on`);
    }
  });

  it('refuses it on a display block (no such key there)', () => {
    expect(
      codeOf(() => parseFormDefinition([{ ...SAMPLES.heading, identity_question: true }]))
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('refuses it on a repeat-group child, even of an allowed type', () => {
    const group = {
      ...SAMPLES.repeat_group,
      fields: [{ type: 'long_text', label: 'About this teammate', identity_question: true }],
    };
    const fn = () => parseFormDefinition([group]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('is inside a repeat group; identity_question is not allowed');
  });

  it('drops identity_question: false, top level and nested', () => {
    const { fields } = parseFormDefinition([
      { ...SAMPLES.short_text, identity_question: false },
      {
        ...SAMPLES.repeat_group,
        fields: [{ type: 'long_text', label: 'Comments', identity_question: false }],
      },
    ]);
    expect(fields[0]).not.toHaveProperty('identity_question');
    expect((fields[1].fields as FormField[])[0]).not.toHaveProperty('identity_question');
    expect(isIdentityQuestion(fields[0])).toBe(false);
  });

  it('leaves an unflagged definition exactly as before', () => {
    for (const type of FIELD_TYPES) {
      expect(parseOne(SAMPLES[type])).not.toHaveProperty('identity_question');
    }
  });

  it('keeps the flag through a re-parse', () => {
    const once = parseFormDefinition([{ ...SAMPLES.multiselect, identity_question: true }]);
    const twice = parseFormDefinition(once);
    expect(twice.fields[0].identity_question).toBe(true);
    expect(twice.fields[0].id).toBe(once.fields[0].id);
  });

  it('isIdentityQuestion is true only for the literal flag', () => {
    expect(isIdentityQuestion({ identity_question: true })).toBe(true);
    expect(isIdentityQuestion({ identity_question: 'true' })).toBe(false);
    expect(isIdentityQuestion({})).toBe(false);
    expect(isIdentityQuestion(null)).toBe(false);
    expect(isIdentityQuestion(undefined)).toBe(false);
  });

  it('identityQuestionIds is the union of the lists, top level only', () => {
    const current = parseFormDefinition([
      { ...SAMPLES.multiselect, identity_question: true },
      SAMPLES.short_text,
    ]).fields;
    const draft = parseFormDefinition([
      { ...current[0] },
      { ...current[1], identity_question: true },
      { ...SAMPLES.dropdown, identity_question: true },
    ]).fields;
    const ids = identityQuestionIds(current, draft);
    expect(ids).toEqual(new Set([current[0].id, current[1].id, draft[2].id]));
    expect(identityQuestionIds(current)).toEqual(new Set([current[0].id]));

    // A nested flag can't be saved, but a hand-built list still must not reach it.
    const nestedId = '44444444-4444-4444-8444-444444444444';
    const handBuilt = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        type: 'repeat_group',
        fields: [{ id: nestedId, type: 'long_text', identity_question: true }],
      },
    ] as unknown as FormField[];
    expect(identityQuestionIds(handBuilt).has(nestedId)).toBe(false);
  });

  it('identityQuestionIds tolerates a missing list', () => {
    const current = parseFormDefinition([{ ...SAMPLES.switch, identity_question: true }]).fields;
    expect(identityQuestionIds(null, current, undefined)).toEqual(new Set([current[0].id]));
    expect(identityQuestionIds()).toEqual(new Set());
  });

  it('identityQuestionIds reads a stored definition object', () => {
    const stored = parseFormDefinition([
      { ...SAMPLES.multiselect, identity_question: true },
      SAMPLES.short_text,
    ]);
    expect(stored).toHaveProperty('definition_version', DEFINITION_VERSION);
    expect(identityQuestionIds(stored)).toEqual(new Set([stored.fields[0].id]));
  });

  it('identityQuestionIds mixes a stored definition and a list', () => {
    const revision = parseFormDefinition([{ ...SAMPLES.dropdown, identity_question: true }]);
    const draft = parseFormDefinition([
      revision.fields[0],
      { ...SAMPLES.number, identity_question: true },
    ]).fields;
    expect(identityQuestionIds(revision, draft)).toEqual(
      new Set([revision.fields[0].id, draft[1].id])
    );
    expect(identityQuestionIds(draft, null, revision)).toEqual(
      new Set([revision.fields[0].id, draft[1].id])
    );
  });

  it('identityQuestionIds throws on a shape it does not recognize', () => {
    const wrong = [
      {},
      { fields: null },
      { fields: 'not a list' },
      { definition_version: DEFINITION_VERSION },
      'fields',
      42,
    ];
    for (const value of wrong) {
      const fn = () => identityQuestionIds([], value as never);
      expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
      expect(messageOf(fn)).toContain('argument 2 is neither a field list nor a stored definition');
    }
  });

  it('withoutAnswers removes the keys without touching the input', () => {
    const answers = { a: ['x'], b: 'kept', c: null };
    const masked = withoutAnswers(answers, new Set(['a', 'c', 'not-there']));
    expect(masked).toEqual({ b: 'kept' });
    expect(masked).not.toHaveProperty('c');
    expect(answers).toEqual({ a: ['x'], b: 'kept', c: null });
    const unmasked = withoutAnswers(answers, new Set());
    expect(unmasked).toEqual(answers);
    expect(unmasked).not.toBe(answers);
  });
});

describe('formContract — exclusive options', () => {
  const withExclusive = {
    type: 'multiselect',
    label: 'Which apply?',
    options: ['First', 'Second', { label: 'None of these', exclusive: true }],
  };

  it('keeps exclusive on a multiselect option, and only when true', () => {
    const field = parseOne({
      ...withExclusive,
      options: [{ label: 'First', exclusive: false }, 'Second', { label: 'None', exclusive: true }],
    });
    const options = field.options as FormOption[];
    expect(options[0]).toEqual({ id: expect.any(String), label: 'First' });
    expect(options[1]).not.toHaveProperty('exclusive');
    expect(options[2]).toEqual({ id: expect.any(String), label: 'None', exclusive: true });
  });

  it('accepts it on a multiselect inside a repeat group', () => {
    const group = { ...SAMPLES.repeat_group, fields: [withExclusive] };
    expect(() => parseFormDefinition([group])).not.toThrow();
  });

  it.each([
    [
      'dropdown',
      { type: 'dropdown', label: 'Pick', options: ['A', { label: 'B', exclusive: true }] },
    ],
    [
      'ranked_choice',
      {
        type: 'ranked_choice',
        label: 'Rank',
        options: ['A', { label: 'B', exclusive: true }],
        ranks: 2,
      },
    ],
    [
      'roster_select',
      {
        type: 'roster_select',
        label: 'Who',
        optionSource: 'roster',
        options: [{ label: 'Person', exclusive: true }],
      },
    ],
    [
      'matrix rows',
      {
        type: 'matrix',
        label: 'Grid',
        matrix: { rows: [{ label: 'Row', exclusive: true }], columns: ['A', 'B'] },
      },
    ],
    [
      'matrix columns',
      {
        type: 'matrix',
        label: 'Grid',
        matrix: { rows: ['Row'], columns: ['A', { label: 'B', exclusive: true }] },
      },
    ],
  ])('refuses it on %s', (_where, raw) => {
    const fn = () => parseFormDefinition([raw]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('exclusive is allowed only on multiselect options');
  });

  it('refuses it on a dropdown inside a repeat group', () => {
    const group = {
      ...SAMPLES.repeat_group,
      fields: [{ type: 'dropdown', label: 'Pick', options: [{ label: 'A', exclusive: true }] }],
    };
    const fn = () => parseFormDefinition([group]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('exclusive is allowed only on multiselect options');
  });

  describe('answers', () => {
    const fields = parseFormDefinition([withExclusive]).fields;
    const field = fields[0];
    const [first, second, none] = (field.options as FormOption[]).map(option => option.id);

    it('accepts the exclusive option alone', () => {
      expect(parseAnswers(fields, { [field.id]: [none] })).toEqual({ [field.id]: [none] });
    });

    it('accepts any mix of the other options', () => {
      expect(() => parseAnswers(fields, { [field.id]: [first, second] })).not.toThrow();
      expect(() => parseAnswers(fields, { [field.id]: [] })).not.toThrow();
    });

    it('refuses the exclusive option combined with another, in either order', () => {
      expect(codeOf(() => parseAnswers(fields, { [field.id]: [first, none] }))).toBe(
        FORM_ANSWERS_INVALID
      );
      expect(codeOf(() => parseAnswers(fields, { [field.id]: [none, second] }))).toBe(
        FORM_ANSWERS_INVALID
      );
      let message = '';
      try {
        parseAnswers(fields, { [field.id]: [none, first, second] });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`"None of these" can't be combined with other choices`);
    });

    it('refuses two exclusive options together', () => {
      const two = parseFormDefinition([
        {
          type: 'multiselect',
          label: 'Which apply?',
          options: ['A', { label: 'No', exclusive: true }, { label: 'Skip', exclusive: true }],
        },
      ]).fields;
      const [, no, skip] = (two[0].options as FormOption[]).map(option => option.id);
      expect(codeOf(() => parseAnswers(two, { [two[0].id]: [no, skip] }))).toBe(
        FORM_ANSWERS_INVALID
      );
    });
  });
});

describe('formContract — options_from', () => {
  const rankedId = '66666666-6666-4666-8666-666666666666';
  const dropdownId = '77777777-7777-4777-8777-777777777777';
  const ranked = {
    id: rankedId,
    type: 'ranked_choice',
    label: 'Rank the projects',
    options: [{ label: 'Project A', description: 'The first one' }, 'Project B', 'Project C'],
    ranks: 2,
  };
  const pitched = {
    id: dropdownId,
    type: 'dropdown',
    label: 'Which project did you pitch?',
    options_from: rankedId,
  };

  it("copies the source's options, ids included, and keeps the link", () => {
    const { fields } = parseFormDefinition([ranked, pitched]);
    expect(fields[1].options).toEqual(fields[0].options);
    expect(fields[1].options).not.toBe(fields[0].options);
    expect((fields[1].options as FormOption[])[0]).not.toBe((fields[0].options as FormOption[])[0]);
    expect(fields[1].options_from).toBe(rankedId);
  });

  it('takes options from a plain dropdown too, and the dependent may come first', () => {
    const source = { id: rankedId, type: 'dropdown', label: 'Track', options: ['Design', 'Dev'] };
    const { fields } = parseFormDefinition([pitched, source]);
    expect(fields[0].options).toEqual(fields[1].options);
  });

  it('replaces any options sent alongside the link', () => {
    const { fields } = parseFormDefinition([ranked, { ...pitched, options: ['Stale'] }]);
    expect((fields[1].options as FormOption[]).map(option => option.label)).toEqual([
      'Project A',
      'Project B',
      'Project C',
    ]);
  });

  it('accepts an answer that is one of the copied options', () => {
    const { fields } = parseFormDefinition([ranked, pitched]);
    const optionId = (fields[0].options as FormOption[])[1].id;
    expect(parseAnswers(fields, { [rankedId]: [], [dropdownId]: optionId })).toMatchObject({
      [dropdownId]: optionId,
    });
  });

  it('follows the source when the definition is parsed again', () => {
    const once = parseFormDefinition([ranked, pitched]);
    const edited = structuredClone(once);
    const sourceOptions = edited.fields[0].options as FormOption[];
    sourceOptions[0].label = 'Project A, renamed';
    sourceOptions.push({ id: '88888888-8888-4888-8888-888888888888', label: 'Project D' });
    const twice = parseFormDefinition(edited);
    expect(twice.fields[1].options).toEqual(twice.fields[0].options);
    expect((twice.fields[1].options as FormOption[]).map(option => option.label)).toEqual([
      'Project A, renamed',
      'Project B',
      'Project C',
      'Project D',
    ]);
  });

  it('round-trips with the same ids', () => {
    const once = parseFormDefinition([ranked, pitched]);
    expect(parseFormDefinition(once)).toEqual(once);
  });

  it('still refuses a dropdown with neither options nor options_from', () => {
    expect(codeOf(() => parseFormDefinition([{ type: 'dropdown', label: 'Pick' }]))).toBe(
      FORM_DEFINITION_INVALID
    );
    expect(
      codeOf(() => parseFormDefinition([{ type: 'dropdown', label: 'Pick', options: [] }]))
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('refuses a source that is not in the form', () => {
    const fn = () => parseFormDefinition([pitched]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('is not a top-level field of this form');
  });

  it('refuses a source of the wrong type', () => {
    const source = { id: rankedId, type: 'multiselect', label: 'Tools', options: ['A', 'B'] };
    const fn = () => parseFormDefinition([source, pitched]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('must name a ranked_choice or dropdown field');
  });

  it('refuses a chain', () => {
    const middleId = '99999999-9999-4999-8999-999999999999';
    const middle = { id: middleId, type: 'dropdown', label: 'Middle', options_from: rankedId };
    const fn = () => parseFormDefinition([ranked, middle, { ...pitched, options_from: middleId }]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('takes its own options from another field');
  });

  it('refuses a dropdown that names itself', () => {
    const fn = () => parseFormDefinition([{ ...pitched, options_from: dropdownId }]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('names itself in options_from');
  });

  it('refuses the link on a repeat-group child', () => {
    const group = { ...SAMPLES.repeat_group, fields: [pitched] };
    const fn = () => parseFormDefinition([ranked, group]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('is inside a repeat group; options_from is allowed only');
  });

  it('refuses a source inside a repeat group', () => {
    const group = {
      ...SAMPLES.repeat_group,
      fields: [{ id: rankedId, type: 'dropdown', label: 'Nested', options: ['A', 'B'] }],
    };
    const fn = () => parseFormDefinition([group, pitched]);
    expect(codeOf(fn)).toBe(FORM_DEFINITION_INVALID);
    expect(messageOf(fn)).toContain('is not a top-level field of this form');
  });

  it('refuses options_from on any type but dropdown', () => {
    expect(
      codeOf(() =>
        parseFormDefinition([
          ranked,
          { type: 'multiselect', label: 'Pick', options: ['A'], options_from: rankedId },
        ])
      )
    ).toBe(FORM_DEFINITION_INVALID);
  });

  it('measures the size cap after the copy', () => {
    const big = {
      ...ranked,
      options: Array.from({ length: FORM_LIMITS.MAX_OPTIONS }, (_, o) => ({
        label: `Project ${o}`,
        description: 'd'.repeat(1100),
      })),
    };
    // The source alone fits; with its copy it does not.
    expect(() => parseFormDefinition([big])).not.toThrow();
    expect(codeOf(() => parseFormDefinition([big, pitched]))).toBe(FORM_DEFINITION_TOO_LARGE);
  });

  it('resolveSharedOptions returns a new list and leaves unlinked fields alone', () => {
    const { fields } = parseFormDefinition([ranked, pitched, SAMPLES.short_text]);
    const unlinked = { ...fields[1], options: [] } as FormField;
    const input = [fields[0], unlinked, fields[2]];
    const resolved = resolveSharedOptions(input);
    expect(resolved).not.toBe(input);
    expect(resolved[0]).toBe(fields[0]);
    expect(resolved[2]).toBe(fields[2]);
    expect(resolved[1].options).toEqual(fields[0].options);
    expect(unlinked.options).toEqual([]);
  });
});
