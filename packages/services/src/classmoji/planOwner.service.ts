import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import * as auditService from './audit.service.ts';
import { PLAN_ACTIVE_CLASSROOM_LIMITS } from './planLimits.ts';
import { pickEffectivePlanOwner } from './planOwnerPick.ts';
import * as subscriptionService from './subscription.service.ts';

/**
 * A classroom's plan owner: the one accepted OWNER whose Free-plan slot the
 * classroom consumes when no accepted owner is Pro (`classrooms.plan_owner_id`).
 *
 * Set at creation to the creator, backfilled to the oldest accepted owner, and
 * handed on when the plan owner stops being an owner. It is NOT "whose plan
 * governs the classroom": any accepted owner with an active Pro still makes the
 * whole classroom Pro (`getProStateForClassroomId`).
 *
 * Reads never write. `effectivePlanOwnerId` resolves a NULL or stale column by
 * falling back to the oldest accepted owner without persisting it; the column
 * is only changed inside the mutations below, which know who is acting.
 */

type Db = Prisma.TransactionClient;

export const LAST_OWNER_ERROR = 'Cannot remove the last owner of a classroom';

/** Accepted OWNER user ids, oldest membership first (the fallback order). */
const acceptedOwnerIds = async (db: Db, classroomId: string): Promise<string[]> => {
  const rows = await db.classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'OWNER', has_accepted_invite: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { user_id: true },
  });
  return rows.map(row => row.user_id);
};

/** The classroom's plan owner, resolved. Null when it has no accepted owner. */
export const effectivePlanOwnerId = async (
  classroomId: string,
  db: Db = getPrisma()
): Promise<string | null> => {
  const classroom = await db.classroom.findUnique({
    where: { id: classroomId },
    select: { plan_owner_id: true },
  });
  if (!classroom) return null;
  return pickEffectivePlanOwner(classroom.plan_owner_id, await acceptedOwnerIds(db, classroomId));
};

/** Whether this user's own latest subscription is an active Pro. */
const userIsPro = async (db: Db, userId: string): Promise<boolean> => {
  const latest = await db.subscription.findFirst({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
  });
  return latest?.tier === 'PRO' && subscriptionService.isSubscriptionActive(latest);
};

/**
 * How many classrooms use up this user's Free-plan slots: they are the stored
 * plan owner and still an accepted OWNER, the classroom is ACTIVE (whatever its
 * `is_archived`), it is not the Example Course, and no accepted owner makes it
 * Pro.
 */
export const countActiveFreeClassrooms = async (
  userId: string,
  { excludeClassroomId, db = getPrisma() }: { excludeClassroomId?: string; db?: Db } = {}
): Promise<number> => {
  const classrooms = await db.classroom.findMany({
    where: {
      plan_owner_id: userId,
      status: 'ACTIVE',
      is_example: false,
      ...(excludeClassroomId ? { id: { not: excludeClassroomId } } : {}),
      memberships: { some: { user_id: userId, role: 'OWNER', has_accepted_invite: true } },
    },
    select: { id: true },
  });

  let count = 0;
  for (const { id } of classrooms) {
    const { isPro } = await subscriptionService.getProStateForClassroomId(id);
    if (!isPro) count++;
  }
  return count;
};

/** Whether the user can take on one more Free-plan active classroom. */
const hasFreeCapacity = async (db: Db, userId: string, classroomId: string): Promise<boolean> => {
  const limit = PLAN_ACTIVE_CLASSROOM_LIMITS.FREE;
  if (limit === null) return true;
  const used = await countActiveFreeClassrooms(userId, { excludeClassroomId: classroomId, db });
  return used < limit;
};

/**
 * Who takes the classroom over when its plan owner leaves, among the OTHER
 * accepted owners: one with an active Pro first, else the oldest with Free
 * capacity left, else the oldest (who is then over the limit; nothing is locked
 * for it). Null when there is no other accepted owner.
 */
export const pickSuccessor = async (
  db: Db,
  classroomId: string,
  leavingUserId: string
): Promise<string | null> => {
  const others = (await acceptedOwnerIds(db, classroomId)).filter(id => id !== leavingUserId);
  if (others.length === 0) return null;

  for (const id of others) {
    if (await userIsPro(db, id)) return id;
  }
  for (const id of others) {
    if (await hasFreeCapacity(db, id, classroomId)) return id;
  }
  return others[0];
};

