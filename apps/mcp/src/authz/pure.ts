/**
 * Pure authorization predicates — no DB, no I/O, no env (plan §4, §8.1).
 *
 * Every authorization DECISION lives here as a pure function over plain
 * inputs so unit tests can cover the whole matrix without Prisma.
 * The DB lookups feeding these live in ./classroomContext.ts.
 *
 * The status gates (`canEnterClassroom` / `canMutateClassroom`) are the
 * webapp's own — imported from the side-effect-free
 * `@classmoji/auth/predicates`, the single source of truth shared with
 * `packages/auth/src/server.ts`. This module only adds the MCP error
 * presentation (`ToolError`) on top.
 */

import type { Role } from '@prisma/client';
import {
  canEnterClassroom,
  canMutateClassroom,
  type ClassroomStatusInput,
} from '@classmoji/auth/predicates';
import { ToolError } from '../mcp/errors.ts';

export { canEnterClassroom, canMutateClassroom, type ClassroomStatusInput };

// ─── Classroom addressing (locked decision 1: composite `org/slug`) ─────────

export interface ClassroomRef {
  org: string;
  slug: string;
}

/**
 * Parse a composite classroom reference of the form `org/slug`
 * (e.g. `dev-org/classmoji-dev-winter-2025`). Classroom.slug is only unique
 * per git org (`@@unique([git_org_id, slug])`), so a bare slug is ambiguous.
 */
export function parseClassroomRef(ref: unknown): ClassroomRef {
  if (typeof ref !== 'string') {
    throw new ToolError(
      'invalid_params',
      "Classroom reference must be a string of the form 'org/slug'"
    );
  }
  const parts = ref.split('/');
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new ToolError(
      'invalid_params',
      `Invalid classroom reference '${ref}' — expected 'org/slug' (e.g. 'cs-dept/cs101-fall-2025')`
    );
  }
  return { org: parts[0].trim(), slug: parts[1].trim() };
}

// ─── Classroom status gates ──────────────────────────────────────────────────

/** Throwing wrapper over canEnterClassroom with the webapp's typed error codes. */
export function assertEntryAllowed(input: ClassroomStatusInput): void {
  if (canEnterClassroom(input)) return;
  throw new ToolError(
    'forbidden',
    'This class has been unpublished by the owner.',
    'CLASSROOM_UNPUBLISHED'
  );
}

/** Throwing wrapper over canMutateClassroom with the webapp's typed error codes. */
export function assertMutationAllowed(input: ClassroomStatusInput): void {
  if (canMutateClassroom(input)) return;
  if (input.status === 'LOCKED') {
    throw new ToolError(
      'forbidden',
      'This class is in read-only mode. The owner has locked it.',
      'CLASSROOM_LOCKED'
    );
  }
  throw new ToolError(
    'forbidden',
    'This class has been unpublished by the owner.',
    'CLASSROOM_UNPUBLISHED'
  );
}

// ─── Role gating ─────────────────────────────────────────────────────────────

export interface MembershipLike {
  role: Role;
}

/**
 * Pure role gate: pick the membership that satisfies `allowedRoles`.
 *
 * `memberships` is the caller's memberships in the TARGET classroom (a user
 * can hold several roles — ClassroomMembership is unique on
 * (classroom_id, user_id, role)). `allowedRoles: null` means any member.
 *
 * Throws ToolError('forbidden') distinguishing "not a member" from
 * "insufficient role" — the same distinction assertClassroomAccess makes
 * (packages/auth/src/server.ts:627-682).
 */
export function requireRole<M extends MembershipLike>(
  memberships: readonly M[],
  allowedRoles: readonly Role[] | null
): M {
  if (memberships.length === 0) {
    throw new ToolError('forbidden', 'Not a member of this classroom', 'NOT_A_MEMBER');
  }
  if (!allowedRoles || allowedRoles.length === 0) {
    return memberships[0];
  }
  const match = memberships.find(m => allowedRoles.includes(m.role));
  if (!match) {
    throw new ToolError(
      'forbidden',
      `Required role: ${allowedRoles.join(' or ')}`,
      'INSUFFICIENT_ROLE'
    );
  }
  return match;
}
