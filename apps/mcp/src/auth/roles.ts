import type { Role } from '@prisma/client';

/**
 * Role-set helpers for tool/resource registration gating.
 *
 * `AuthContext.roles` is the union of all roles a user holds across all
 * their classroom memberships. Tool registration checks "does the user hold
 * any qualifying role somewhere?" — so e.g. a teacher in CS52 sees admin
 * tools even when they later try to use them in CS98 (where they're only a
 * student). The per-classroom check inside the handler enforces correctness.
 */

export const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(['OWNER', 'TEACHER']);
export const TEACHING_TEAM_ROLES: ReadonlySet<Role> = new Set<Role>([
  'OWNER',
  'TEACHER',
  'ASSISTANT',
]);

export const isAdminInAny = (roles: Set<Role>): boolean => {
  for (const r of roles) if (ADMIN_ROLES.has(r)) return true;
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
