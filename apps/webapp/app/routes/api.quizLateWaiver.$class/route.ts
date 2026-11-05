import { data as errorResponse } from 'react-router';

import { ClassmojiService, QuizLateWaiverError } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { impersonationAuditFields } from '~/routes/admin.$class.ask-moji/impersonation.server';
import type { Route } from './+types/route';

/** The audit `data.tool` of this surface (the MCP's is `submission_late_override`). */
export const QUIZ_LATE_WAIVER_TOOL = 'web:quiz_late_waiver';

/**
 * The quiz's late shield (#813): set or clear staff's late waiver for one
 * student on one QUIZ assignment, the quiz counterpart of the repo shield
 * (`api.gitRepoAssignment.$class?action=updateLateOverride`). Posted as JSON
 * from the quiz results page, the attempt drawer and the student report:
 * `{ assignment_id, student_id, waived }`.
 *
 * Served at /api, not under a role prefix, so the /teacher re-exports of the
 * quiz pages reach it as /admin does, and /assistant reaches it only to be
 * refused here.
 *
 * Gate, as the repo shield's: OWNER or TEACHER, and the classroom mutation
 * rule. The classroom is the one in the URL; the body names only the
 * assignment and the student, and the service resolves both inside that
 * classroom (a QUIZ assignment of it, an accepted STUDENT of it), so another
 * classroom's ids read exactly like unknown ones (404). Where the classroom's
 * quizzes are hidden this answers 404 too.
 *
 * Impersonation: allowed and recorded, as the quiz grade adjustment does
 * (`impersonated_by` on the audit row), and as the repo shield (which records
 * nothing) does not refuse either.
 *
 * Audit: one row per actual change (`changed`), never deduped, since the
 * resource id names the assignment and not the student: two students waived
 * on one quiz within seconds are two rows. The MCP writes the same row shape.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const assignmentId = typeof body?.assignment_id === 'string' ? body.assignment_id : '';
  const studentId = typeof body?.student_id === 'string' ? body.student_id : '';

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'QUIZ_LATE_WAIVER',
    attemptedAction: 'set_quiz_late_waiver',
    metadata: { assignment_id: assignmentId || null, student_id: studentId || null },
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  if (!assignmentId || !studentId || typeof body?.waived !== 'boolean') {
    return errorResponse(
      {
        action: ActionTypes.UPDATE_QUIZ_LATE_WAIVER,
        error: 'An assignment, a student and a waived value are required.',
      },
      { status: 400 }
    );
  }
  const waived = body.waived;

  let result: Awaited<ReturnType<typeof ClassmojiService.quizLateWaiver.setQuizLateWaiver>>;
  try {
    result = await ClassmojiService.quizLateWaiver.setQuizLateWaiver({
      classroomId: classroom.id,
      assignmentId,
      studentId,
      waived,
      actorId: userId,
    });
  } catch (error) {
    if (error instanceof QuizLateWaiverError) {
      const notQuiz = error.code === 'not_quiz';
      return errorResponse(
        {
          action: ActionTypes.UPDATE_QUIZ_LATE_WAIVER,
          error: notQuiz
            ? 'Only a quiz assignment takes a late waiver.'
            : error.code === 'not_student'
              ? 'Student not found for this classroom.'
              : 'Quiz not found for this classroom.',
        },
        { status: notQuiz ? 400 : 404 }
      );
    }
    throw error;
  }

  if (result.changed) {
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'UPDATE',
      resourceType: 'QUIZ_LATE_WAIVER',
      resourceId: assignmentId,
      metadata: {
        tool: QUIZ_LATE_WAIVER_TOOL,
        kind: 'quiz',
        field: 'quiz_late_waiver',
        value: waived,
        assignment_id: assignmentId,
        quiz_id: result.quizId,
        student_id: studentId,
        ...(await impersonationAuditFields(request)),
      },
      dedupe: false,
    });
  }

  return {
    action: ActionTypes.UPDATE_QUIZ_LATE_WAIVER,
    success: waived ? 'Late penalty waived' : 'Late penalty restored',
    waived,
  };
};
