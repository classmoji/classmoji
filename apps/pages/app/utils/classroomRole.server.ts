import type { Role } from '@prisma/client';

import { prisma } from '~/utils/db.server.ts';
import { highestRole } from './classroomRole.ts';

/**
 * A user's role in a classroom — the highest of the rows they hold there
 * (`highestRole`), or null when they hold none.
 *
 * `acceptedOnly` counts only rows whose invite was accepted, as the class site
 * does: an invited-but-never-joined user is not a member there.
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
  const rows = await prisma.classroomMembership.findMany({
    where: {
      user_id: userId,
      classroom_id: classroomId,
      ...(acceptedOnly ? { has_accepted_invite: true } : {}),
    },
    select: { role: true },
  });
  return highestRole(rows.map(row => row.role));
}
