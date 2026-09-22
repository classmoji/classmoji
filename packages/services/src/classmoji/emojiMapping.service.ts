import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import { SCORE_EMOJI_MAPPINGS } from '@classmoji/utils';

type EmojiMappingInput = Prisma.EmojiMappingUncheckedCreateWithoutClassroomInput;

export const saveEmojiMapping = async (classroomId: string, values: EmojiMappingInput) => {
  return getPrisma().emojiMapping.upsert({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: values.emoji,
      },
    },
    update: values,
    create: { classroom_id: classroomId, ...values },
  });
};

export const findClassroomEmojiMappingDescription = async (classroomId: string) => {
  const mappings = await getPrisma().emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  return mappings.map(mapping => ({
    emoji: mapping.emoji,
    description: mapping.description,
  }));
};

export const findByClassroomId = async (classroomId: string, includeExtraTokens = false) => {
  const mappings = await getPrisma().emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  if (includeExtraTokens) {
    return mappings;
  }

  // create object with emoji property as key and grade as value
  const emojiMappings: Record<string, number> = {};

  mappings.forEach(mapping => {
    emojiMappings[mapping.emoji] = Math.trunc(mapping.grade as unknown as number);
  });

  return emojiMappings;
};

export const deleteEmojiMapping = async (classroomId: string, emoji: string) => {
  return getPrisma().emojiMapping.delete({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: emoji,
      },
    },
  });
};

/**
 * Give a classroom that has no grading scale the default one: the 0–100
 * number scale in tens. Called once a classroom exists (after any config
 * import, which may have copied a scale of its own), so a fresh classroom
 * never lands on the Grades tab with nothing to grade with. A classroom that
 * already has mappings is left exactly as it is.
 */
export const ensureDefaultScale = async (classroomId: string) => {
  const prisma = getPrisma();
  const existing = await prisma.emojiMapping.count({ where: { classroom_id: classroomId } });
  if (existing > 0) return { seeded: false as const };
  await prisma.emojiMapping.createMany({
    data: SCORE_EMOJI_MAPPINGS.map(m => ({ classroom_id: classroomId, ...m })),
    skipDuplicates: true,
  });
  return { seeded: true as const, count: SCORE_EMOJI_MAPPINGS.length };
};
