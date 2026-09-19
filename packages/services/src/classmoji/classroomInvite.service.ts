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
 * Find invites matching any of the given emails (case-insensitive).
 * Used during registration to claim invites issued to either the student's
 * school email or the email on their GitHub profile.
 */
export const findInvitesByAnyEmail = async (
  emails: (string | null | undefined)[]
): Promise<Prisma.ClassroomInviteGetPayload<{ include: { classroom: true } }>[]> => {
  const candidates = Array.from(
    new Set(emails.filter((e): e is string => !!e && e.trim().length > 0).map(e => e.trim()))
  );
  if (candidates.length === 0) return [];
  return getPrisma().classroomInvite.findMany({
    where: {
      OR: candidates.map(email => ({
        school_email: { equals: email, mode: 'insensitive' as const },
      })),
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

/**
 * Claim every pending invite addressed to this user, under either address we
 * hold for them (`email` and `provider_email`).
 *
 * Called on login and whenever an email changes, NOT only at registration. An
 * invite issued to an address the student did not register with used to strand
 * them permanently: the single claim path ran once and never again, so the
 * membership was never created and the invite sat pending forever, with nothing
 * surfacing the failure to either party.
 *
 * Idempotent by construction, because both callers run repeatedly:
 * `createMany({ skipDuplicates: true })` against the
 * `(classroom_id, user_id, role)` unique key. A plain `create` throws P2002 the
 * second time, which is exactly what the registration loop used to do.
 *
 * The membership write and the invite delete share one transaction, so an
 * invite is never consumed without the membership landing.
 *
 * Deliberately does NOT filter by classroom status, matching `roster.addStudents`,
 * which enrols an existing user with no status check either — one rule for how a
 * student lands on a roster, whether or not they already had an account.
 *
 * Be precise about what that means, because the obvious reassurance is wrong:
 * `canEnterClassroom` only refuses UNPUBLISHED, so an ARCHIVED classroom's invite
 * really does resolve, and the student gets a card in the Archived section. That
 * is the same card `addStudents` would have given them.
 */
export const claimPendingInvites = async (
  userId: string
): Promise<{ claimed: number; classroomIds: string[] }> => {
  const prisma = getPrisma();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, provider_email: true },
  });
  if (!user) return { claimed: 0, classroomIds: [] };

  const invites = await findInvitesByAnyEmail([user.email, user.provider_email]);
  if (invites.length === 0) return { claimed: 0, classroomIds: [] };

  // One membership per classroom even if the same classroom invited both of the
  // user's addresses, or the same address under two casings — `school_email` is
  // stored as typed and its unique key is case-sensitive.
  const classroomIds = Array.from(new Set(invites.map(invite => invite.classroom_id)));

  await prisma.$transaction([
    prisma.classroomMembership.createMany({
      data: classroomIds.map(classroom_id => ({
        classroom_id,
        user_id: userId,
        role: 'STUDENT' as const,
        has_accepted_invite: false,
      })),
      skipDuplicates: true,
    }),
    prisma.classroomInvite.deleteMany({
      where: { id: { in: invites.map(invite => invite.id) } },
    }),
  ]);

  return { claimed: classroomIds.length, classroomIds };
};
