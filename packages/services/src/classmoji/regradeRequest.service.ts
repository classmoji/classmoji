/**
 * Regrade/resubmit requests: on a repo submission (`git_repo_assignment_id`,
 * `create` + the `request_regrade` / `update_regrade_request` tasks) or on a
 * quiz attempt (`quiz_attempt_id`, `createForQuizAttempt` / `resolveQuiz`).
 * Exactly one target per row (CHECK `regrade_requests_one_target`), so every
 * reader treats both relations as optional.
 *
 * Quiz requests (D4, D7): a student asks on their own completed attempt; one
 * open (IN_REVIEW) request per attempt, a second ask returns the open one
 * (partial unique index `regrade_requests_open_quiz_attempt`); no other
 * limit, so they may ask again after a resolution. Staff resolve with Adjust
 * (APPROVED: writes the attempt's adjustment with the chosen emoji) or Keep
 * (DENIED); the reply is required and stored in `grader_comment`, and the
 * grade the resolution left is snapshotted in `resolved_emoji`. Staff never
 * resolve a request on their own attempt. In a classroom that does not show
 * quizzes, quiz requests are refused and left out of every list
 * (`findManyForDisplay`). A quiz
 * request never enters the repo grade-clearing path
 * (`clearStaleGradesInScope` / `clearGradesForOpenRegradeRequest` in
 * helper/index.ts), which reads repo submissions only. Audited here:
 * `regrade_create` and `regrade_resolve` (resource REGRADE_REQUEST, with the
 * caller's `data.tool`), for repo resolutions too (`resolveRepo`); emails
 * stay with the caller (the tasks).
 *
 * LOCK ORDER: the attempt row before the request row, as deleting an attempt
 * (which cascades to its requests) takes them.
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import {
  lateHours as lateHoursOf,
  quizAttemptGrade,
  quizPercentageEmoji,
  withLogins,
  type QuizAttemptGrade,
  type QuizEmojiScale,
} from '@classmoji/utils';
import { Prisma, type RegradeRequest, type Role } from '@prisma/client';
import * as audit from './audit.service.ts';
import { quizScaleForClassroom } from './emojiMapping.service.ts';
import { quizzesVisibleOrThrow } from './entitlement.service.ts';
import * as notificationService from './notification.service.ts';
import { netQuizExtensionHours } from './quizGradeItems.service.ts';
import {
  QuizGradeError,
  acceptedRoleIn,
  applyAdjustmentInTx,
  auditAdjustment,
  loadAttemptForUpdate,
  normalizeComment,
  projectAttempt,
  refuseOwnAttempt,
  requireGradableAttempt,
  requireQuizzesVisible,
  requireScaleEmoji,
  requireTeachingTeam,
  type QuizAttemptAdjustment,
  type QuizGradeActor,
} from './quizGradeAdjust.service.ts';

export const create = async ({
  classroom_id,
  git_repo_assignment_id,
  student_id,
  student_comment,
  previous_grade,
}: {
  classroom_id: string;
  git_repo_assignment_id: string;
  student_id: string;
  student_comment?: string | null;
  previous_grade?: string[];
}): Promise<RegradeRequest> => {
  const request = await getPrisma().regradeRequest.create({
    data: {
      classroom_id,
      git_repo_assignment_id,
      student_id,
      student_comment,
      previous_grade,
    },
  });

  await notificationService.runSafely('regrade request notification', async () => {
    const graders = await getPrisma().gitRepoAssignmentGrader.findMany({
      where: { git_repo_assignment_id },
      select: { grader_id: true },
    });
    const graderIds = graders.map(g => g.grader_id);
    if (graderIds.length > 0) {
      const repoAssignment = await getPrisma().gitRepoAssignment.findUnique({
        where: { id: git_repo_assignment_id },
        select: {
          assignment: { select: { title: true } },
          git_repo: { select: { name: true } },
        },
      });
      await notificationService.createNotifications({
        type: 'TA_REGRADE_ASSIGNED',
        classroomId: classroom_id,
        recipientUserIds: graderIds,
        resourceType: 'regrade_request',
        resourceId: request.id,
        title: `Regrade request: ${repoAssignment?.assignment.title ?? 'Assignment'} - ${repoAssignment?.git_repo.name ?? ''}`,
      });
    }
  });

  return request;
};

export const findMany = async (query: Prisma.RegradeRequestWhereInput) => {
  const requests = await getPrisma().regradeRequest.findMany({
    where: query,
    include: {
      git_repo_assignment: {
        include: {
          assignment: true,
          git_repo: true,
          graders: {
            include: {
              grader: { include: GIT_IDENTITY },
            },
          },
          grades: {
            include: {
              token_transaction: true,
              grader: { include: GIT_IDENTITY },
            },
          },
        },
      },
      // A quiz request's attempt: the AI score, the adjustment and the
      // comment, with the quiz and its assignment. Null on a repo request.
      quiz_attempt: {
        select: {
          id: true,
          user_id: true,
          attempt_number: true,
          started_at: true,
          completed_at: true,
          partial_credit_percentage: true,
          adjusted_emoji: true,
          instructor_comment: true,
          adjusted_at: true,
          adjusted_by: { select: { id: true, name: true } },
          comment_at: true,
          comment_by: { select: { id: true, name: true } },
          quiz: {
            select: {
              id: true,
              name: true,
              classroom_id: true,
              grading_strategy: true,
              assignment: { select: { id: true, title: true } },
            },
          },
        },
      },
      // Who resolved it (name only): the author of the staff reply. Null
      // while open, and on rows resolved before it was recorded.
      resolved_by: { select: { id: true, name: true } },
      student: {
        select: {
          name: true,
          id: true,
          email: true,
          image: true,
          ...GIT_IDENTITY,
          _count: {
            select: {
              regrade_requests: true,
            },
          },
        },
      },
    },
    orderBy: {
      created_at: 'desc',
    },
  });
  return withLogins(requests);
};

/**
 * `findMany` for a page or tool that SHOWS requests in one classroom: quiz
 * requests are left out where the classroom does not show quizzes
 * (`entitlement.quizzesVisibleOrThrow`, the predicate the gradebook and the
 * MCP use), so a classroom without them shows no trace of quiz requests.
 * `classroomId` is the one the caller's gate resolved; the query must be
 * scoped to it.
 */
