/**
 * Which of a member's roles in one classroom counts.
 *
 * `@@unique([classroom_id, user_id, role])` means one person really can hold
 * several rows in a classroom — an owner who is also enrolled as a student, a
 * TA who is also a student. Whoever reads "their role" has to pick one, and a
 * `findFirst` picks whichever row the database returns first: an owner can
 * come back as STUDENT and find their own page read-only. The highest privilege
 * wins, everywhere this app asks — the page editor, its save, the media
 * download route and the class site.
 *
 * Pure, so it can be shared by server modules and tested on its own.
 */

import type { Role } from '@prisma/client';

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
