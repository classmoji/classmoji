/**
 * The audit rows of a staff removal (STAFF, on the person), written for the
 * owner who removed them once the caller knows the outcome: the web Teaching
 * Staff action and the MCP staff_remove both write through here, so the rows'
 * shape and the follow-up markers `staff.previewLeftoverSlots` reads back live
 * in one place. No database access of its own beyond the audit writer, so a
 * test can run the real rows over a fake writer (`…With`).
 */
import {
  create,
  recordForActorWith,
  type AuditActor,
  type AuditLogData,
  type ServiceAudit,
} from './audit.service.ts';
import type { UngradedChoice } from './graderReassignPlan.ts';
import type { StaffRole } from './staff.service.ts';
import type { UngradedSlotsOutcome } from '../helper/index.ts';

/**
 * The `data.tool` of the rows `previewLeftoverSlots` reads back: the MCP's
 * staff_remove. Only rows written under it carry the follow-up markers.
 */
export const STAFF_REMOVE_FOLLOWUP_TOOL = 'staff_remove';

/** Where a removal run stood when its row was written. */
export type StaffRemovalState =
  /** Queued, and the caller did not wait for it. */
  | 'queued'
  | 'completed'
  | 'failed'
  /** Still running when the MCP stopped waiting: a follow-up marker. */
  | 'pending'
  /** Still running when the web stopped waiting: no follow-up is offered. */
  | 'in_progress';

export interface StaffRemovalAudit {
  classroomId: string;
  /** The person whose role was removed. */
  userId: string;
  role: StaffRole;
  /** The decision for their ungraded submissions; null when none was at stake. */
  choice: UngradedChoice | null;
  removal: StaffRemovalState;
  /** What became of the ungraded submissions: ids and counts only. */
  ungraded: Record<string, unknown> | null;
  /**
   * Why a completed removal leaves the slots open for a follow-up call. Kept
   * only on a row written under STAFF_REMOVE_FOLLOWUP_TOOL.
   */
  followup?: 'needs_decision' | 'settle_deferred' | null;
  /** The git login, which the MCP's row has always carried; the web's leaves it out. */
  login?: string;
}

/**
 * Record a staff removal (STAFF, DELETE, on the person) for `actor`, once the
 * caller knows what became of it: the role removed, where the run stood and
 * what became of their ungraded submissions. Written by the web Teaching
 * Staff action and the MCP staff_remove alike.
 *
 * The follow-up markers `previewLeftoverSlots` reads (`removal: 'pending'`,
 * `needs_decision`, `settle_deferred`) are kept only on a row written under
 * STAFF_REMOVE_FOLLOWUP_TOOL: a row of any other surface never leaves a
 * removal open for a follow-up (`'pending'` is written as `'in_progress'`).
 */
export const recordStaffRemoval = (
  actor: AuditActor | null,
  record: StaffRemovalAudit
): Promise<ServiceAudit> => recordStaffRemovalWith(create, actor, record);

/** `recordStaffRemoval` over any writer with `create`'s contract (tests). */
export const recordStaffRemovalWith = (
  write: (row: AuditLogData) => Promise<unknown>,
  actor: AuditActor | null,
  record: StaffRemovalAudit
): Promise<ServiceAudit> => {
  const followupAllowed = actor?.tool === STAFF_REMOVE_FOLLOWUP_TOOL;
  const removal = !followupAllowed && record.removal === 'pending' ? 'in_progress' : record.removal;
  return recordForActorWith(write, actor, {
    classroomId: record.classroomId,
    resourceType: 'STAFF',
    resourceId: record.userId,
    action: 'DELETE',
    data: {
      // `value`: the role removed and what became of it.
      value: `${record.role}:${record.choice ?? 'none'}`,
      user_id: record.userId,
      ...(record.login !== undefined ? { login: record.login } : {}),
      role: record.role,
      removal,
      ...(followupAllowed && record.followup ? { [record.followup]: true } : {}),
      ...(record.ungraded ? { ungraded_submissions: record.ungraded } : {}),
    },
  });
};

/**
 * Record the follow-up that settled a finished removal's ungraded submissions
 * (STAFF, UPDATE, on the person; `removal: 'already_done'`), for `actor`.
 */
export interface LeftoverSettledAudit {
  classroomId: string;
  userId: string;
  role: StaffRole;
  choice: UngradedChoice;
  ungraded: Record<string, unknown>;
  login?: string;
}

export const recordLeftoverSettled = (
  actor: AuditActor | null,
  record: LeftoverSettledAudit
): Promise<ServiceAudit> => recordLeftoverSettledWith(create, actor, record);

/** `recordLeftoverSettled` over any writer with `create`'s contract (tests). */
export const recordLeftoverSettledWith = (
  write: (row: AuditLogData) => Promise<unknown>,
  actor: AuditActor | null,
  record: LeftoverSettledAudit
): Promise<ServiceAudit> =>
  recordForActorWith(write, actor, {
    classroomId: record.classroomId,
    resourceType: 'STAFF',
    resourceId: record.userId,
    action: 'UPDATE',
    data: {
      value: `leftover:${record.role}:${record.choice}`,
      user_id: record.userId,
      ...(record.login !== undefined ? { login: record.login } : {}),
      role: record.role,
      removal: 'already_done',
      ungraded_submissions: record.ungraded,
    },
  });

/**
 * What became of a departing grader's ungraded submissions, as a staff
 * removal's audit row states it: the choice and counts, no names or logins.
 */
export const ungradedOutcomeCounts = (outcome: UngradedSlotsOutcome) => ({
  choice: outcome.choice,
  total: outcome.total,
  reassigned: outcome.reassigned.reduce((sum, r) => sum + r.count, 0),
  unassigned: outcome.unassigned + outcome.alreadyCovered,
  ...(outcome.unassignedIneligible > 0
    ? { unassigned_grader_ineligible: outcome.unassignedIneligible }
    : {}),
  kept: outcome.kept,
  failed: outcome.failed,
  queued: outcome.queued,
  ...(outcome.fallback ? { fallback: outcome.fallback } : {}),
});

/**
 * The same counts while nothing has happened to the slots yet (the removal is
 * still running): every count is zero, so a removal row's
 * `ungraded_submissions` has one shape whatever the run's state.
 */
export const ungradedCountsBeforeSettling = (choice: UngradedChoice, total: number) => ({
  choice,
  total,
  reassigned: 0,
  unassigned: 0,
  kept: 0,
  failed: 0,
  queued: false,
});