export const findManyForDisplay = async (
  classroomId: string,
  query: Prisma.RegradeRequestWhereInput
) => {
  const rows = await findMany({ ...query, classroom_id: classroomId });
  if (!rows.some(row => row.quiz_attempt_id)) return rows;
  if (await quizzesVisibleOrThrow(classroomId)) return rows;
  return rows.filter(row => !row.quiz_attempt_id);
};

/** An open quiz request's lateness, as the resolve modal and the MCP queue show it. */
export interface QuizRequestLateness {
  /** The attempt's whole hours past its due date plus the hours the student bought. */
  lateHours: number;
  /** The attempt's grade now after the late penalty, as the classroom's emoji. */
  countedEmoji: string | null;
}

/**
 * request id → lateness, for the OPEN quiz requests among `rows` (what the
 * staff resolve modal's "Counted" line and the MCP queue show). Lateness is
 * measured against the quiz's own assignment in `classroomId`, pushed out by
 * the hours the student bought on it; the penalty is the classroom's.
 */
/** The request fields `openQuizRequestLateness` reads (a `findMany` row fits). */
export interface LatenessRequestRow {
  id: string;
  status: string;
  student_id: string;
  quiz_attempt: {
    completed_at: Date | string | null;
    partial_credit_percentage: number | null;
    adjusted_emoji: string | null;
    quiz: { assignment: { id: string } | null };
  } | null;
}

export const openQuizRequestLateness = async (
  classroomId: string,
  rows: ReadonlyArray<LatenessRequestRow>,
  scale: QuizEmojiScale
): Promise<Map<string, QuizRequestLateness>> => {
  const open = rows.filter(r => r.status === 'IN_REVIEW' && r.quiz_attempt);
  const result = new Map<string, QuizRequestLateness>();
  if (open.length === 0) return result;
  const settings = await getPrisma().classroomSettings.findUnique({
    where: { classroom_id: classroomId },
    select: { late_penalty_points_per_hour: true },
  });
  const penalty = Number(settings?.late_penalty_points_per_hour ?? 0) || 0;
  await Promise.all(
    open.map(async row => {
      const attempt = row.quiz_attempt!;
      const assignmentId = attempt.quiz.assignment?.id ?? null;
      const [assignment, hours] = assignmentId
        ? await Promise.all([
            getPrisma().assignment.findFirst({
              where: { id: assignmentId, module: { classroom_id: classroomId } },
              select: { student_deadline: true },
            }),
            netQuizExtensionHours({
              classroomId,
              studentId: row.student_id,
              assignmentIds: [assignmentId],
            }),
          ])
        : [null, new Map<string, number>()];
      const late = assignment
        ? lateHoursOf(
            attempt.completed_at,
            assignment.student_deadline,
            assignmentId ? Math.max(0, hours.get(assignmentId) ?? 0) : 0
          )
        : 0;
      // The penalty comes off the effective score itself (D2), not off its emoji.
      const { effective } = quizAttemptGrade(attempt, scale);
      result.set(row.id, {
        lateHours: late,
        countedEmoji:
          late > 0 && effective.percentage !== null
            ? quizPercentageEmoji(Math.max(0, effective.percentage - late * penalty), scale)
            : effective.emoji,
      });
    })
  );
  return result;
};

