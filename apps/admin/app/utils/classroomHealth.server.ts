import { prisma } from '~/utils/db.server';

export type Health = 'critical' | 'warning' | 'ok';

export interface ClassroomSignals {
  id: string;
  provider: string;
  hasInstallation: boolean;
  importFailed: boolean;
  checkpointErrors: number;
  accepted: number;
  pending: number;
  staff: number;
  lastActivity: Date | null;
}

/**
 * The same rules Home's Needs attention uses, per classroom: broken = the
 * Github App is missing, an import failed, or checkpoints are failing; stuck =
 * at least 5 students and 30% of the roster have not accepted.
 */
export const healthOf = (s: ClassroomSignals): { health: Health; reasons: string[] } => {
  const reasons: string[] = [];
  if (s.provider === 'GITHUB' && !s.hasInstallation) reasons.push('Github App not installed');
  if (s.importFailed) reasons.push('Import failed');
  if (s.checkpointErrors > 0) reasons.push(`${s.checkpointErrors} checkpoint error(s)`);
  if (reasons.length) return { health: 'critical', reasons };
  const total = s.accepted + s.pending;
  if (s.pending >= 5 && s.pending * 10 >= total * 3) {
    return { health: 'warning', reasons: [`${s.pending} students haven't accepted`] };
  }
  return { health: 'ok', reasons };
};

/** Signals for many classrooms in a handful of grouped queries. */
export async function loadSignals(
  classrooms: Array<{
    id: string;
    git_organization: { provider: string; github_installation_id: string | null; gitlab_connection_id: string | null };
    import_job: { status: string } | null;
  }>
): Promise<Map<string, ClassroomSignals>> {
  const ids = classrooms.map(c => c.id);
  if (ids.length === 0) return new Map();
  const [members, checkpoints, views] = await Promise.all([
    prisma.classroomMembership.findMany({
      where: { classroom_id: { in: ids } },
      select: { classroom_id: true, user_id: true, role: true, has_accepted_invite: true },
    }),
    prisma.collabDoc.groupBy({
      by: ['classroom_id'],
      where: { classroom_id: { in: ids }, last_checkpoint_error: { not: null } },
      _count: { _all: true },
    }),
    prisma.resourceView.groupBy({
      by: ['classroom_id'],
      where: { classroom_id: { in: ids } },
      _max: { last_viewed_at: true },
    }),
  ]);

  const out = new Map<string, ClassroomSignals>();
  for (const c of classrooms) {
    out.set(c.id, {
      id: c.id,
      provider: c.git_organization.provider,
      hasInstallation:
        c.git_organization.provider === 'GITLAB'
          ? Boolean(c.git_organization.gitlab_connection_id)
          : Boolean(c.git_organization.github_installation_id),
      importFailed: c.import_job?.status === 'FAILED',
      checkpointErrors: 0,
      accepted: 0,
      pending: 0,
      staff: 0,
      lastActivity: null,
    });
  }
  const staffSets = new Map<string, Set<string>>();
  for (const m of members) {
    const s = out.get(m.classroom_id);
    if (!s) continue;
    if (m.role === 'STUDENT') {
      if (m.has_accepted_invite) s.accepted += 1;
      else s.pending += 1;
    } else {
      // People, not role rows: an owner who also teaches is one person.
      const set = staffSets.get(m.classroom_id) ?? new Set<string>();
      set.add(m.user_id);
      staffSets.set(m.classroom_id, set);
    }
  }
  for (const [id, set] of staffSets) out.get(id)!.staff = set.size;
  for (const r of checkpoints) out.get(r.classroom_id)!.checkpointErrors = r._count._all;
  for (const r of views) out.get(r.classroom_id)!.lastActivity = r._max.last_viewed_at ?? null;
  return out;
}

/** Pro when an accepted owner holds a current Pro subscription. */
export async function loadPlans(classroomIds: string[]): Promise<Map<string, 'Pro' | 'Free'>> {
  const now = new Date();
  const owners = await prisma.classroomMembership.findMany({
    where: { classroom_id: { in: classroomIds }, role: 'OWNER', has_accepted_invite: true },
    select: {
      classroom_id: true,
      user: {
        select: {
          subscriptions: {
            orderBy: { created_at: 'desc' },
            take: 1,
            select: { tier: true, ends_at: true },
          },
        },
      },
    },
  });
  const plans = new Map<string, 'Pro' | 'Free'>(classroomIds.map(id => [id, 'Free']));
  for (const o of owners) {
    const sub = o.user.subscriptions[0];
    if (sub?.tier === 'PRO' && (!sub.ends_at || sub.ends_at > now)) plans.set(o.classroom_id, 'Pro');
  }
  return plans;
}
