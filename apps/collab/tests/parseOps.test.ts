/**
 * `/internal/.../ops` payload parsing (adapters/parseOps.ts): a refusal
 * carries a bounded issue list, and a parse that throws is a refusal too.
 */
import { describe, expect, it } from 'vitest';
import { deckOpsPayloadSchema } from '@classmoji/services/slides';
import { parseOpsPayload } from '../src/adapters/parseOps.ts';

describe('parseOpsPayload', () => {
  it('returns the parsed ops', () => {
    const parsed = parseOpsPayload(deckOpsPayloadSchema, [{ op: 'delete', id: 's1' }]);
    expect(parsed).toEqual({ success: true, data: [{ op: 'delete', id: 's1' }] });
  });

  it('returns at most the first 20 issues, then how many more', () => {
    const parsed = parseOpsPayload(
      deckOpsPayloadSchema,
      Array.from({ length: 300 }, () => ({ op: 'unknown' }))
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toHaveLength(21);
      expect(parsed.issues.at(-1)!.message).toBe('…and 280 more');
    }
  });

  it('refuses an oversized payload with one issue', () => {
    const parsed = parseOpsPayload(
      deckOpsPayloadSchema,
      Array.from({ length: 1_000_000 }, () => 1)
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.issues).toHaveLength(1);
  });

  it('refuses when the parse throws', () => {
    const throwing = {
      safeParse(): never {
        throw new Error('parse failed');
      },
    };
    const parsed = parseOpsPayload(throwing, []);
    expect(parsed).toEqual({
      success: false,
      issues: [{ code: 'custom', path: [], message: 'The ops could not be checked' }],
    });
  });
});