/**
 * Find the open (IN_REVIEW) regrade request for a GitRepoAssignment, if any.
 * Returns the most recent one when multiple exist.
 */
export const findOpenByAssignmentId = async (
  gitRepoAssignmentId: string,
  tx?: Prisma.TransactionClient
) => {
  return (tx ?? getPrisma()).regradeRequest.findFirst({
    where: {
      git_repo_assignment_id: gitRepoAssignmentId,
      status: 'IN_REVIEW',
    },
    orderBy: {
      created_at: 'desc',
    },
  });
};

/**
 * Find the open (IN_REVIEW) regrade request on a quiz attempt, if any (the
 * partial unique index allows at most one).
 */
export const findOpenByQuizAttemptId = async (
  quizAttemptId: string,
  tx?: Prisma.TransactionClient
) => {
  return (tx ?? getPrisma()).regradeRequest.findFirst({
    where: {
      quiz_attempt_id: quizAttemptId,
      status: 'IN_REVIEW',
    },
    orderBy: {
      created_at: 'desc',
    },
  });
};

const auditRegrade = async (
  actor: QuizGradeActor,
  row: {
    classroomId: string;
    role: Role;
    requestId: string;
    action: 'CREATE' | 'UPDATE';
    data: Record<string, unknown>;
  }
) => {
  try {
    await audit.create(
      {
        user_id: actor.actorUserId,
        classroom_id: row.classroomId,
        role: row.role,
        resource_type: 'REGRADE_REQUEST',
        resource_id: row.requestId,
        action: row.action,
        data: {
          tool: actor.tool,
          ...row.data,
          ...(actor.impersonatedBy ? { impersonated_by: actor.impersonatedBy } : {}),
        } as Prisma.InputJsonValue,
      },
      { dedupe: false }
    );
  } catch (error) {
    console.error('[regradeRequest] audit write failed', { requestId: row.requestId, error });
  }
};

/** Longest student comment on a quiz regrade request. */
export const QUIZ_REGRADE_COMMENT_MAX_LENGTH = 2000;

export interface CreateQuizRegradeInput extends QuizGradeActor {
  /** The attempt to regrade. Its quiz decides the classroom. */
  attemptId: string;
  /** Why the attempt should be regraded. Required. */
  comment: string;
}

export interface CreateQuizRegradeResult {
  request: RegradeRequest;
  /** False when the attempt already had an open request, which is returned instead. */
  created: boolean;
  classroomId: string;
  quiz: { id: string; name: string; assignmentTitle: string | null };
  /** The attempt's number within the quiz (1-based). */
  attemptNumber: number;
}

/**
 * A student's regrade/resubmit request on their OWN completed quiz attempt.
 * `actorUserId` is the student (the session user): it must own the attempt
 * and be an accepted STUDENT member of the attempt's classroom; anyone else
 * gets `not_found`. When the attempt already has an open (IN_REVIEW) request,
 * that request is returned (`created: false`) and nothing is written or
 * audited. `previous_grade` snapshots the attempt's effective emoji.
 * Teaching staff who own grading (accepted OWNER and TEACHER members; a quiz
 * has no assigned graders) get the in-app regrade notification.
 */
