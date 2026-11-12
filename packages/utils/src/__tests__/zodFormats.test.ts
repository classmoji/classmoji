import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4-mini';
import { isoDateTime, minUtf16Length, uuidString } from '../zodFormats.ts';

/**
 * What each helper accepts is what our dates and ids were validated with
 * before zod 4 (zod 3.25.76's `.datetime({ offset: true })` and `.uuid()`),
 * measured on zod 3 and copied here.
 */
const DATETIME_ROWS: [string, boolean][] = [
  ['2026-11-12T17:00:00Z', true],
  ['2026-11-12T17:00:00.000Z', true],
  ['2026-11-12T17:00:00.123456Z', true],
  ['2026-11-12T17:00Z', true],
  ['2026-11-12T17Z', false],
  ['2026-11-12T17:00:00-05:00', true],
  ['2026-11-12T17:00-05:00', true],
  ['2026-11-12T17:00:00.5-05:00', true],
  ['2026-11-12T17:00:00-0500', true],
  ['2026-11-12T17:00-0500', true],
  ['2026-11-12T17:00:00-05', false],
  ['2026-11-12T17:00:00+00:00', true],
  ['2026-11-12T17:00:00+25:00', true],
  ['2026-11-12T17:00:00+05:30', true],
  ['2026-11-12T17:00:00', false],
  ['2026-11-12T17:00', false],
  ['2026-11-12', false],
  ['2026-11-12 17:00:00Z', false],
  ['2026-11-12t17:00:00z', false],
  ['2026-02-30T17:00:00Z', false],
  ['2026-11-12T24:00:00Z', false],
  ['2026-11-12T17:60:00Z', false],
  ['2026-11-12T17:00:60Z', false],
  ['2026-11-12T17:00:00.Z', false],
  ['20261112T170000Z', false],
  ['', false],
];

const UUID_ROWS: [string, boolean][] = [
  ['11111111-1111-1111-1111-111111111111', true],
  ['00000000-0000-0000-0000-000000000001', true],
  ['00000000-0000-0000-0000-000000000000', true],
  ['ffffffff-ffff-ffff-ffff-ffffffffffff', true],
  ['0000aaaa-bbbb-cccc-dddd-eeeeffff0000', true],
  ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', true],
  ['3F2504E0-4F89-41D3-9A0C-0305E82C3301', true],
  ['01890a5d-ac96-774b-bcce-b302099a8057', true],
  ['{3f2504e0-4f89-41d3-9a0c-0305e82c3301}', false],
  ['3f2504e04f8941d39a0c0305e82c3301', false],
  ['3f2504e0-4f89-41d3-9a0c-0305e82c330', false],
  ['g3f2504e-4f89-41d3-9a0c-0305e82c3301', false],
  ['', false],
];

/** A schema's JSON Schema as the MCP SDK publishes a tool's input. */
const published = (shape: Record<string, z.ZodType>) =>
  toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };

describe('isoDateTime', () => {
  it.each(DATETIME_ROWS)('%s: accepted %s', (input, accepted) => {
    expect(isoDateTime().safeParse(input).success).toBe(accepted);
  });

  it('refuses with the issue zod raises for a datetime', () => {
    const result = isoDateTime().safeParse('2026-11-12T17:00:00');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      { code: 'invalid_format', format: 'datetime', path: [], message: 'Invalid datetime' },
    ]);
    const missing = z.object({ at: isoDateTime() }).safeParse({});
    expect(missing.error?.issues[0]).toMatchObject({ code: 'invalid_type', path: ['at'] });
    expect(missing.error?.issues[0].message).not.toBe('Invalid datetime');
    expect(isoDateTime().safeParse(5).error?.issues[0].message).not.toBe('Invalid datetime');
  });

  it('publishes format date-time and no pattern, described, optional or nullable', () => {
    const json = published({
      due: isoDateTime().describe('Due'),
      opens: isoDateTime().optional().describe('Opens'),
      closes: isoDateTime().nullable().optional().describe('Closes'),
    });
    expect(json.properties.due).toEqual({
      type: 'string',
      format: 'date-time',
      description: 'Due',
    });
    expect(json.properties.opens).toEqual({
      type: 'string',
      format: 'date-time',
      description: 'Opens',
    });
    expect(json.properties.closes).toEqual({
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
      description: 'Closes',
    });
    expect(json.required).toEqual(['due']);
  });
});

describe('uuidString', () => {
  it.each(UUID_ROWS)('%s: accepted %s', (input, accepted) => {
    expect(uuidString().safeParse(input).success).toBe(accepted);
  });

  it('calls a malformed id a uuid, and a missing one missing', () => {
    expect(uuidString().safeParse('not-an-id').error?.issues[0]).toMatchObject({
      code: 'invalid_format',
      message: 'Invalid uuid',
    });
    const missing = z.object({ id: uuidString() }).safeParse({});
    expect(missing.error?.issues[0].code).toBe('invalid_type');
    expect(missing.error?.issues[0].message).not.toBe('Invalid uuid');
  });

  it('publishes format uuid', () => {
    expect(published({ id: uuidString().describe('Id') }).properties.id).toMatchObject({
      type: 'string',
      format: 'uuid',
      description: 'Id',
    });
  });
});

describe('minUtf16Length', () => {
  const query = () => minUtf16Length(z.string().max(500), 2);

  it('counts the way JavaScript does: one emoji is two', () => {
    expect(query().safeParse('🐍').success).toBe(true);
    expect(query().safeParse('ab').success).toBe(true);
    expect(query().safeParse('a').success).toBe(false);
    expect(query().safeParse('').success).toBe(false);
    expect(minUtf16Length(z.string(), 3).safeParse('🎉🎉').success).toBe(true);
  });

  it('refuses with the issue .min() raises, and keeps the schema’s other checks', () => {
    const issues = (r: z.ZodSafeParseResult<string>) => (r.success ? [] : r.error.issues);
    expect(issues(query().safeParse('a'))).toEqual(issues(z.string().min(2).safeParse('a')));
    expect(issues(query().safeParse('x'.repeat(501)))[0]?.code).toBe('too_big');
  });

  it('does not stop a parent refinement, as .min() does not', () => {
    const refined = (q: z.ZodString) => {
      let ran = 0;
      const schema = z.object({ q, n: z.number() }).refine(() => {
        ran++;
        return false;
      }, 'parent refinement');
      const result = schema.safeParse({ q: 'a', n: 1 });
      return { ran, messages: result.error?.issues.map(issue => issue.message) };
    };
    const ours = refined(minUtf16Length(z.string(), 2));
    expect(ours).toEqual(refined(z.string().min(2)));
    expect(ours.ran).toBe(1);
    expect(ours.messages).toContain('parent refinement');
  });

  it('publishes minLength like .min()', () => {
    expect(published({ q: query().describe('Q') }).properties.q).toEqual(
      published({ q: z.string().min(2).max(500).describe('Q') }).properties.q
    );
  });
});
