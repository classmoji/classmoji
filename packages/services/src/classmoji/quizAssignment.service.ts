/**
 * A quiz's assignment: the mirror back onto the quiz, and the one publish
 * function every publish path calls.
 *
 * The QUIZ Assignment owns the quiz's module, opens (`release_at`), due date,
 * close date, weight, tokens per hour and publish state. Until every reader
 * has moved to it, the quiz's own `due_date`, `weight` and `status` are
 * written as a mirror in the same transaction as the assignment, so a service
 * still reading them sees the same values (`mirrorQuizFromAssignment`). The
 * status mirror is taken at save time: a close date that passes later is not
 * written back.
 *
 * Kept apart from quiz.service and assignment.service so both can call it
 * without importing each other.
 */
import getPrisma from '@classmoji/database';
import { mirroredQuizStatus, mirroredQuizWeight, openToStudents } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';
import * as entitlementService from './entitlement.service.ts';
import * as notificationService from './notification.service.ts';

type Db = Prisma.TransactionClient;

export type QuizAssignmentErrorCode =
  | 'module_required'
  | 'module_not_found'
  | 'not_found'
  | 'invalid_value'
  | 'quiz_assignment';

/**
 * A quiz assignment write that cannot be made: no module chosen, a module
 * that is not in the quiz's classroom, a value out of range, or an
 * assignment-only path asked to create or delete a quiz's assignment.
 * `message` is shown as is; nothing has been written.
 */
export class QuizAssignmentError extends Error {
  code: QuizAssignmentErrorCode;
  /** HTTP status a web caller should answer with. */
  status: number;

  constructor(code: QuizAssignmentErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'QuizAssignmentError';
    this.code = code;
    this.status = status;
  }
}

export const MODULE_REQUIRED_MESSAGE = 'Choose a module for this quiz';
export const QUIZ_ASSIGNMENT_CREATE_REFUSAL =
  'A quiz is placed in a module from the quiz form (or quiz_create / quiz_update with module_id)';
export const QUIZ_ASSIGNMENT_DELETE_REFUSAL = 'Delete the quiz, or move it to another module';

/** The assignment columns the mirror, the publish rule and notifications read. */
export const QUIZ_ASSIGNMENT_SELECT = {
  id: true,
  type: true,
  quiz_id: true,
  module_id: true,
  title: true,
  student_deadline: true,
  release_at: true,
  closes_at: true,
  weight: true,
  tokens_per_hour: true,
  is_published: true,
  module: { select: { classroom_id: true } },
} satisfies Prisma.AssignmentSelect;

export type QuizAssignmentRow = Prisma.AssignmentGetPayload<{
  select: typeof QUIZ_ASSIGNMENT_SELECT;
}>;

interface MirrorSource {
  quiz_id: string | null;
  title: string;
  student_deadline: Date | null;
  weight: number;
  is_published: boolean;
  closes_at: Date | null;
}

/**
 * Write the quiz's name, due date, weight and status from its assignment,
 * inside the caller's transaction.
 */
export const mirrorQuizFromAssignment = async (
  tx: Db,
  assignment: MirrorSource,
  now: Date = new Date()
) => {
  if (!assignment.quiz_id) return;
  await tx.quiz.update({
    where: { id: assignment.quiz_id },
    data: {
      name: assignment.title,
      due_date: assignment.student_deadline,
      weight: mirroredQuizWeight(assignment.weight),
      status: mirroredQuizStatus(assignment, now),
    },
  });
};

/**
 * Tell the class a quiz was published: QUIZ_PUBLISHED to every student, once,
 * on the assignment's unpublished → published change. Nobody is told where
 * the classroom's quizzes are hidden, or while the quiz is not open yet (a
 * future Opens date): the calendar and Up next carry it from then on.
 * Returns whether the notification went out. Never throws.
 */
export const notifyQuizPublished = async (
  assignment: QuizAssignmentRow,
  now: Date = new Date()
): Promise<boolean> => {
  const sent = await notificationService.runSafely('quiz publish notification', async () => {
    const classroomId = assignment.module.classroom_id;
    if (!(await entitlementService.quizzesVisible(classroomId))) return false;
    if (!openToStudents(assignment, now, { quizzesVisible: true })) return false;
    const studentIds = await notificationService.getStudentsInClassroom(classroomId);
    await notificationService.createNotifications({
      type: 'QUIZ_PUBLISHED',
      classroomId,
      recipientUserIds: studentIds,
      resourceType: 'quiz',
      resourceId: assignment.quiz_id!,
      title: `Quiz published: ${assignment.title}`,
    });
    return true;
  });
  return sent === true;
};

/**
 * Whether a quiz links source material and every linked document is still a
 * draft: students cannot start it until one is published. Callers show a
 * warning beside a publish that succeeded anyway.
 */
export const quizSourceMaterialAllDraft = async (quizId: string): Promise<boolean> => {
  const quiz = await getPrisma().quiz.findUnique({
    where: { id: quizId },
    select: {
      page_links: { select: { page: { select: { is_draft: true } } } },
      slide_links: { select: { slide: { select: { is_draft: true } } } },
    },
  });
  if (!quiz) return false;
  const docs = [
    ...quiz.page_links.map(link => link.page),
    ...quiz.slide_links.map(link => link.slide),
  ].filter((doc): doc is { is_draft: boolean } => doc != null);
  return docs.length > 0 && docs.every(doc => doc.is_draft);
};

export interface QuizPublishResult {
  assignment: QuizAssignmentRow;
  /** Published before this call. */
  wasPublished: boolean;
  /** Whether QUIZ_PUBLISHED went out to the class. */
  notified: boolean;
  /** Every linked source document is a draft (see quizSourceMaterialAllDraft). */
  sourceMaterialAllDraft: boolean;
}

/**
 * Publish or unpublish a quiz's assignment: the ONE function every publish
 * path calls (the quiz form, the quiz list's Publish, a module card's Publish,
 * MCP quiz_publish). The row is locked so two publishes at once notify once.
 * `classroomId` scopes the lookup when the caller holds one.
 */
export const setQuizAssignmentPublished = async (
  assignmentId: string,
  isPublished: boolean,
  { classroomId }: { classroomId?: string } = {}
): Promise<QuizPublishResult> => {
  const now = new Date();
  const { wasPublished, assignment } = await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM assignments WHERE id = ${assignmentId} FOR UPDATE`;
    const previous = await tx.assignment.findFirst({
      where: {
        id: assignmentId,
        type: 'QUIZ',
        ...(classroomId ? { module: { classroom_id: classroomId } } : {}),
      },
      select: { is_published: true },
    });
    if (!previous) throw new QuizAssignmentError('not_found', 'Quiz not found', 404);
    const updated = await tx.assignment.update({
      where: { id: assignmentId },
      data: { is_published: isPublished },
      select: QUIZ_ASSIGNMENT_SELECT,
    });
    await mirrorQuizFromAssignment(tx, updated, now);
    return { wasPublished: previous.is_published, assignment: updated };
  });

  const notified =
    !wasPublished && assignment.is_published
      ? await notifyQuizPublished(assignment, now)
      : false;
  const sourceMaterialAllDraft =
    assignment.is_published && assignment.quiz_id
      ? await quizSourceMaterialAllDraft(assignment.quiz_id)
      : false;
  return { assignment, wasPublished, notified, sourceMaterialAllDraft };
};