export const createForQuizAttempt = async (
  input: CreateQuizRegradeInput
): Promise<CreateQuizRegradeResult> => {
  const { attemptId, actorUserId } = input;
  const comment = normalizeComment(input.comment);
  if (comment === null) {
    throw new QuizGradeError('invalid_input', 'Say why the attempt should be regraded');
  }
  if (comment.length > QUIZ_REGRADE_COMMENT_MAX_LENGTH) {
    throw new QuizGradeError(
      'invalid_input',
      `Comment is longer than ${QUIZ_REGRADE_COMMENT_MAX_LENGTH} characters`
    );
  }

  // Before the transaction: the attempt's classroom (a quiz never changes
  // classroom), the quiz visibility gate and the scale.
  const located =
    typeof attemptId === 'string' && attemptId.length > 0 && attemptId.length <= 255
      ? await getPrisma().quizAttempt.findUnique({
          where: { id: attemptId },
          select: { quiz: { select: { classroom_id: true } } },
        })
      : null;
  if (!located) throw new QuizGradeError('not_found', 'Quiz attempt not found');
  await requireQuizzesVisible(located.quiz.classroom_id, actorUserId);
  // The classroom's own scale, re-seeded first if every row was deleted (E10).
  const scale = await quizScaleForClassroom(located.quiz.classroom_id);

  const run = () =>
    getPrisma().$transaction(async tx => {
      const attempt = await loadAttemptForUpdate(tx, attemptId);
      const classroomId = attempt.quiz.classroom_id;
      if (classroomId !== located.quiz.classroom_id) {
        throw new QuizGradeError('not_found', 'Quiz attempt not found');
      }
      const quiz = {
        id: attempt.quiz.id,
        name: attempt.quiz.name,
        assignmentTitle: attempt.quiz.assignment?.title ?? null,
      };
      const attemptNumber = attempt.attempt_number;
      // Own attempt only, as a current student of its classroom. Same answer
      // for "not yours" and "no such attempt".
      const role = await acceptedRoleIn(tx, classroomId, actorUserId);
      const isStudent =
        (await tx.classroomMembership.count({
          where: {
            classroom_id: classroomId,
            user_id: actorUserId,
            role: 'STUDENT',
            has_accepted_invite: true,
          },
        })) > 0;
      if (attempt.user_id !== actorUserId || !isStudent || role === null) {
        throw new QuizGradeError('not_found', 'Quiz attempt not found');
      }
      await requireGradableAttempt(tx, attempt, 'regraded');

      const open = await findOpenByQuizAttemptId(attempt.id, tx);
      if (open) return { request: open, created: false, classroomId, quiz, attemptNumber, role };

      const emoji = quizAttemptGrade(attempt, scale).effective.emoji;
      const request = await tx.regradeRequest.create({
        data: {
          classroom_id: classroomId,
          quiz_attempt_id: attempt.id,
          student_id: actorUserId,
          student_comment: comment,
          previous_grade: emoji ? [emoji] : [],
        },
      });
      return { request, created: true, classroomId, quiz, attemptNumber, role };
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    // A concurrent ask won the partial unique index: return its request.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      result = await run();
    } else {
      throw error;
    }
  }

  const { request, created, classroomId, quiz, attemptNumber, role } = result;
  if (created) {
    await auditRegrade(input, {
      classroomId,
      role: 'STUDENT',
      requestId: request.id,
      action: 'CREATE',
      data: {
        event: 'regrade_create',
        target: 'quiz',
        quiz_attempt_id: attemptId,
        quiz_id: quiz.id,
        previous_grade: request.previous_grade,
        ...(role !== 'STUDENT' ? { highest_role: role } : {}),
      },
    });

    await notificationService.runSafely('quiz regrade request notification', async () => {
      const staff = await getPrisma().classroomMembership.findMany({
        where: {
          classroom_id: classroomId,
          role: { in: ['OWNER', 'TEACHER'] },
          has_accepted_invite: true,
        },
        select: { user_id: true },
      });
      await notificationService.createNotifications({
        type: 'TA_REGRADE_ASSIGNED',
        classroomId,
        recipientUserIds: staff.map(m => m.user_id).filter(id => id !== actorUserId),
        resourceType: 'regrade_request',
        resourceId: request.id,
        title: `Regrade request: ${quiz.assignmentTitle ?? quiz.name}`,
        // The email names the quiz and the attempt: "A student asked for a
        // regrade of <quiz> (attempt N)" (notificationEmails.regradeSubject).
        metadata: {
          target: 'quiz',
          quiz_name: quiz.assignmentTitle ?? quiz.name,
          attempt_number: attemptNumber,
        },
      });
    });
  }

  return { request, created, classroomId, quiz, attemptNumber };
};

export interface ResolveQuizRegradeInput extends QuizGradeActor {
  requestId: string;
  /** APPROVED = adjust the attempt to `emoji`; DENIED = keep its score. */
  resolution: 'APPROVED' | 'DENIED';
  /** Required for APPROVED: an emoji on the classroom's scale. Ignored for DENIED. */
  emoji?: string;
  /** The reply to the student (required), stored in `grader_comment`. */
  comment: string;
}

