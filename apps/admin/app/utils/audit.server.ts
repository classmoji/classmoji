import type { Prisma } from '@prisma/client';
import { prisma } from '~/utils/db.server';

/**
 * Writes one platform audit row (see PlatformAuditLog). Awaited by callers:
 * an action that cannot be recorded does not happen. Feedback actions never
 * come through here (decided for #739).
 */
export const platformAudit = (entry: {
  actorId: string;
  action: 'impersonate' | 'delivery.toggle' | 'delivery.bulk' | 'user.view' | 'classroom.view';
  targetType: 'user' | 'classroom' | 'classrooms';
  targetId?: string | null;
  classroomId?: string | null;
  data?: Prisma.InputJsonValue;
}) =>
  prisma.platformAuditLog.create({
    data: {
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      classroom_id: entry.classroomId ?? null,
      data: entry.data,
    },
  });

/**
 * A staff read of other people's data, audited once per admin, target and
 * 10 minutes so reloads and tab switches don't flood the log.
 */
export const auditView = async (entry: {
  actorId: string;
  action: 'user.view' | 'classroom.view';
  targetType: 'user' | 'classroom';
  targetId: string;
  classroomId?: string | null;
  data?: Prisma.InputJsonValue;
}) => {
  const recent = await prisma.platformAuditLog.findFirst({
    where: {
      actor_id: entry.actorId,
      action: entry.action,
      target_id: entry.targetId,
      created_at: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (!recent) await platformAudit(entry);
};
