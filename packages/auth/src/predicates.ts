/**
 * Pure classroom status-gate predicates — no I/O, no env, no side effects.
 *
 * This module is the single source of truth for the status × role decision
 * logic, importable from any transport without dragging in the better-auth
 * instance that `./server.ts` constructs at module load. Consumers wrap
 * these decisions in their own error presentation:
 *   - webapp: `assertClassroomEntryAllowed` / `assertClassroomMutationAllowed`
 *     in `./server.ts` throw 403 `Response`s with typed JSON bodies
 *   - apps/mcp: `assertEntryAllowed` / `assertMutationAllowed` in
 *     `apps/mcp/src/authz/pure.ts` throw JSON-RPC `ToolError`s
 */

import type { ClassroomStatus, Role } from '@prisma/client';

export type ClassroomStatusError = 'CLASSROOM_LOCKED' | 'CLASSROOM_UNPUBLISHED';

export interface ClassroomStatusInput {
  status: ClassroomStatus;
  role: Role;
}

/**
 * Entry gate: UNPUBLISHED blocks non-owner entry; LOCKED does NOT block entry.
 */
export function canEnterClassroom({ status, role }: ClassroomStatusInput): boolean {
  return !(status === 'UNPUBLISHED' && role !== 'OWNER');
}

/**
 * Mutation gate: owners may always mutate; non-owners only when ACTIVE
 * (both LOCKED and UNPUBLISHED block non-owner mutation).
 */
export function canMutateClassroom({ status, role }: ClassroomStatusInput): boolean {
  if (role === 'OWNER') return true;
  return status === 'ACTIVE';
}
