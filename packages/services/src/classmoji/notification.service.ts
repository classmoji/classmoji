import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { Notification, NotificationPreference, NotificationType } from '@prisma/client';
import { tasks } from '@trigger.dev/sdk';
import * as entitlementService from './entitlement.service.ts';
import { renderEmail } from './notificationEmails.ts';

const TTL_DAYS = 30;

type EmailPrefKey =
  | 'email_quiz_published'
  | 'email_page_published'
  | 'email_page_unpublished'
  | 'email_repository_published'
  | 'email_repository_unpublished'
  | 'email_assignment_due_date_changed'
  | 'email_assignment_graded'
  | 'email_ta_grading_assigned'
  | 'email_ta_regrade_assigned'
  | 'email_feedback_status_changed';

const PREF_FIELD_BY_TYPE: Record<NotificationType, EmailPrefKey> = {
  QUIZ_PUBLISHED: 'email_quiz_published',
  PAGE_PUBLISHED: 'email_page_published',
  PAGE_UNPUBLISHED: 'email_page_unpublished',
  REPOSITORY_PUBLISHED: 'email_repository_published',
  REPOSITORY_UNPUBLISHED: 'email_repository_unpublished',
  ASSIGNMENT_DUE_DATE_CHANGED: 'email_assignment_due_date_changed',
  ASSIGNMENT_GRADED: 'email_assignment_graded',
  TA_GRADING_ASSIGNED: 'email_ta_grading_assigned',
  TA_REGRADE_ASSIGNED: 'email_ta_regrade_assigned',
  FEEDBACK_STATUS_CHANGED: 'email_feedback_status_changed',
};

const DEFAULT_PREFS: Record<EmailPrefKey, boolean> = {
  email_quiz_published: true,
  email_page_published: false,
  email_page_unpublished: false,
  email_repository_published: true,
  email_repository_unpublished: false,
  email_assignment_due_date_changed: true,
  email_assignment_graded: true,
  email_ta_grading_assigned: true,
  email_ta_regrade_assigned: true,
  email_feedback_status_changed: true,
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

    // Collect first, then enqueue once. A classroom-wide notification used to
    // fire one trigger (and one Resend request) per recipient, which burns the
    // team-wide 10 req/s budget; the batch task collapses it into one request
    // per 100 recipients.
    const emails = [];

    for (const user of recipients) {
      if (!user.email) continue;
      const pref = user.notification_preference;
      const enabled = pref ? pref[prefField] : DEFAULT_PREFS[prefField];
      if (!enabled) continue;

      const { template } = renderEmail({
        type,
        title,
        classroomName: classroom?.name ?? null,
        resourceType,
        resourceId,
        recipientName: user.name ?? null,
        metadata: asRecord(metadata),
      });

      emails.push({ to: user.email, template });
    }

    if (emails.length === 0) return;

    try {
      await tasks.trigger('send_batch_email', { emails });
    } catch (error) {
      // Notifications must never break the primary action.
      console.error('[notifications] email enqueue failed', { type, count: emails.length, error });
    }
  } catch (error) {
    console.error('[notifications] enqueueEmails failed', { type, error });
  }
};

// ─────────────────── Bell queries ───────────────────

type BellRow = { type: NotificationType; classroom_id: string | null; resource_id: string };

/**
 * The quiz assignments among those these rows' ASSIGNMENT_DUE_DATE_CHANGED
 * notifications name. One query, and none when no such row is present. It
 * runs before any visibility lookup: most due-date rows name REPO assignments,
 * and one query settles all of them where a visibility lookup would cost one
 * per classroom. ASSIGNMENT_GRADED is not asked about, since its recipients
 * come from graded submission rows, which only REPO assignments have.
 */
const findQuizAssignmentIds = async (rows: BellRow[]): Promise<Set<string>> => {
  const assignmentIds = [
    ...new Set(
      rows.flatMap(row => (row.type === 'ASSIGNMENT_DUE_DATE_CHANGED' ? [row.resource_id] : []))
    ),
  ];
  if (assignmentIds.length === 0) return new Set();
  const quizAssignments = await getPrisma().assignment.findMany({
    where: { id: { in: assignmentIds }, type: 'QUIZ' },
    select: { id: true },
  });
  return new Set(quizAssignments.map(assignment => assignment.id));
};

/**
 * The classrooms among these quiz rows where quizzes are not visible
 * (`entitlement.quizzesVisible`). Asked once per distinct classroom, and not
 * at all when there are no quiz rows — the bell loads on every page.
 */
const classroomsHidingQuizzes = async (quizRows: BellRow[]): Promise<Set<string>> => {
  const classroomIds = [
    ...new Set(quizRows.flatMap(row => (row.classroom_id ? [row.classroom_id] : []))),
  ];
  const visible = await Promise.all(classroomIds.map(id => entitlementService.quizzesVisible(id)));
  return new Set(classroomIds.filter((_, i) => !visible[i]));
};

/**
 * The bell's items and unread badge. A notification about a quiz
 * (QUIZ_PUBLISHED, or ASSIGNMENT_DUE_DATE_CHANGED for a quiz assignment) from a
 * classroom where quizzes are not visible is left out of both, so the badge
 * never counts a row the list does not show. The rows stay stored and return
 * if the classroom qualifies again before they expire.
 *
 * The unread count is grouped by type, classroom and resource rather than
 * counted outright, so hidden rows beyond the `limit` window drop out of it
 * without another query. Filtering can leave fewer than `limit` items.
 */
export const getForBell = async (userId: string, limit = 50) => {
  const prisma = getPrisma();
  const [rows, unreadGroups] = await Promise.all([
    prisma.notification.findMany({
      where: { user_id: userId, expires_at: { gt: new Date() } },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        classroom: { select: { id: true, slug: true, name: true } },
      },
    }),
    prisma.notification.groupBy({
      by: ['type', 'classroom_id', 'resource_id'],
      where: { user_id: userId, read_at: null, expires_at: { gt: new Date() } },
      _count: { _all: true },
    }),
  ]);

  const candidates: BellRow[] = [...rows, ...unreadGroups];
  const quizAssignmentIds = await findQuizAssignmentIds(candidates);
  const isAboutQuiz = (row: BellRow) =>
    row.type === 'QUIZ_PUBLISHED' ||
    (row.type === 'ASSIGNMENT_DUE_DATE_CHANGED' && quizAssignmentIds.has(row.resource_id));
  const hidden = await classroomsHidingQuizzes(candidates.filter(isAboutQuiz));
  const shows = (row: BellRow) =>
    !(isAboutQuiz(row) && row.classroom_id !== null && hidden.has(row.classroom_id));

  const items = rows.filter(shows);
  const unreadCount = unreadGroups.reduce(
    (sum, group) => (shows(group) ? sum + group._count._all : sum),
    0
  );
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

export const getStudentsForRepository = async (
  repositoryId: string
): Promise<{ classroomId: string; studentIds: string[] }> => {
  const mod = await getPrisma().repository.findUnique({
    where: { id: repositoryId },
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