export interface ResolveQuizRegradeResult {
  request: RegradeRequest;
  /** True when the request was no longer IN_REVIEW: nothing was written or audited. */
  alreadyResolved: boolean;
  attempt: QuizAttemptAdjustment;
  grade: QuizAttemptGrade;
  classroomId: string;
  quiz: { id: string; name: string; assignmentTitle: string | null };
  /** The requesting student, for the resolution email. */
  student: { id: string; email: string | null; name: string | null };
}

const requireRequestId = (requestId: unknown): string => {
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 255) {
    throw new QuizGradeError('not_found', 'Regrade request not found');
  }
  return requestId;
};

/**
 * Resolve a quiz regrade request (teaching team of the request's classroom,
 * which must be the attempt's own; never the attempt's owner). APPROVED
 * writes the attempt's adjustment with `emoji` (audited `quiz_attempt_adjust`,
 * `via_regrade_request_id`) and marks the request APPROVED; DENIED leaves the
 * attempt as it is. Both store the reply in `grader_comment`, snapshot the
 * resulting emoji in `resolved_emoji` (the one set, or the effective one
 * kept) and audit `regrade_resolve` (`resolution`: adjust | keep). A request
 * already resolved is returned as is (`alreadyResolved`), before the emoji and
 * the reply are validated, so a retry reads as already resolved. A repo
 * request is refused (`not_quiz_request`): this path never touches repo
 * grades. The resolution email is the caller's.
 *
 * Locks the attempt, then the request (the order attempt deletion takes).
 */
export const resolveQuiz = async (
  input: ResolveQuizRegradeInput
): Promise<ResolveQuizRegradeResult> => {
  const { resolution, actorUserId } = input;
  if (resolution !== 'APPROVED' && resolution !== 'DENIED') {
    throw new QuizGradeError('invalid_input', 'Resolution must be APPROVED or DENIED');
  }
  const requestId = requireRequestId(input.requestId);

  // Before the transaction (unlocked): the request's classroom and attempt,
  // neither of which changes once written; the quiz visibility gate; the scale.
  const located = await getPrisma().regradeRequest.findUnique({
    where: { id: requestId },
    select: { classroom_id: true, quiz_attempt_id: true },
  });
  if (!located) throw new QuizGradeError('not_found', 'Regrade request not found');
  if (located.quiz_attempt_id) await requireQuizzesVisible(located.classroom_id, actorUserId);
  // The classroom's own scale, re-seeded first if every row was deleted (E10).
  const scale = await quizScaleForClassroom(located.classroom_id);

  const outcome = await getPrisma().$transaction(
    async tx => {
      // Authorize on the request's own classroom before saying anything else.
      const actorRole = await requireTeachingTeam(tx, located.classroom_id, actorUserId);
      if (!located.quiz_attempt_id) {
        throw new QuizGradeError('not_quiz_request', 'This is not a quiz regrade request');
      }

      const attempt = await loadAttemptForUpdate(tx, located.quiz_attempt_id);
      await tx.$queryRaw`SELECT id FROM regrade_requests WHERE id = ${requestId} FOR UPDATE`;
      const request = await tx.regradeRequest.findUnique({
        where: { id: requestId },
        include: { student: { select: { id: true, email: true, name: true } } },
      });
      if (
        !request ||
        request.quiz_attempt_id !== attempt.id ||
        request.classroom_id !== located.classroom_id ||
        attempt.quiz.classroom_id !== request.classroom_id
      ) {
        throw new QuizGradeError('not_found', 'Regrade request not found');
      }
      refuseOwnAttempt(attempt, actorUserId);

      const base = {
        classroomId: request.classroom_id,
        quiz: {
          id: attempt.quiz.id,
          name: attempt.quiz.name,
          assignmentTitle: attempt.quiz.assignment?.title ?? null,
        },
        student: request.student,
        actorRole,
      };

      if (request.status !== 'IN_REVIEW') {
        const { student: _student, ...row } = request;
        return { ...base, request: row, alreadyResolved: true, attempt, change: null };
      }

      const reply = normalizeComment(input.comment);
      if (reply === null) {
        throw new QuizGradeError('invalid_input', 'A reply to the student is required');
      }

      let current = attempt;
      let change = null;
      if (resolution === 'APPROVED') {
        const emoji = requireScaleEmoji(input.emoji, scale);
        await requireGradableAttempt(tx, attempt);
        const applied = await applyAdjustmentInTx(tx, attempt, {
          emoji,
          comment: undefined,
          actorUserId,
          actorRole,
          scale,
          event: 'quiz_attempt_adjust',
        });
        current = applied.attempt;
        change = applied.change;
      }

      const updated = await tx.regradeRequest.update({
        where: { id: request.id },
        data: {
          status: resolution,
          grader_comment: reply,
          resolved_by_id: actorUserId,
          resolved_at: new Date(),
          resolved_emoji: quizAttemptGrade(current, scale).effective.emoji,
        },
      });
      return { ...base, request: updated, alreadyResolved: false, attempt: current, change };
    },
    { timeout: 15_000 }
  );

  if (!outcome.alreadyResolved) {
    if (outcome.change) {
      await auditAdjustment(outcome.change, input, { via_regrade_request_id: requestId });
    }
    await auditRegrade(input, {
      classroomId: outcome.classroomId,
      role: outcome.actorRole,
      requestId,
      action: 'UPDATE',
      data: {
        event: 'regrade_resolve',
        target: 'quiz',
        quiz_attempt_id: outcome.attempt.id,
        status: resolution,
        resolution: resolution === 'APPROVED' ? 'adjust' : 'keep',
        resolved_emoji: outcome.request.resolved_emoji,
        ...(outcome.change
          ? { old_emoji: outcome.change.oldEmoji, new_emoji: outcome.change.newEmoji }
          : {}),
      },
    });
  }

  return {
    request: outcome.request,
    alreadyResolved: outcome.alreadyResolved,
    attempt: projectAttempt(outcome.attempt),
    grade: quizAttemptGrade(outcome.attempt, scale),
    classroomId: outcome.classroomId,
    quiz: outcome.quiz,
    student: outcome.student,
  };
};

