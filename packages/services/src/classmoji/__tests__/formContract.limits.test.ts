/**
 * Size caps on form answers and the length of the message a refused answer
 * set produces: answer lists are counted before their entries are checked,
 * and the message names at most the first 20 issues.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FORM_ANSWERS_INVALID,
  FORM_DEFINITION_INVALID,
  FORM_LIMITS,
  parseAnswers,
  parseFormDefinition,
} from '../formContract.ts';

function errorOf(fn: () => unknown): Error & { code?: string; issues?: z.ZodIssue[] } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected a throw');
}

const { fields } = parseFormDefinition([
  { type: 'multiselect', label: 'Tools', options: ['React', 'Node', 'Figma'] },
  { type: 'ranked_choice', label: 'Rank', options: ['A', 'B', 'C'], ranks: 3 },
  { type: 'short_text', label: 'Name' },
]);
const [multi, ranked, name] = fields;

describe('form answer size caps', () => {
  it('refuses an oversized answer list with one issue and a short message', () => {
    // The most entries the answer byte cap admits: `1,` is two bytes.
    const entries = Math.floor(FORM_LIMITS.MAX_ANSWERS_BYTES / 2) - 64;
    for (const field of [multi, ranked]) {
      const error = errorOf(() =>
        parseAnswers(fields, { [field.id]: Array.from({ length: entries }, () => 1) })
      );
      expect(error.code).toBe(FORM_ANSWERS_INVALID);
      expect(error.issues).toHaveLength(1);
      expect(error.message.length).toBeLessThan(200);
    }
  });

  it('keeps the message a filler sees for a list over the field’s limit', () => {
    const error = errorOf(() =>
      parseAnswers(fields, {
        [multi.id]: [...(multi.options as Array<{ id: string }>).map(o => o.id), 'extra'],
      })
    );
    expect(error.message).toBe(`Invalid answers: ${multi.id}: Pick at most 3`);
  });

  it('names at most the first 20 issues, then how many more', () => {
    const answers: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`unknown-${i}`, 1])
    );
    answers[name.id] = 1;
    answers[multi.id] = 'not a list';
    const error = errorOf(() => parseAnswers(fields, answers));
    expect(error.code).toBe(FORM_ANSWERS_INVALID);
    expect(error.message.length).toBeLessThan(1_000);
    expect(error.message.startsWith('Invalid answers: ')).toBe(true);
  });

  it('cuts a long issue list and says how many were left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      type: 'short_text',
      label: `Q${i}`,
      required: true,
    }));
    const big = parseFormDefinition(many).fields;
    const error = errorOf(() => parseAnswers(big, {}));
    expect(error.code).toBe(FORM_ANSWERS_INVALID);
    expect(error.message.match(/: Required/g)).toHaveLength(20);
    expect(error.message.endsWith('; …and 10 more')).toBe(true);
  });

  it('refuses with its usual code when checking the answers throws', () => {
    const spy = vi.spyOn(z.ZodObject.prototype, 'safeParse').mockImplementationOnce(() => {
      throw new Error('parse failed');
    });
    try {
      const error = errorOf(() => parseAnswers(fields, {}));
      expect(error.code).toBe(FORM_ANSWERS_INVALID);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('cuts a refused definition’s message the same way', () => {
    const error = errorOf(() =>
      parseFormDefinition(Array.from({ length: 50 }, () => ({ type: 'short_text' })))
    );
    expect(error.code).toBe(FORM_DEFINITION_INVALID);
    expect(error.message).toMatch(/; …and \d+ more$/);
    expect(error.message.length).toBeLessThan(5_000);
  });
});
