/**
 * Pure authorization predicates — no DB, no I/O, no env (plan §4, §8.1).
 *
 * Every authorization DECISION lives here as a pure function over plain
 * inputs so Phase 1c can unit-test the whole matrix without Prisma.
 * The DB lookups feeding these live in ./classroomContext.ts.
 *
 * `canEnterClassroom` / `canMutateClassroom` mirror the webapp's status
 * gates EXACTLY. They are duplicated (not imported) because
 * `@classmoji/auth/server` constructs the better-auth instance at module
 * load, which would drag env + Prisma into pure unit tests, and its assert*
 * variants throw web `Response` objects. Keep in sync with:
 *   packages/auth/src/server.ts:818-828  (assertClassroomEntryAllowed)
 *   packages/auth/src/server.ts:831-837  (canMutateClassroom)
 * Phase 1c must add a parity test importing both modules and comparing
 * results across the full status × role matrix.
 */

import type { ClassroomStatus, Role } from '@prisma/client';
import { ToolError } from '../mcp/errors.ts';

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

export interface ClassroomStatusInput {
  status: ClassroomStatus;
  role: Role;
}

/**
 * Entry gate: UNPUBLISHED blocks non-owner entry; LOCKED does NOT block entry.
 * Mirror of assertClassroomEntryAllowed (packages/auth/src/server.ts:818-828).
 */
export function canEnterClassroom({ status, role }: ClassroomStatusInput): boolean {
  return !(status === 'UNPUBLISHED' && role !== 'OWNER');
}

/**
 * Mutation gate: non-owners may mutate only when ACTIVE (both LOCKED and
 * UNPUBLISHED block non-owner mutation). Mirror of canMutateClassroom
 * (packages/auth/src/server.ts:831-837).
 */
export function canMutateClassroom({ status, role }: ClassroomStatusInput): boolean {
  if (role === 'OWNER') return true;
  return status === 'ACTIVE';
}

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
