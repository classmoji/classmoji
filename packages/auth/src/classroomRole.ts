/**
 * A member's role in one classroom, shared by every surface that asks.
 *
 * `@@unique([classroom_id, user_id, role])` means one person can hold several
 * rows in a classroom — an owner who is also enrolled as a student, a TA who
 * is also a student. Whoever reads "their role" has to pick one, and a
 * `findFirst` picks whichever row the database returns first: an owner can
 * come back as STUDENT and find their own page read-only. The highest
 * privilege wins.
 *
 * Moved from apps/pages (`app/utils/classroomRole.ts` + `.server.ts`, which
 * still hold their own copies until the pages app switches over) so the
 * collab server can run the same page edit rule. Its own subpath with no
 * better-auth instance behind it: `@classmoji/auth/classroom-role`.
 */
import type { Role } from '@prisma/client';
import getPrisma from '@classmoji/database';

/** Higher is more privileged. */
export const ROLE_PRIORITY: Record<Role, number> = {
  OWNER: 4,
  TEACHER: 3,
  ASSISTANT: 2,
  STUDENT: 1,
};

/** The most privileged of `roles`, or null when there are none. */
export function highestRole(roles: readonly Role[]): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (best === null || (ROLE_PRIORITY[role] ?? 0) > (ROLE_PRIORITY[best] ?? 0)) best = role;
  }
  return best;
}

/**
 * A user's role in a classroom — the highest of the rows they hold there, or
 * null when they hold none. `acceptedOnly` counts only rows whose invite was
 * accepted, as the class site does.
 */
export async function findClassroomRole({
  userId,
  classroomId,
  acceptedOnly = false,
}: {
  userId: string;
  classroomId: string;
  acceptedOnly?: boolean;
}): Promise<Role | null> {
  const rows = await getPrisma().classroomMembership.findMany({
    where: {
      user_id: userId,
      classroom_id: classroomId,
      ...(acceptedOnly ? { has_accepted_invite: true } : {}),
    },
    select: { role: true },
  });
  return highestRole(rows.map(row => row.role));
}

/** Today's page edit rule: OWNER or TEACHER. */
export function canEditPages(role: Role | null): boolean {
  return role === 'OWNER' || role === 'TEACHER';
}
