import prisma from '@classmoji/database';

/**
 * Create multiple invites (bulk) - used when instructor uploads roster
 * @param {Object[]} invites - Array of { school_email, student_id, classroom_id }
 * @returns {Promise<{count: number}>}
 */
export const createManyInvites = async invites => {
  return prisma.classroomInvite.createMany({
    data: invites,
    skipDuplicates: true,
  });
};

/**
 * Find all invites by school email and student ID
 * Used during /connect-account to claim all invites for a student
 * @param {string} schoolEmail - Student's school email
 * @param {string} studentId - Student's school ID
 * @returns {Promise<Object[]>}
 */
export const findInvitesByEmailAndStudentId = async (schoolEmail, studentId) => {
  return prisma.classroomInvite.findMany({
    where: {
      school_email: { equals: schoolEmail, mode: 'insensitive' },
      student_id: studentId,
    },
    include: {
      classroom: true,
    },
  });
};

/**
 * Find all invites for a classroom - admin view
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findInvitesByClassroomId = async classroomId => {
  return prisma.classroomInvite.findMany({
    where: { classroom_id: classroomId },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Delete an invite by ID
 * @param {string} id - UUID of the invite
 * @returns {Promise<Object>}
 */
export const deleteInvite = async id => {
  return prisma.classroomInvite.delete({
    where: { id },
  });
};

/**
 * Delete multiple invites by IDs - used when student claims invites
 * @param {string[]} ids - Array of UUIDs
 * @returns {Promise<{count: number}>}
 */
export const deleteManyInvites = async ids => {
  return prisma.classroomInvite.deleteMany({
    where: { id: { in: ids } },
  });
};

