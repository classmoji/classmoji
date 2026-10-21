import getPrisma from '@classmoji/database';
import type { ClassroomStatus, Prisma } from '@prisma/client';
import * as auditService from './audit.service.ts';
import { PLAN_ACTIVE_CLASSROOM_LIMITS } from './planLimits.ts';
import * as planOwnerService from './planOwner.service.ts';
import type { ActiveClassroomSummary, PlanOwnerChange } from './planOwner.service.ts';
import * as subscriptionService from './subscription.service.ts';

/**
 * Every change to a classroom's lifecycle (`status`, `is_archived`), and the
 * Free plan's one-active-class rule that guards it.
 *
 * The rule: a classroom counts against its plan owner (`planOwner.service.ts`)
 * while it is ACTIVE, is not the Example Course, and no accepted owner is Pro.
 * `is_archived` does not change that: an ACTIVE classroom that is only flagged
 * archived is still open for writes, so it still counts. Only `status` frees a
 * slot. Nothing is ever locked automatically; the rule only refuses NEW active
 * classrooms (a create, or any other status going to ACTIVE).
 *
 * Archive = LOCKED + is_archived; unarchive = ACTIVE + not archived, gated.
 *
 * Concurrency: every write here locks the classroom rows it changes (sorted by
 * id), then takes a transaction advisory lock per plan owner it counts for, and
 * only then counts. Two creates or reactivations for one plan owner serialize
 * on that lock, so they cannot both take the last slot.
 *
 * Successful changes are audited as the acting owner. Refusals are not audit
 * rows (nothing changed, and a refused create has no classroom to file it
 * under); they are one structured log line, `plan_limit.active_course_refused`.
 */

type Tx = Prisma.TransactionClient;
type Status = ClassroomStatus;

export const ACTIVE_CLASSROOM_LIMIT = 'PLAN_ACTIVE_CLASSROOM_LIMIT';
export const NO_PLAN_OWNER = 'NO_PLAN_OWNER';

export type LimitedAction = 'CREATE' | 'REACTIVATE' | 'IMPORT';

/**
 * Refused by the one-active-class rule. `activeClassrooms` (the plan owner's
 * counted classrooms, so the page can offer "Archive X and continue") is only
 * filled in when the person acting IS the plan owner: a co-owner is never shown
 * the names of someone else's classes.
 */
export class ActiveClassroomLimitError extends Error {
  readonly code = ACTIVE_CLASSROOM_LIMIT;
  constructor(
    message: string,
    readonly limit: number,
    readonly activeClassrooms: ActiveClassroomSummary[] | null
  ) {
    super(message);
    this.name = 'ActiveClassroomLimitError';
  }
}

export const isActiveClassroomLimitError = (error: unknown): error is ActiveClassroomLimitError =>
  error instanceof Error && (error as { code?: unknown }).code === ACTIVE_CLASSROOM_LIMIT;

const OWNER_LIMIT_MESSAGE =
  'The Free plan includes one active class at a time. Archive your current class to start ' +
  'another, or upgrade to Pro.';
const CO_OWNER_LIMIT_MESSAGE =
  "This class's plan owner already has an active class on the Free plan. They can archive " +
  'that class or upgrade to Pro.';

/** Serialize every slot decision for one plan owner, until the transaction ends. */
const lockPlanOwner = async (tx: Tx, userId: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plan-owner:${userId}`}))`;
};

interface LockedRow {
  id: string;
  status: Status;
  is_archived: boolean;
  plan_owner_id: string | null;
}

