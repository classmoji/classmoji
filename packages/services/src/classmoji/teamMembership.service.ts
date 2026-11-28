import getPrisma from '@classmoji/database';
import {
  NO_SERVICE_AUDIT,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from './audit.service.ts';

/** Who a membership row is recorded under: the team, in its classroom. */
interface TeamRef {
  id: string;
  slug: string;
  classroom_id: string;
}

/**
 * Put a user on a team. Idempotent: a membership that already exists is left
 * as it is (`added: false`). A membership this call created is recorded for
 * `actor`: TEAMS / UPDATE on the team, with its `team_id`, `slug`, the
 * `user_id` and `added: true`. Nothing created, or `actor: null`: no row.
 */
export const addMemberToTeam = async (
  team: TeamRef,
  userId: string,
  actor: AuditActor | null
): Promise<{ added: boolean; audit: ServiceAudit }> => {
  // One statement that inserts or does nothing, so whether this call created
  // the row is the write's own answer.
  const { count } = await getPrisma().teamMembership.createMany({
    data: [{ team_id: team.id, user_id: userId }],
    skipDuplicates: true,
  });
  if (count === 0) return { added: false, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId: team.classroom_id,
    resourceType: 'TEAMS',
    resourceId: team.id,
    action: 'UPDATE',
    data: { team_id: team.id, slug: team.slug, user_id: userId, added: true },
  });
  return { added: true, audit };
};

/**
 * Idempotent by design: deleteMany reports `{ count: 0 }` for a membership that
 * is already gone, where the previous `delete` threw P2025 and turned a
 * repeated (or raced) removal into a 500.
 *
 * A membership this call removed is recorded for `actor`: TEAMS / UPDATE on
 * the team, with its `team_id`, `slug`, the `user_id` and `removed: true`.
 * Nothing removed, or `actor: null`: no row.
 */
export const removeMemberFromTeam = async (
  team: TeamRef,
  userId: string,
  actor: AuditActor | null
): Promise<{ count: number; audit: ServiceAudit }> => {
  const { count } = await getPrisma().teamMembership.deleteMany({
    where: {
      team_id: team.id,
      user_id: userId,
    },
  });
  if (count === 0) return { count, audit: NO_SERVICE_AUDIT };
  const audit = await recordForActor(actor, {
    classroomId: team.classroom_id,
    resourceType: 'TEAMS',
    resourceId: team.id,
    action: 'UPDATE',
    data: { team_id: team.id, slug: team.slug, user_id: userId, removed: true },
  });
  return { count, audit };
};

export const findTeamsByUserId = async (userId: string) => {
  return getPrisma().teamMembership.findMany({
    where: {
      user_id: userId,
    },
  });
};

/**
 * Whether the user is a member of the team. A missing id is never a member:
 * Prisma drops an `undefined` filter, so without this guard a missing team id
 * would match the user's membership in any team.
 */
export const isTeamMember = async (
  teamId: string | null | undefined,
  userId: string | null | undefined
) => {
  if (!teamId || !userId) return false;
  const membership = await getPrisma().teamMembership.findFirst({
    where: { team_id: teamId, user_id: userId },
    select: { id: true },
  });
  return membership !== null;
};
