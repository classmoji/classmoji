/**
 * The resolve action for a QUIZ regrade/resubmit request, served on the
 * requests page under /admin, /teacher and /assistant alike. Adjust score
 * (APPROVED, with an emoji on the classroom's scale) or Keep score (DENIED);
 * a reply to the student is required either way (D5: the teaching team,
 * assistants included).
 *
 * The attempt drawer resolves through `resolveQuizRequest` too (E13), after
 * its own gate, with its attempt pinned.
 *
 * Scoping: the request must belong to the classroom the gate resolved from the
 * URL; `regradeRequest.resolveQuiz` then re-checks the actor against the
 * request's own classroom and writes the status, the reply and its own audit
 * rows (`regrade_resolve`, plus `quiz_attempt_adjust` when adjusting).
 */
import { data } from 'react-router';
import { tasks } from '@trigger.dev/sdk';
import {
  ClassmojiService,
  QuizGradeError,
  QUIZ_REGRADE_REPLY_MAX_LENGTH,
} from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { mutationRefusal } from '~/utils/mutationRefusal.server';
import { impersonatedBy } from '~/routes/admin.$class.ask-moji/impersonation.server';

export const RESOLVE_QUIZ_INTENT = 'resolve-quiz';

/** The audit `data.tool` for this surface. */
export const RESOLVE_QUIZ_TOOL = 'web:regrade_requests.resolve_quiz';

export const resolveQuizRegradeAction = async (request: Request, classSlug: string) => {
  const { userId, classroom, membership } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'REGRADE_REQUEST',
    action: 'resolve_regrade_request',
  });
  // Read-only classroom: the refusal comes back as data for the modal.
  const blocked = mutationRefusal(classroom, membership?.role);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.intent !== RESOLVE_QUIZ_INTENT) {
    return data({ error: 'Unknown action' }, { status: 400 });
  }
  return resolveQuizRequest({
    classroomId: classroom.id,
    userId,
    body,
    tool: RESOLVE_QUIZ_TOOL,
    impersonatedBy: await impersonatedBy(request),
  });
};

/**
 * Resolve one quiz request after the caller's own gate (the teaching team of
 * `classroomId`, the classroom writable): validates the body, requires the
 * request to be this classroom's (and, with `attemptId`, that attempt's: the
 * drawer resolves only the attempt it shows), resolves it through
 * `regradeRequest.resolveQuiz` (which re-checks the actor against the
 * request's own classroom and writes the audit rows under `tool`), then
 * queues the student's email. Every refusal is data, for a fetcher.
 */
export const resolveQuizRequest = async ({
  classroomId,
  userId,
  body,
  tool,
  impersonatedBy: viewAs,
  attemptId,
}: {
  classroomId: string;
  userId: string;
  body: Record<string, unknown>;
  tool: string;
  /** The View As admin, when there is one (`impersonatedBy`). */
  impersonatedBy: string | null;
  /** The drawer's attempt: a request on any other attempt is not found. */
  attemptId?: string;
}) => {
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const resolution = body.resolution;
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  const emoji = typeof body.emoji === 'string' ? body.emoji : undefined;

  if (!requestId) return data({ error: 'Regrade request not found' }, { status: 404 });
  if (resolution !== 'APPROVED' && resolution !== 'DENIED') {
    return data({ error: 'Pick Adjust score or Keep score' }, { status: 400 });
  }
  if (!comment) return data({ error: 'A reply to the student is required' }, { status: 400 });
  if (comment.length > QUIZ_REGRADE_REPLY_MAX_LENGTH) {
    return data(
      { error: `The reply is longer than ${QUIZ_REGRADE_REPLY_MAX_LENGTH} characters` },
      { status: 400 }
    );
  }
  if (resolution === 'APPROVED' && !emoji) {
    return data({ error: 'Pick the adjusted grade' }, { status: 400 });
  }

  // The request must be one of THIS classroom's: a staff member of another
  // classroom (or of both) cannot resolve it from here.
  const [owned] = await ClassmojiService.regradeRequest.findMany({
    id: requestId,
    classroom_id: classroomId,
  });
  if (!owned) return data({ error: 'Regrade request not found' }, { status: 404 });
  if (attemptId !== undefined && owned.quiz_attempt_id !== attemptId) {
    return data({ error: 'Regrade request not found' }, { status: 404 });
  }
  if (!owned.quiz_attempt_id) {
    return data({ error: 'This is not a quiz regrade request' }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof ClassmojiService.regradeRequest.resolveQuiz>>;
  try {
    result = await ClassmojiService.regradeRequest.resolveQuiz({
      requestId,
      resolution,
      emoji: resolution === 'APPROVED' ? emoji : undefined,
      comment,
      actorUserId: userId,
      tool,
      impersonatedBy: viewAs,
    });
  } catch (error) {
    if (error instanceof QuizGradeError) {
      return data({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }

  if (result.alreadyResolved) {
    return {
      action: 'RESOLVE_QUIZ_REGRADE',
      alreadyResolved: true,
      info: 'This request was already resolved',
    };
  }

  // The student's resolution email: `quiz_regrade_resolved` re-reads the
  // resolved request and says "Score adjusted X → Y" / "Score kept X" with
  // the reply. Never `update_regrade_request`, whose run writes the status
  // (resolveQuiz already did) and refuses quiz requests. Best effort: the
  // resolution stands whether or not the email is queued.
  try {
    await tasks.trigger('quiz_regrade_resolved', { request_id: requestId });
  } catch (error) {
    console.error('[regrade-requests] quiz_regrade_resolved enqueue failed', { requestId, error });
  }

  // The stored status: Adjust with the grade the attempt already shows is a Keep.
  return {
    action: 'RESOLVE_QUIZ_REGRADE',
    success: result.request.status === 'APPROVED' ? 'Score adjusted' : 'Score kept',
  };
};