/**
 * Resolve a repo (submission) regrade request: the status, the reply when
 * there is one, and who resolved it and when. Called by the
 * `update_regrade_request` task, which the web queue and the MCP trigger
 * after their own teaching-team gate. Refuses a quiz request: those resolve
 * through `resolveQuiz`, which writes the adjustment with the status.
 * Audited `regrade_resolve` (`target: 'repo'`) with the caller's `tool`, as
 * the resolver's highest accepted role in the request's classroom; a payload
 * queued without a resolver writes no audit row (no actor to name).
 */
export const resolveRepo = async ({
  id,
  status,
  graderComment,
  resolvedById,
  tool,
  impersonatedBy,
}: {
  id: string;
  status: 'APPROVED' | 'DENIED';
  graderComment?: string | null;
  resolvedById?: string | null;
  /** The resolving surface (`data.tool` on the audit row). */
  tool?: string | null;
  /** The admin user id behind an impersonated session, when there is one. */
  impersonatedBy?: string | null;
}): Promise<RegradeRequest> => {
  if (status !== 'APPROVED' && status !== 'DENIED') {
    throw new Error('Resolution must be APPROVED or DENIED');
  }
  const stored = await getPrisma().regradeRequest.findUnique({
    where: { id },
    select: { quiz_attempt_id: true, classroom_id: true, git_repo_assignment_id: true },
  });
  if (!stored) throw new Error('Regrade request not found');
  if (stored.quiz_attempt_id) {
    throw new Error('A quiz regrade request is resolved with resolveQuiz');
  }
  const reply = typeof graderComment === 'string' ? graderComment.trim() : '';
  const updated = await getPrisma().regradeRequest.update({
    where: { id },
    data: {
      status,
      ...(reply ? { grader_comment: reply } : {}),
      resolved_by_id: resolvedById ?? null,
      resolved_at: new Date(),
    },
  });

  if (resolvedById) {
    const role = await acceptedRoleIn(getPrisma(), stored.classroom_id, resolvedById);
    if (role) {
      await auditRegrade(
        {
          actorUserId: resolvedById,
          tool: tool || 'update_regrade_request',
          impersonatedBy: impersonatedBy ?? null,
        },
        {
          classroomId: stored.classroom_id,
          role,
          requestId: id,
          action: 'UPDATE',
          data: {
            event: 'regrade_resolve',
            target: 'repo',
            git_repo_assignment_id: stored.git_repo_assignment_id,
            status,
            reply_set: reply.length > 0,
          },
        }
      );
    }
  }

  return updated;
};
