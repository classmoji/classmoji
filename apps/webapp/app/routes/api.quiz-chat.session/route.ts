/**
 * POST /api/quiz-chat/session — a token for one quiz attempt's chat session.
 *
 * Body `{ attemptId }` → `200 { publicAccessToken }`, or a refusal with fixed
 * copy (`{ code?, message }`). The chat transport calls this for both of its
 * callbacks: `startSession` (the first send on an attempt) and `accessToken`
 * (a refresh after a 401). Both mean the same thing here, because starting the
 * session is idempotent on the chat id, which is the attempt id.
 *
 * Gates, in order (the same order as api.quiz, so a denial is audited before
 * any configuration or plan answer):
 *   1. the attempt exists (404)
 *   2. the caller is a member of the attempt's classroom with an allowed role
 *      (assertClassroomAccess, audited), and the classroom's status lets that
 *      role act (assertClassroomMutationAllowed)
 *   3. AI features and Trigger are configured (503)
 *   4. quizzes are visible in the classroom (Pro, not switched off; 403)
 *   5. the caller owns the attempt, strictly. While an admin views as a
 *      student, the session IS that student's, so their own attempts pass and
 *      no one else's do; staff never get a session for someone else's attempt
 *      (they read its saved transcript instead). Audited (403).
 *   6. the attempt runs on the chat runtime, is not complete, and is within
 *      its session deadline (409)
 * Then the grant is written on the attempt, the session is started (or
 * re-joined), and its id is stored.
 *
 * The runtime switch (QUIZ_TRIGGER_RUNTIME) is never read here: the attempt's
 * own stamp decides.
 */