/** Row-lock these classrooms, in id order, and return what they hold now. */
const lockClassrooms = async (tx: Tx, ids: string[]): Promise<Map<string, LockedRow>> => {
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT id, status::text AS status, is_archived, plan_owner_id
    FROM classrooms WHERE id = ANY(${sorted}) ORDER BY id FOR UPDATE`;
  return new Map(rows.map(row => [row.id, row]));
};

const logRefusal = (fields: Record<string, unknown>): void => {
  console.info(JSON.stringify({ event: 'plan_limit.active_course_refused', ...fields }));
};

/**
 * Refuse unless `planOwnerId` has a free slot besides `excludeClassroomId`.
 * The caller holds the plan-owner lock.
 */
const assertRoomFor = async (
  tx: Tx,
  planOwnerId: string,
  {
    excludeClassroomId,
    actorUserId,
    action,
  }: { excludeClassroomId?: string; actorUserId: string; action: LimitedAction }
): Promise<void> => {
  const limit = PLAN_ACTIVE_CLASSROOM_LIMITS.FREE;
  if (limit === null) return;

  const active = await planOwnerService.listActiveFreeClassrooms(planOwnerId, {
    excludeClassroomId,
    db: tx,
  });
  if (active.length < limit) return;

  logRefusal({
    user_id: actorUserId,
    plan_owner_id: planOwnerId,
    action,
    active_count: active.length,
  });
  const isPlanOwner = actorUserId === planOwnerId;
  throw new ActiveClassroomLimitError(
    isPlanOwner ? OWNER_LIMIT_MESSAGE : CO_OWNER_LIMIT_MESSAGE,
    limit,
    isPlanOwner ? active : null
  );
};

/**
 * Gate one classroom going to ACTIVE. The classroom row is already locked.
 * Repairs a stale plan owner on the way (this is an authenticated mutation),
 * and returns that repair for the audit.
 */
const assertCanActivate = async (
  tx: Tx,
  row: LockedRow,
  actorUserId: string,
  action: LimitedAction
): Promise<PlanOwnerChange | null> => {
  const planOwnerId = await planOwnerService.effectivePlanOwnerId(row.id, tx);
  if (!planOwnerId) {
    throw Object.assign(
      new Error('This class has no owner who has accepted, so it cannot be made active.'),
      { code: NO_PLAN_OWNER }
    );
  }

  let repair: PlanOwnerChange | null = null;
  if (row.plan_owner_id !== planOwnerId) {
    await tx.classroom.update({ where: { id: row.id }, data: { plan_owner_id: planOwnerId } });
    repair = { classroomId: row.id, from: row.plan_owner_id, to: planOwnerId };
  }

  const { isPro } = await subscriptionService.getProStateForClassroomId(row.id);
  if (isPro) return repair;

  await lockPlanOwner(tx, planOwnerId);
  await assertRoomFor(tx, planOwnerId, { excludeClassroomId: row.id, actorUserId, action });
  return repair;
};

interface Lifecycle {
  status: Status;
  is_archived: boolean;
}

const auditLifecycle = async (
  classroomId: string,
  actorUserId: string,
  tool: string,
  from: Lifecycle,
  to: Lifecycle
): Promise<void> => {
  if (from.status === to.status && from.is_archived === to.is_archived) return;
  await auditService.create(
    {
      user_id: actorUserId,
      classroom_id: classroomId,
      role: 'OWNER',
      resource_type: 'CLASSROOM',
      resource_id: classroomId,
      action: 'UPDATE',
      data: { tool, from: { ...from }, to: { ...to } },
    },
    { dedupe: false }
  );
};

const auditRepair = async (repair: PlanOwnerChange | null, actorUserId: string) => {
  if (repair) {
    await planOwnerService.auditPlanOwnerChange(repair, { actorUserId, reason: 'owner_left' });
  }
};

/**
 * Set a classroom's `status` and/or `is_archived`. Going to ACTIVE from any
 * other status is gated by the one-active-class rule; ACTIVE to ACTIVE is a
 * no-op that is always allowed. Callers authorize the actor as an OWNER first.
 *
 * @throws ActiveClassroomLimitError, or an Error with `code = NO_PLAN_OWNER`.
 */
export const setLifecycle = async ({
  classroomId,
  status,
  isArchived,
  actorUserId,
  tool,
}: {
  classroomId: string;
  status?: Status;
  isArchived?: boolean;
  actorUserId: string;
  /** The surface, for the audit row (`web:classroom.status`, `classroom_status_update`, ...). */
  tool: string;
}): Promise<Lifecycle> => {
  const { before, after, repair } = await getPrisma().$transaction(async tx => {
    const row = (await lockClassrooms(tx, [classroomId])).get(classroomId);
    if (!row) throw new Error('Classroom not found');

    const next: Lifecycle = {
      status: status ?? row.status,
      is_archived: isArchived ?? row.is_archived,
    };
    const repair =
      next.status === 'ACTIVE' && row.status !== 'ACTIVE'
        ? await assertCanActivate(tx, row, actorUserId, 'REACTIVATE')
        : null;

    const after = await tx.classroom.update({
      where: { id: classroomId },
      data: next,
      select: { status: true, is_archived: true },
    });
    return { before: { status: row.status, is_archived: row.is_archived }, after, repair };
  });

  await auditRepair(repair, actorUserId);
  await auditLifecycle(classroomId, actorUserId, tool, before, after);
  return after;
};

/** Archive: read-only for everyone but owners, off the landing list and the public site. */
export const archive = (args: { classroomId: string; actorUserId: string; tool: string }) =>
  setLifecycle({ ...args, status: 'LOCKED', isArchived: true });

/** Unarchive: back to ACTIVE, which the one-active-class rule may refuse. */
export const unarchive = (args: { classroomId: string; actorUserId: string; tool: string }) =>
  setLifecycle({ ...args, status: 'ACTIVE', isArchived: false });

/**
 * Archive one classroom and activate another in ONE transaction: the
 * "Archive X and continue" step after a new classroom was provisioned (as
 * LOCKED, so it held no slot while that ran). Both rows are locked in id order
 * before the plan-owner lock. If the activation is refused, nothing changes,
 * the archive included.
 *
 * The actor must be an accepted OWNER of the classroom being archived.
 */
export const swapActive = async ({
  activateClassroomId,
  archiveClassroomId,
  actorUserId,
  tool,
}: {
  activateClassroomId: string;
  archiveClassroomId: string;
  actorUserId: string;
  tool: string;
}): Promise<void> => {
  const result = await getPrisma().$transaction(async tx => {
    const rows = await lockClassrooms(tx, [activateClassroomId, archiveClassroomId]);
    const toActivate = rows.get(activateClassroomId);
    const toArchive = rows.get(archiveClassroomId);
    if (!toActivate || !toArchive) throw new Error('Classroom not found');

    const owns = await tx.classroomMembership.findFirst({
      where: {
        classroom_id: archiveClassroomId,
        user_id: actorUserId,
        role: 'OWNER',
        has_accepted_invite: true,
      },
      select: { id: true },
    });
    if (!owns) throw new Error('You can only archive a class you own.');

    await tx.classroom.update({
      where: { id: archiveClassroomId },
      data: { status: 'LOCKED', is_archived: true },
    });

    const repair =
      toActivate.status === 'ACTIVE'
        ? null
        : await assertCanActivate(tx, toActivate, actorUserId, 'CREATE');
    await tx.classroom.update({
      where: { id: activateClassroomId },
      data: { status: 'ACTIVE', is_archived: false },
    });

    return { toActivate, toArchive, repair };
  });

  await auditRepair(result.repair, actorUserId);
  await auditLifecycle(
    archiveClassroomId,
    actorUserId,
    tool,
    { status: result.toArchive.status, is_archived: result.toArchive.is_archived },
    { status: 'LOCKED', is_archived: true }
  );
  await auditLifecycle(
    activateClassroomId,
    actorUserId,
    tool,
    { status: result.toActivate.status, is_archived: result.toActivate.is_archived },
    { status: 'ACTIVE', is_archived: false }
  );
};

/**
 * Inside the transaction that inserts a new ACTIVE classroom its creator will
 * plan-own: take the creator's plan-owner lock and refuse when they have no
 * free slot. A Pro creator's classroom is Pro, so it is never refused.
 */
export const assertCanCreateActive = async (
  tx: Tx,
  creatorUserId: string,
  action: LimitedAction = 'CREATE'
): Promise<void> => {
  await lockPlanOwner(tx, creatorUserId);
  if (await planOwnerService.userIsPro(tx, creatorUserId)) return;
  await assertRoomFor(tx, creatorUserId, { actorUserId: creatorUserId, action });
};

/**
 * The same decision as a boolean, for a path that creates the classroom LOCKED
 * instead of refusing (the Github Classroom import). Takes the lock too.
 */
export const canCreateActive = async (tx: Tx, creatorUserId: string): Promise<boolean> => {
  try {
    await assertCanCreateActive(tx, creatorUserId, 'IMPORT');
    return true;
  } catch (error) {
    if (isActiveClassroomLimitError(error)) return false;
    throw error;
  }
};

export interface ActiveClassroomAllowance {
  /** `null` = unlimited (the user is Pro). */
  limit: number | null;
  /** Their counted classrooms, oldest first. Empty when unlimited. */
  active: ActiveClassroomSummary[];
  /** Whether one more active classroom fits right now. */
  canCreate: boolean;
}

/**
 * A read for pages: the user's own allowance. Not a guard (it takes no lock);
 * the write paths above decide.
 */
export const allowanceFor = async (userId: string): Promise<ActiveClassroomAllowance> => {
  const limit = PLAN_ACTIVE_CLASSROOM_LIMITS.FREE;
  if (limit === null || (await planOwnerService.userIsPro(getPrisma(), userId))) {
    return { limit: null, active: [], canCreate: true };
  }
  const active = await planOwnerService.listActiveFreeClassrooms(userId);
  return { limit, active, canCreate: active.length < limit };
};
