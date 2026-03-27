import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

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
