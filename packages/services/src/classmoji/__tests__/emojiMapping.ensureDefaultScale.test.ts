/**
 * ensureDefaultScale gives a classroom with no grading scale the number scale
 * and leaves one that has any mapping alone; saveEmojiMapping upserts under
 * the same scale lock. Prisma is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const count = vi.fn();
const createMany = vi.fn();
const upsert = vi.fn();
// The scale lock (`pg_advisory_xact_lock`), taken before the count.
const queryRaw = vi.fn();
const calls: string[] = [];

vi.mock('@classmoji/database', () => {
  const tx = {
    $queryRaw: (...a: unknown[]) => {
      calls.push('lock');
      return queryRaw(...a);
    },
    emojiMapping: {
      count: (...a: unknown[]) => {
        calls.push('count');
        return count(...a);
      },
      createMany: (...a: unknown[]) => createMany(...a),
      upsert: (...a: unknown[]) => {
        calls.push('upsert');
        return upsert(...a);
      },
    },
  };
  return {
    default: () => ({
      ...tx,
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    }),
  };
});

const { ensureDefaultScale, saveEmojiMapping } = await import('../emojiMapping.service.ts');
const { SCORE_EMOJI_MAPPINGS } = await import('@classmoji/utils');

beforeEach(() => {
  count.mockReset();
  createMany.mockReset();
  queryRaw.mockReset();
  upsert.mockReset();
  calls.length = 0;
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
    expect(data.every((row: { classroom_id: string }) => row.classroom_id === 'class-1')).toBe(
      true
    );
    // Counted under the scale lock, so it cannot interleave with a replaceScale.
    expect(calls).toEqual(['lock', 'count']);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(['emoji-scale:class-1']);
  });

  it('leaves a classroom that already has a scale untouched', async () => {
    count.mockResolvedValue(3);
    const result = await ensureDefaultScale('class-2');

    expect(result).toEqual({ seeded: false });
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('saveEmojiMapping', () => {
  it('upserts under the scale lock, so it never lands inside a replaceScale', async () => {
    const values = { emoji: 'rocket', grade: 100, extra_tokens: 0, description: 'Great' };
    upsert.mockResolvedValue({ classroom_id: 'class-1', ...values });

    await expect(saveEmojiMapping('class-1', values)).resolves.toMatchObject(values);

    expect(calls).toEqual(['lock', 'upsert']);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(['emoji-scale:class-1']);
    expect(upsert).toHaveBeenCalledWith({
      where: { classroom_id_emoji: { classroom_id: 'class-1', emoji: 'rocket' } },
      update: values,
      create: { classroom_id: 'class-1', ...values },
    });
  });
});

describe('quizScaleForClassroom (E10)', () => {
  const findMany = vi.fn();
  const client = {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    emojiMapping: {
      findMany: (...a: unknown[]) => findMany(...a),
      count: (...a: unknown[]) => count(...a),
      createMany: (...a: unknown[]) => createMany(...a),
    },
  } as never;

  beforeEach(() => findMany.mockReset());

  it("returns the classroom's own scale and seeds nothing when it has one", async () => {
    const { quizScaleForClassroom } = await import('../emojiMapping.service.ts');
    findMany.mockResolvedValue([
      { emoji: 'star', grade: 100 },
      { emoji: 'zzz', grade: 0 },
    ]);
    expect(await quizScaleForClassroom('class-1', client)).toEqual({ star: 100, zzz: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('seeds the new-classroom scale on the given client when the classroom has none, then reads it', async () => {
    const { quizScaleForClassroom } = await import('../emojiMapping.service.ts');
    const seeded = SCORE_EMOJI_MAPPINGS.map(m => ({ emoji: m.emoji, grade: m.grade }));
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(seeded);
    count.mockResolvedValue(0);

    const scale = await quizScaleForClassroom('class-1', client);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data[0]).toEqual({
      classroom_id: 'class-1',
      ...SCORE_EMOJI_MAPPINGS[0],
    });
    expect(scale['score-100']).toBe(100);
    expect(scale['score-0']).toBe(0);
    expect(Object.keys(scale)).toHaveLength(SCORE_EMOJI_MAPPINGS.length);
  });
});

describe('quizScaleEmojis', () => {
  it('orders the scale best first, an integer-like shortcode included', async () => {
    const { quizScaleEmojis } = await import('../emojiMapping.service.ts');
    expect(quizScaleEmojis({ '100': 90, rocket: 100, eyes: 80, '-1': 60 })).toEqual([
      'rocket',
      '100',
      'eyes',
      '-1',
    ]);
  });
});
