import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { Notification, NotificationPreference, NotificationType } from '@prisma/client';
import { tasks } from '@trigger.dev/sdk';
import { renderEmail } from './notificationEmails.ts';

const TTL_DAYS = 30;

type EmailPrefKey =
  | 'email_quiz_published'
  | 'email_page_published'
  | 'email_page_unpublished'
  | 'email_module_published'
  | 'email_module_unpublished'
  | 'email_assignment_due_date_changed'
  | 'email_assignment_graded'
  | 'email_ta_grading_assigned'
  | 'email_ta_regrade_assigned';

const PREF_FIELD_BY_TYPE: Record<NotificationType, EmailPrefKey> = {
  QUIZ_PUBLISHED: 'email_quiz_published',
  PAGE_PUBLISHED: 'email_page_published',
  PAGE_UNPUBLISHED: 'email_page_unpublished',
  MODULE_PUBLISHED: 'email_module_published',
  MODULE_UNPUBLISHED: 'email_module_unpublished',
  ASSIGNMENT_DUE_DATE_CHANGED: 'email_assignment_due_date_changed',
  ASSIGNMENT_GRADED: 'email_assignment_graded',
  TA_GRADING_ASSIGNED: 'email_ta_grading_assigned',
  TA_REGRADE_ASSIGNED: 'email_ta_regrade_assigned',
};

const DEFAULT_PREFS: Record<EmailPrefKey, boolean> = {
  email_quiz_published: true,
  email_page_published: false,
  email_page_unpublished: false,
  email_module_published: true,
  email_module_unpublished: false,
  email_assignment_due_date_changed: true,
  email_assignment_graded: true,
  email_ta_grading_assigned: true,
  email_ta_regrade_assigned: true,
};

export interface CreateNotificationsInput {
  type: NotificationType;
  classroomId?: string | null;
  recipientUserIds: string[];
  resourceType: string;
  resourceId: string;
  title: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Create notifications for a set of recipients and enqueue per-user emails
 * for those whose preference is enabled. Failures are logged and swallowed -
 * notifications must never break the primary action.
 */
export const createNotifications = async (input: CreateNotificationsInput) => {
  const {
    type,
    classroomId = null,
    recipientUserIds,
    resourceType,
    resourceId,
    title,
    metadata,
  } = input;

  const uniqueRecipientUserIds = [...new Set(recipientUserIds.filter(Boolean))];
  if (uniqueRecipientUserIds.length === 0) return { count: 0 };

  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);

  try {
    await getPrisma().notification.createMany({
      data: uniqueRecipientUserIds.map(userId => ({
        user_id: userId,
        classroom_id: classroomId,
        type,
        resource_type: resourceType,
        resource_id: resourceId,
        title,
        metadata: metadata ?? Prisma.JsonNull,
        expires_at: expiresAt,
      })),
    });
  } catch (error) {
    console.error('[notifications] createMany failed', { type, error });
    return { count: 0 };
  }

  void enqueueEmails({
    type,
    recipientUserIds: uniqueRecipientUserIds,
    classroomId,
    title,
    resourceType,
    resourceId,
    metadata,
  });

  return { count: uniqueRecipientUserIds.length };
};

export const runSafely = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch (error) {
    console.error(`[notifications] ${label} failed`, { error });
    return null;
  }
};

