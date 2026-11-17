/**
 * emojiMapping / letterGradeMapping writes against a real Postgres: a row is
 * saved to, and deleted from, the classroom the caller names, whatever else
 * the values carry. Classroom X's write never creates, changes or moves a row
 * of classroom Y.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import getPrisma from '@classmoji/database';
import * as emojiMapping from '../emojiMapping.service.ts';
import * as letterGradeMapping from '../letterGradeMapping.service.ts';
import { RUN_DB_SUITES, createTwoClassrooms, type TwoClassrooms } from './helpers/twoClassrooms.ts';

describe.skipIf(!RUN_DB_SUITES)('grade mappings stay in their classroom (integration)', () => {
  let fx: TwoClassrooms;
  const prisma = getPrisma();
  let yEmojiId: string;
  let yLetterId: string;

  beforeAll(async () => {
    fx = await createTwoClassrooms('grademaps');
    yEmojiId = (
      await prisma.emojiMapping.create({
        data: { classroom_id: fx.Y.id, emoji: 'star', grade: 50, description: 'y' },
      })
    ).id;
    yLetterId = (
      await prisma.letterGradeMapping.create({
        data: { classroom_id: fx.Y.id, letter_grade: 'A', min_grade: 50 },
      })
    ).id;
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  const yRows = async () => ({
    emoji: await prisma.emojiMapping.findMany({ where: { classroom_id: fx.Y.id } }),
    letters: await prisma.letterGradeMapping.findMany({ where: { classroom_id: fx.Y.id } }),
  });

  it("an emoji saved for X is X's row, whatever classroom or id the values carry", async () => {
    const before = await yRows();
    const extra = { classroom_id: fx.Y.id, id: yEmojiId };

    const created = await emojiMapping.saveEmojiMapping(fx.X.id, {
      emoji: 'star',
      grade: 95,
      ...extra,
    } as emojiMapping.EmojiMappingFields);
    expect(created.classroom_id).toBe(fx.X.id);
    expect(created.id).not.toBe(yEmojiId);

    // The update branch too.
    const updated = await emojiMapping.saveEmojiMapping(fx.X.id, {
      emoji: 'star',
      grade: 96,
      ...extra,
    } as emojiMapping.EmojiMappingFields);
    expect(updated.id).toBe(created.id);
    expect(updated.classroom_id).toBe(fx.X.id);
    expect(updated.grade).toBe(96);

    expect(await yRows()).toEqual(before);
  });

  it("a letter grade saved for X is X's row, whatever classroom or id the values carry", async () => {
    const before = await yRows();
    for (const min of [80, 85]) {
      const row = await letterGradeMapping.save(fx.X.id, {
        letter_grade: 'A',
        min_grade: min,
        classroom_id: fx.Y.id,
        id: yLetterId,
      } as letterGradeMapping.LetterGradeMappingFields);
      expect(row.classroom_id).toBe(fx.X.id);
      expect(row.id).not.toBe(yLetterId);
    }
    expect(await yRows()).toEqual(before);
  });

  it('deletes from X only, and nothing for a value that is not a string', async () => {
    const before = await yRows();
    expect(await emojiMapping.deleteEmojiMapping(fx.X.id, 'star')).toEqual({ count: 1 });
    expect(await letterGradeMapping.delete(fx.X.id, 'A')).toEqual({ count: 1 });
    expect(await emojiMapping.deleteEmojiMapping(fx.X.id, { not: '' })).toEqual({ count: 0 });
    expect(await letterGradeMapping.delete(fx.X.id, undefined)).toEqual({ count: 0 });
    expect(await yRows()).toEqual(before);
  });
});
