/**
 * Who a classroom's staff views count: its CURRENT students and its current
 * teaching team. One rule for every surface that counts students (page
 * sections, Ask Moji insights): accepted members only; a person holding both
 * a STUDENT and an accepted OWNER/TEACHER/ASSISTANT membership is staff, never
 * a student. Rows of people who left drop out because their membership did.
 */
import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';

/** Roles that make a member part of the teaching team. */
export const TEACHING_TEAM_ROLES: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT'];

/** The classroom's current students and current teaching team (user ids, disjoint). */
export const currentMembers = async (
  classroomId: string
): Promise<{ studentIds: string[]; staffIds: string[] }> => {
  const rows = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, has_accepted_invite: true },
    select: { user_id: true, role: true },
  });
  const students = new Set<string>();
  const staff = new Set<string>();
  for (const row of rows) {
    if (row.role === 'STUDENT') students.add(row.user_id);
    else if (TEACHING_TEAM_ROLES.includes(row.role)) staff.add(row.user_id);
  }
  return { studentIds: [...students].filter(id => !staff.has(id)), staffIds: [...staff] };
};

/**
 * The classroom's current students: accepted STUDENT members holding no
 * accepted OWNER/TEACHER/ASSISTANT membership there.
 */
export const currentStudentIds = async (classroomId: string): Promise<string[]> =>
  (await currentMembers(classroomId)).studentIds;
