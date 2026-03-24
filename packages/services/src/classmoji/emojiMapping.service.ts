import prisma from '@classmoji/database';

export const saveEmojiMapping = async (classroomId: string, values: { emoji: string; [key: string]: any }) => {
  return prisma!.emojiMapping.upsert({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: values.emoji,
      },
    },
    update: values,
    create: { classroom_id: classroomId, ...values },
  } as any);
};

export const findClassroomEmojiMappingDescription = async (classroomId: string) => {
  const mappings = await prisma!.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  return mappings.map(mapping => ({
    emoji: mapping.emoji,
    description: mapping.description,
  }));
};

export const findByClassroomId = async (classroomId: string, includeExtraTokens = false) => {
  const mappings = await prisma!.emojiMapping.findMany({
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
  return prisma!.emojiMapping.delete({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: emoji,
      },
    },
  });
};
