import prisma from '@classmoji/database';

export const saveEmojiMapping = async (classroomId, values) => {
  return prisma.emojiMapping.upsert({
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

export const findClassroomEmojiMappingDescription = async classroomId => {
  const mappings = await prisma.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  return mappings.map(mapping => ({
    emoji: mapping.emoji,
    description: mapping.description,
  }));
};

export const findByClassroomId = async (classroomId, includeExtraTokens = false) => {
  const mappings = await prisma.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
  });

  if (includeExtraTokens) {
    return mappings;
  }

  // create object with emoji property as key and grade as value
  const emojiMappings = {};

  mappings.forEach(mapping => {
    emojiMappings[mapping.emoji] = parseInt(mapping.grade);
  });

  return emojiMappings;
};

export const deleteEmojiMapping = async (classroomId, emoji) => {
  return prisma.emojiMapping.delete({
    where: {
      classroom_id_emoji: {
        classroom_id: classroomId,
        emoji: emoji,
      },
    },
  });
};
