import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';

/**
 * Create multiple invites (bulk) - used when instructor uploads roster
 * @param {Object[]} invites - Array of { school_email, student_id, classroom_id }
 * @returns {Promise<{count: number}>}
 */
export const createManyInvites = async (
  invites: { school_email: string; student_id?: string; classroom_id: string }[]
): Promise<{ count: number }> => {
  const inviteData: unknown = invites;
  // TODO: narrow further once classroom invite input shape is aligned with the generated Prisma schema.
  return getPrisma().classroomInvite.createMany({
    data: inviteData as Prisma.ClassroomInviteCreateManyInput[],
    skipDuplicates: true,
  });
};

/**
 * Find all invites by school email
 * Used during registration to auto-claim invites for a student
 * @param {string} schoolEmail - Student's school email
 * @returns {Promise<Object[]>}
 */
export const findInvitesByEmail = async (
  schoolEmail: string
): Promise<Prisma.ClassroomInviteGetPayload<{ include: { classroom: true } }>[]> => {
  return getPrisma().classroomInvite.findMany({
    where: {
      school_email: { equals: schoolEmail, mode: 'insensitive' },
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
export const findInvitesByClassroomId = async (
  classroomId: string
): Promise<Prisma.ClassroomInviteGetPayload<Record<string, never>>[]> => {
  return getPrisma().classroomInvite.findMany({
    where: { classroom_id: classroomId },
    orderBy: { created_at: 'desc' },
  });
};

/**
 * Delete an invite by ID
 * @param {string} id - UUID of the invite
 * @returns {Promise<Object>}
 */
export const deleteInvite = async (
  id: string
): Promise<Prisma.ClassroomInviteGetPayload<Record<string, never>>> => {
  return getPrisma().classroomInvite.delete({
    where: { id },
  });
};

/**
 * Delete multiple invites by IDs - used when student claims invites
 * @param {string[]} ids - Array of UUIDs
 * @returns {Promise<{count: number}>}
 */
export const deleteManyInvites = async (ids: string[]): Promise<{ count: number }> => {
  return getPrisma().classroomInvite.deleteMany({
    where: { id: { in: ids } },
  });
};
