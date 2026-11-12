/**
 * `/internal/.../ops` payload parsing (adapters/parseOps.ts): a refusal
 * carries a bounded issue list, and a parse that throws is a refusal too.
 */
import { describe, expect, it, vi } from 'vitest';
import { deckOpsPayloadSchema } from '@classmoji/services/slides';
import { parseOpsPayload } from '../src/adapters/parseOps.ts';

describe('parseOpsPayload', () => {
  it('returns the parsed ops', () => {
    const parsed = parseOpsPayload(deckOpsPayloadSchema, [{ op: 'delete', id: 's1' }], 'deck ops');
    expect(parsed).toEqual({ success: true, data: [{ op: 'delete', id: 's1' }] });
  });

  it('returns at most the first 20 issues, then how many more', () => {
    const parsed = parseOpsPayload(
      deckOpsPayloadSchema,
      Array.from({ length: 300 }, () => ({ op: 'unknown' })),
      'deck ops'
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
      Array.from({ length: 1_000_000 }, () => 1),
      'deck ops'
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.issues).toHaveLength(1);
  });

  it('refuses when the parse throws, and logs where and the error class only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = {
      safeParse(raw: unknown): never {
        throw new RangeError(`parse failed on ${JSON.stringify(raw)}`);
      },
    };
    try {
      const parsed = parseOpsPayload(throwing, ['SENTINEL-OPS-7f3a'], 'deck ops');
      expect(parsed).toEqual({
        success: false,
        issues: [{ code: 'custom', path: [], message: 'The ops could not be checked' }],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]!.map(String).join(' ');
      expect(line).toBe('[collab] deck ops check threw: RangeError');
      expect(line).not.toContain('SENTINEL');
      expect(line).not.toContain('parse failed');
    } finally {
      warn.mockRestore();
    }
  });
});
