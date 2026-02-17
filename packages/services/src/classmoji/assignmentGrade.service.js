/**
 * AssignmentGrade Service (formerly IssueGrade)
 *
 * Manages grades for RepositoryAssignments
 */
import prisma from '@classmoji/database';

/**
 * Add a grade to a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @param {string} graderId - UUID of the grader User
 * @param {string} emoji - Emoji grade
 * @returns {Promise<Object>}
 */
export const addGrade = async (repositoryAssignmentId, graderId, emoji) => {
  return prisma.assignmentGrade.create({
    data: {
      repository_assignment_id: repositoryAssignmentId,
      grader_id: graderId,
      emoji: emoji,
    },
  });
};

/**
 * Remove a grade by ID
 * @param {string} id - UUID of the AssignmentGrade
 * @returns {Promise<Object>}
 */
export const removeGrade = async id => {
  return prisma.assignmentGrade.delete({
    where: { id },
  });
};

/**
 * Check if a grade with a specific emoji already exists
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @param {string} emoji - Emoji to check
 * @returns {Promise<boolean>}
 */
export const doesGradeExist = async (repositoryAssignmentId, emoji) => {
  const grades = await prisma.assignmentGrade.findMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
      emoji: emoji,
    },
  });
  return grades.length === 1;
};

/**
 * Update a grade
 * @param {string} id - UUID of the AssignmentGrade
 * @param {Object} data - Data to update
 * @returns {Promise<Object>}
 */
export const update = async (id, data) => {
  return prisma.assignmentGrade.update({
    where: { id },
    data: data,
  });
};

/**
 * Remove all grades from a RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @returns {Promise<{count: number}>}
 */
export const removeAllGrades = async repositoryAssignmentId => {
  return prisma.assignmentGrade.deleteMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
    },
  });
};

/**
 * Find grades by RepositoryAssignment
 * @param {string} repositoryAssignmentId - UUID of the RepositoryAssignment
 * @returns {Promise<Object[]>}
 */
export const findByAssignmentId = async repositoryAssignmentId => {
  return prisma.assignmentGrade.findMany({
    where: {
      repository_assignment_id: repositoryAssignmentId,
    },
    include: {
      grader: true,
      token_transaction: true,
    },
  });
};

/**
 * Find a grade by ID
 * @param {string} id - UUID of the AssignmentGrade
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.assignmentGrade.findUnique({
    where: { id },
    include: {
      grader: true,
      repository_assignment: true,
      token_transaction: true,
    },
  });
};

/**
 * Find orphaned grade emojis - emojis used in grades that don't have mappings
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Array<{emoji: string, count: number}>>}
 */
export const findOrphanedGradeEmojis = async classroomId => {
  // Get all valid emojis from the classroom's mappings
  const validMappings = await prisma.emojiMapping.findMany({
    where: { classroom_id: classroomId },
    select: { emoji: true },
  });
  const validEmojis = validMappings.map(m => m.emoji);

  // Find grades in this classroom that use emojis not in the valid set
  const grades = await prisma.assignmentGrade.findMany({
    where: {
      repository_assignment: {
        assignment: {
          module: {
            classroom_id: classroomId,
          },
        },
      },
      ...(validEmojis.length > 0 && {
        NOT: {
          emoji: { in: validEmojis },
        },
      }),
    },
    select: {
      emoji: true,
    },
  });

  // Count occurrences of each orphaned emoji
  const emojiCounts = grades.reduce((acc, g) => {
    acc[g.emoji] = (acc[g.emoji] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(emojiCounts).map(([emoji, count]) => ({ emoji, count }));
};

/**
 * Remap grade emojis in batch
 * @param {string} classroomId - UUID of the Classroom
 * @param {Array<{oldEmoji: string, newEmoji: string}>} mappings - Array of emoji remappings
 * @returns {Promise<{totalRemapped: number}>}
 */
export const remapGradeEmojis = async (classroomId, mappings) => {
  let totalRemapped = 0;

  for (const { oldEmoji, newEmoji } of mappings) {
    // Get IDs of grades to update (scoped to classroom)
    const gradesToUpdate = await prisma.assignmentGrade.findMany({
      where: {
        emoji: oldEmoji,
        repository_assignment: {
          assignment: {
            module: {
              classroom_id: classroomId,
            },
          },
        },
      },
      select: { id: true },
    });

    if (gradesToUpdate.length > 0) {
      const result = await prisma.assignmentGrade.updateMany({
        where: {
          id: { in: gradesToUpdate.map(g => g.id) },
        },
        data: {
          emoji: newEmoji,
          updated_at: new Date(),
        },
      });
      totalRemapped += result.count;
    }
  }

  return { totalRemapped };
};
