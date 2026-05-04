import type { Role } from '@prisma/client';

/**
 * Role-set helpers for tool/resource registration gating.
 *
 * Three tiers, matching the webapp's route auth helpers in
 * `packages/auth/src/server.ts`:
 *
 *   OWNER         — `requireClassroomAdmin`     (classroom-level policy: settings, mappings,
 *                                                privilege grants)
 *   STAFF         — `requireClassroomStaff`     (OWNER + TEACHER: curriculum + grading work)
 *   TEACHING_TEAM — `requireClassroomTeachingTeam` (OWNER + TEACHER + ASSISTANT:
 *                                                  observation, lightweight grading)
 *
 * `AuthContext.roles` is the union across all classroom memberships, so tool
 * registration uses *…InAny — the per-classroom check inside each handler
 * enforces correctness for the specific classroom being operated on.
 */

export const OWNER_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER']);
export const STAFF_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'TEACHER']);
export const TEACHING_TEAM_ROLES: ReadonlySet<Role> = new Set<Role>([
  'OWNER',
  'TEACHER',
  'ASSISTANT',
]);

export const isOwnerInAny = (roles: Set<Role>): boolean => roles.has('OWNER');

export const isStaffInAny = (roles: Set<Role>): boolean => {
  for (const r of roles) if (STAFF_ROLES.has(r)) return true;
  return false;
};

export const isTeachingInAny = (roles: Set<Role>): boolean => {
  for (const r of roles) if (TEACHING_TEAM_ROLES.has(r)) return true;
  return false;
};

export const isStudentInAny = (roles: Set<Role>): boolean => roles.has('STUDENT');

/**
 * Returns the highest-privilege role from a set, used for audit logging.
 */
export function highestRole(roles: Set<Role> | Role[]): Role {
  const set = roles instanceof Set ? roles : new Set(roles);
  if (set.has('OWNER')) return 'OWNER';
  if (set.has('TEACHER')) return 'TEACHER';
  if (set.has('ASSISTANT')) return 'ASSISTANT';
  return 'STUDENT';
}
