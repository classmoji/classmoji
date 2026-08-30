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
  assertFieldsAllowedForAccess,
  buildResponseSchema,
  flattenFields,
  parseAnswers,
  parseFormDefinition,
  requiresResolvedContext,
  type FormField,
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