import { assertClassroomAccess } from '~/utils/helpers';
import { assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { isTriggerChatAttempt } from '~/utils/quizRuntime.server';
import {
  isTriggerConfigured,
  recordTriggerSession,
  startQuizChatSession,
  writeChatGrant,
} from './session.server';
import type { Role } from '@prisma/client';
import type { Route } from './+types/route';

const ALLOWED_ROLES: Role[] = ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'];

const SESSION_REFUSALS = {
  missingAttempt: { status: 400, body: { message: 'Missing attempt.' } },
  notFound: { status: 404, body: { message: 'Quiz attempt not found.' } },
  notConfigured: { status: 503, body: { message: 'AI features are not configured.' } },
  quizzesUnavailable: {
    status: 403,
    body: {
      success: false,
      code: 'QUIZZES_UNAVAILABLE',
      message: "Quizzes aren't available in this class.",
    },
  },
  notOwner: { status: 403, body: { message: "This quiz attempt isn't yours." } },
  wrongRuntime: {
    status: 409,
    body: { code: 'QUIZ_RUNTIME_MISMATCH', message: 'Reload the page to continue this quiz.' },
  },
  complete: {
    status: 409,
    body: { code: 'QUIZ_COMPLETE', message: 'This quiz is already complete.' },
  },
  expired: {
    status: 409,
    body: { code: 'QUIZ_ATTEMPT_EXPIRED', message: 'This attempt can no longer be continued.' },
  },
  failed: { status: 500, body: { message: 'Something went wrong. Please try again.' } },
} as const;

type Refusal = (typeof SESSION_REFUSALS)[keyof typeof SESSION_REFUSALS];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const refuse = (refusal: Refusal) => json(refusal.status, refusal.body);

/** Whether the attempt's session deadline has passed. No deadline stamped: open. */
const pastDeadline = (expiresAt: unknown, now: Date) => {
  if (expiresAt === null || expiresAt === undefined) return false;
  const deadline = new Date(expiresAt as string | Date);
  return Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime();
};

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return json(405, { message: 'Method not allowed' });
  }

  const { ClassmojiService } = await import('@classmoji/services');

  try {
    const body = (await request.json().catch(() => null)) as { attemptId?: unknown } | null;
    const attemptId = typeof body?.attemptId === 'string' && body.attemptId ? body.attemptId : null;
    if (!attemptId) return refuse(SESSION_REFUSALS.missingAttempt);

    // 1. The attempt, and through it the classroom every gate below answers for.
    const attempt = await ClassmojiService.quizAttempt.findById(attemptId);
    if (!attempt?.quiz) return refuse(SESSION_REFUSALS.notFound);
    const classroomId = attempt.quiz.classroom_id;

    // 2. Membership, role and classroom status.
    const access = await assertClassroomAccess({
      request,
      classroomId,
      allowedRoles: ALLOWED_ROLES,
      resourceType: 'QUIZ_CHAT_SESSION',
      attemptedAction: 'start_session',
      metadata: { attempt_id: attemptId, quiz_id: attempt.quiz_id },
    });
    assertClassroomMutationAllowed({
      status: access.classroom.status,
      role: access.membership!.role,
    });

    // 3. Configuration, after auth so a denied caller is still audited.
    if (!isAIAgentConfigured() || !isTriggerConfigured()) {
      return refuse(SESSION_REFUSALS.notConfigured);
    }

    // 4. Quizzes visible in this classroom. A failed lookup throws to the 500.
    if (!(await quizzesVisibleOrThrow(classroomId))) {
      return refuse(SESSION_REFUSALS.quizzesUnavailable);
    }

    const { userId } = access;
    const { getAuthSession } = await import('@classmoji/auth/server');
    const authData = await getAuthSession(request);
    const webSession = (
      authData as {
        session?: {
          session?: { id?: unknown; impersonatedBy?: unknown; expiresAt?: unknown };
        };
      } | null
    )?.session?.session;
    const impersonatedBy =
      typeof webSession?.impersonatedBy === 'string' && webSession.impersonatedBy
        ? webSession.impersonatedBy
        : null;
    const webSessionId = typeof webSession?.id === 'string' ? webSession.id : null;

    // 5. Strict ownership.
    if (String(attempt.user_id) !== String(userId)) {
      await ClassmojiService.audit.create({
        classroom_id: classroomId,
        user_id: String(userId),
        role: access.membership!.role,
        resource_id: attemptId,
        resource_type: 'QUIZ_CHAT_SESSION_UNAUTHORIZED',
        action: 'ACCESS_DENIED',
        data: {
          unauthorized_access: true,
          attempted_attempt_id: attemptId,
          owner_user_id: String(attempt.user_id),
          attempted_action: 'start_session',
          caller_role: access.membership!.role,
          ...(impersonatedBy ? { impersonated_by: impersonatedBy } : {}),
        },
      });
      return refuse(SESSION_REFUSALS.notOwner);
    }

    // 6. Attempt state, from its own stamp.
    if (!isTriggerChatAttempt(attempt)) return refuse(SESSION_REFUSALS.wrongRuntime);
    if (attempt.completed_at) return refuse(SESSION_REFUSALS.complete);
    const now = new Date();
    if (pastDeadline((attempt as { session_expires_at?: unknown }).session_expires_at, now)) {
      return refuse(SESSION_REFUSALS.expired);
    }

    // The grant, then the session.
    await writeChatGrant(attemptId, {
      actor_user_id: impersonatedBy ?? String(userId),
      effective_user_id: String(userId),
      classroom_id: String(classroomId),
      role: access.membership!.role,
      web_session_id: webSessionId,
      impersonation: impersonatedBy
        ? {
            by: impersonatedBy,
            session_id: webSessionId,
            expires_at:
              webSession?.expiresAt instanceof Date
                ? webSession.expiresAt.toISOString()
                : typeof webSession?.expiresAt === 'string'
                  ? webSession.expiresAt
                  : null,
          }
        : null,
      issued_at: now.toISOString(),
    });

    const { publicAccessToken, sessionId } = await startQuizChatSession(attemptId, [
      `attempt:${attemptId}`,
      `classroom:${classroomId}`,
    ]);
    if (sessionId) await recordTriggerSession(attemptId, sessionId);

    return json(200, { publicAccessToken });
  } catch (error: unknown) {
    // A gate's refusal (access, classroom status) goes back exactly as thrown.
    if (error instanceof Response) return error;
    // The error itself stays in the server log; the caller gets fixed copy.
    console.error('[api.quiz-chat.session] failed:', error);
    return refuse(SESSION_REFUSALS.failed);
  }
}