const asRecord = (
  value: Prisma.InputJsonValue | undefined
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const enqueueEmails = async ({
  type,
  recipientUserIds,
  classroomId,
  title,
  resourceType,
  resourceId,
  metadata,
}: {
  type: NotificationType;
  recipientUserIds: string[];
  classroomId: string | null;
  title: string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
}) => {
  const prefField = PREF_FIELD_BY_TYPE[type];

  try {
    const recipients = await getPrisma().user.findMany({
      where: { id: { in: recipientUserIds }, email: { not: null } },
      include: { notification_preference: true },
    });

    const classroom = classroomId
      ? await getPrisma().classroom.findUnique({
          where: { id: classroomId },
          select: { name: true },
        })
      : null;

    for (const user of recipients) {
      if (!user.email) continue;
      const pref = user.notification_preference;
      const enabled = pref ? pref[prefField] : DEFAULT_PREFS[prefField];
      if (!enabled) continue;

      const { subject, html } = renderEmail({
        type,
        title,
        classroomName: classroom?.name ?? null,
        resourceType,
        resourceId,
        recipientName: user.name ?? null,
        metadata: asRecord(metadata),
      });

      try {
        await tasks.trigger('send_email', { to: user.email, subject, html });
      } catch (error) {
        console.error('[notifications] email enqueue failed', { userId: user.id, type, error });
      }
    }
  } catch (error) {
    console.error('[notifications] enqueueEmails failed', { type, error });
  }
};

// ─────────────────── Bell queries ───────────────────

export const getForBell = async (userId: string, limit = 50) => {
  const prisma = getPrisma();
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { user_id: userId, expires_at: { gt: new Date() } },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        classroom: { select: { id: true, slug: true, name: true } },
      },
    }),
    prisma.notification.count({
      where: { user_id: userId, read_at: null, expires_at: { gt: new Date() } },
    }),
  ]);
  return { items, unreadCount };
};

export const markRead = async (userId: string, ids: string[]) => {
  if (ids.length === 0) return { count: 0 };
  return getPrisma().notification.updateMany({
    where: { id: { in: ids }, user_id: userId, read_at: null },
    data: { read_at: new Date() },
  });
};

export const markAllRead = async (userId: string) => {
  return getPrisma().notification.updateMany({
    where: { user_id: userId, read_at: null },
    data: { read_at: new Date() },
  });
};

export const dismiss = async (userId: string, ids: string[]) => {
  if (ids.length === 0) return { count: 0 };
  return getPrisma().notification.deleteMany({
    where: { id: { in: ids }, user_id: userId },
  });
};

// ─────────────────── Recipients ───────────────────

export const getStudentsInClassroom = async (classroomId: string): Promise<string[]> => {
  const rows = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, role: 'STUDENT', has_accepted_invite: true },
    select: { user_id: true },
  });
  return [...new Set(rows.map(r => r.user_id))];
};

export const getStudentsForModule = async (
  moduleId: string
): Promise<{ classroomId: string; studentIds: string[] }> => {
  const mod = await getPrisma().module.findUnique({
    where: { id: moduleId },
    select: { classroom_id: true },
  });
  if (!mod) return { classroomId: '', studentIds: [] };
  return {
    classroomId: mod.classroom_id,
    studentIds: await getStudentsInClassroom(mod.classroom_id),
  };
};

export const getStudentsForAssignment = async (
  assignmentId: string
): Promise<{ classroomId: string; studentIds: string[] }> => {
  const assignment = await getPrisma().assignment.findUnique({
    where: { id: assignmentId },
    select: { module: { select: { classroom_id: true } } },
  });
  const classroomId = assignment?.module.classroom_id ?? '';
  if (!classroomId) return { classroomId: '', studentIds: [] };
  return { classroomId, studentIds: await getStudentsInClassroom(classroomId) };
};

// ─────────────────── Preferences ───────────────────

export const getPreferences = async (userId: string): Promise<NotificationPreference> => {
  const existing = await getPrisma().notificationPreference.findUnique({
    where: { user_id: userId },
  });
  if (existing) return existing;
  // Upsert handles the rare race where two concurrent requests both miss findUnique.
  return getPrisma().notificationPreference.upsert({
    where: { user_id: userId },
    create: { user_id: userId },
    update: {},
  });
};

export const updatePreferences = async (
  userId: string,
  patch: Partial<Omit<NotificationPreference, 'user_id' | 'created_at' | 'updated_at'>>
) => {
  return getPrisma().notificationPreference.upsert({
    where: { user_id: userId },
    create: { user_id: userId, ...patch },
    update: patch,
  });
};

export type { Notification, NotificationPreference, NotificationType };