/**
 * Refuse a removal or demotion that would leave the classroom without an owner
 * who has accepted. A pending owner invitation does not keep a classroom
 * owned: it cannot be the plan owner and may never be accepted.
 *
 * Removing a PENDING owner only needs some other owner row to remain (it never
 * held the classroom).
 */
export const assertOwnerRemains = async (
  db: Db,
  classroomId: string,
  leavingUserId: string
): Promise<void> => {
  const leaving = await db.classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: leavingUserId, role: 'OWNER' },
    select: { id: true, has_accepted_invite: true },
  });
  if (!leaving) return;

  const remaining = await db.classroomMembership.count({
    where: {
      classroom_id: classroomId,
      role: 'OWNER',
      id: { not: leaving.id },
      ...(leaving.has_accepted_invite ? { has_accepted_invite: true } : {}),
    },
  });
  if (remaining === 0) throw new Error(LAST_OWNER_ERROR);
};

export interface PlanOwnerChange {
  classroomId: string;
  from: string | null;
  to: string | null;
}

/**
 * Hand the classroom on before `leavingUserId` stops being an accepted OWNER.
 * Call inside the transaction that removes or demotes them, after the classroom
 * row lock and `assertOwnerRemains`. Returns the change to audit, or null when
 * they were not the plan owner.
 */
export const handOffPlanOwnership = async (
  db: Db,
  classroomId: string,
  leavingUserId: string
): Promise<PlanOwnerChange | null> => {
  const current = await effectivePlanOwnerId(classroomId, db);
  if (current !== leavingUserId) return null;

  const to = await pickSuccessor(db, classroomId, leavingUserId);
  await db.classroom.update({ where: { id: classroomId }, data: { plan_owner_id: to } });
  return { classroomId, from: leavingUserId, to };
};

/**
 * A user who just became an accepted OWNER takes over any classroom of theirs
 * with no plan owner (one whose plan owner's account was deleted, or that only
 * ever had pending owners). Returns the classrooms claimed, to audit.
 */
export const claimVacantPlanOwnership = async (
  userId: string,
  db: Db = getPrisma()
): Promise<PlanOwnerChange[]> => {
  const vacant = await db.classroom.findMany({
    where: {
      plan_owner_id: null,
      memberships: { some: { user_id: userId, role: 'OWNER', has_accepted_invite: true } },
    },
    select: { id: true },
  });

  const claimed: PlanOwnerChange[] = [];
  for (const { id } of vacant) {
    // Re-checked in the write: another owner may have claimed it meanwhile.
    const { count } = await db.classroom.updateMany({
      where: { id, plan_owner_id: null },
      data: { plan_owner_id: userId },
    });
    if (count === 1) claimed.push({ classroomId: id, from: null, to: userId });
  }
  return claimed;
};

/**
 * Audit a plan-owner change as the owner who caused it. Without an actor (a
 * system path such as account deletion) it is logged to the server log only:
 * an audit row needs a classroom member to attribute it to.
 */
export const auditPlanOwnerChange = async (
  change: PlanOwnerChange,
  { actorUserId, reason }: { actorUserId?: string | null; reason: 'owner_left' | 'owner_accepted' }
): Promise<void> => {
  if (!actorUserId) {
    console.info('[plan_owner] changed without an actor', { ...change, reason });
    return;
  }
  await auditService.create(
    {
      user_id: actorUserId,
      classroom_id: change.classroomId,
      role: 'OWNER',
      resource_type: 'CLASSROOM',
      resource_id: change.classroomId,
      action: 'UPDATE',
      data: { tool: 'plan_owner.change', reason, from: change.from, to: change.to },
    },
    { dedupe: false }
  );
};

/**
 * Call after a user's OWNER membership is accepted, by any path: they take over
 * each of their classrooms that has no plan owner, audited as them.
 */
export const onOwnerAccepted = async (userId: string): Promise<void> => {
  for (const change of await claimVacantPlanOwnership(userId)) {
    await auditPlanOwnerChange(change, { actorUserId: userId, reason: 'owner_accepted' });
  }
};
