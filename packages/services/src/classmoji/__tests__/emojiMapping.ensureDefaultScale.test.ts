/**
 * ensureDefaultScale gives a classroom with no grading scale the number scale
 * and leaves one that has any mapping alone. Prisma is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const count = vi.fn();
const createMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    emojiMapping: {
      count: (...a: unknown[]) => count(...a),
      createMany: (...a: unknown[]) => createMany(...a),
    },
  }),
}));

const { ensureDefaultScale } = await import('../emojiMapping.service.ts');
const { SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

beforeEach(() => {
  count.mockReset();
  createMany.mockReset();
  createMany.mockResolvedValue({ count: SCORE_EMOJI_MAPPINGS.length });
});

describe('ensureDefaultScale', () => {
  it('seeds the 0–100 number scale into an empty classroom', async () => {
    count.mockResolvedValue(0);
    const result = await ensureDefaultScale('class-1');

    expect(result).toEqual({ seeded: true, count: SCORE_EMOJI_MAPPINGS.length });
    expect(createMany).toHaveBeenCalledTimes(1);
    const { data, skipDuplicates } = createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(SCORE_EMOJI_MAPPINGS.length);
    expect(data[0]).toEqual({ classroom_id: 'class-1', ...SCORE_EMOJI_MAPPINGS[0] });
    expect(data.every((row: { classroom_id: string }) => row.classroom_id === 'class-1')).toBe(true);
  });

  it('leaves a classroom that already has a scale untouched', async () => {
    count.mockResolvedValue(3);
    const result = await ensureDefaultScale('class-2');

    expect(result).toEqual({ seeded: false });
    expect(createMany).not.toHaveBeenCalled();
  });
});
