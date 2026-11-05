/**
 * Quiz API endpoint: starting quiz attempts and recording their time.
 *
 * Every attempt runs on the Trigger.dev chat runtime (`agent_runtime:
 * 'trigger_chat'`): its messages, its completion and its grading go through
 * api.quiz-chat.session and the `quiz-attempt` task, never through here.
 * Attempts from the retired ai-agent runtime (`ai_agent`) are read-only: none
 * of these actions starts or continues one.
 *
 * SECURITY MEASURES:
 * 1. Authentication: All requests require valid userId from cookie
 * 2. Authorization: Users can only act on their own quiz attempts
 *    - While viewing as another user, "the user" is that user: only their own
 *      attempts are reachable
 *    - restartQuiz stores a staff preview's repository only when the caller's
 *      own GitHub account can open it
 * 3. Audit Logging: All unauthorized access attempts are logged
 * 4. Admin Access: Admins preview quizzes as themselves, creating their own attempts
 *    - This ensures data isolation between admin previews and student attempts
 *
 * ACTIONS:
 * - startQuiz: Creates (or, given an attemptId, names) the caller's attempt;
 *   the attempt's chat starts when its drawer opens. An `ai_agent` attempt
 *   answers 409.
 * - restartQuiz: Creates a new attempt, respecting max_attempts
 * - updateMetrics: Updates duration metrics for a quiz attempt; also takes the
 *   final time of an attempt completed within the last ten minutes
 * - recordModalClose: Records when the quiz modal is closed
 * - recordModalOpen: Calculates gap time and adds to unfocused duration when modal reopens
 */
import { assertClassroomAccess } from '~/utils/helpers';
import { assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { isTriggerChatAttempt } from '@classmoji/utils';
import type { Role } from '@prisma/client';
import type { Route } from './+types/route';

const extractDurationMetrics = (payload: Record<string, unknown> | null) => {
  if (!payload) return {};

  const sanitize = (value: unknown) => {
    if (value === undefined || value === null) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const rounded = Math.round(numeric);
    return rounded < 0 ? 0 : rounded;
  };

  const metrics: { totalDurationMs?: number; unfocusedDurationMs?: number } = {};
  const total = sanitize(payload.totalDurationMs ?? payload.total_duration_ms);
  const unfocused = sanitize(payload.unfocusedDurationMs ?? payload.unfocused_duration_ms);

  if (total !== undefined) metrics.totalDurationMs = total;
  if (unfocused !== undefined) metrics.unfocusedDurationMs = unfocused;

  return metrics;
};

/**
 * The refusal for a classroom whose quizzes are not visible (not on Pro, or
 * quizzes switched off). `code` is what the quiz UI branches on; `message` is
 * shown as-is (a page left open across a plan lapse lands here).
 */
const QUIZZES_UNAVAILABLE_BODY = {
  success: false,
  code: 'QUIZZES_UNAVAILABLE',
  message: "Quizzes aren't available in this class.",
};

/**
 * The refusal for starting an attempt from the retired ai-agent runtime: it is
 * read-only now and takes no turns. Fixed copy.
 */
const QUIZ_RUNTIME_MISMATCH_BODY = {
  success: false,
  code: 'QUIZ_RUNTIME_MISMATCH',
  message: 'This attempt can no longer be continued.',
};

const runtimeMismatchResponse = () =>
  new Response(JSON.stringify(QUIZ_RUNTIME_MISMATCH_BODY), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });

/** Fixed copy for failures. Whatever went wrong is logged here and never sent to the browser. */
const GENERIC_FAILURE_MESSAGE = 'Something went wrong. Please try again.';
const RESTART_FAILED_MESSAGE = "Couldn't start a new attempt. Please try again.";

/**
 * A staff preview's repository refused (see previewRepoAccess.server): fixed
 * copy by outcome, shown as-is by the preview page (it reads `message`). No
 * usable GitHub token splits in two: an account with no GitHub linked (signed
 * up with email and password) connects one; a linked account whose token
 * GitHub no longer takes signs in with GitHub again.
 */
const PREVIEW_REPO_REFUSALS = {
  unreadable: {
    status: 403,
    message: "Your GitHub account can't open that repository. Pick one you have access to.",
  },
  connect: {
    status: 403,
    message: 'Connect your GitHub account to preview this quiz with a repository.',
  },
  sign_in: {
    status: 403,
    message: 'Sign in with GitHub again to preview this quiz with a repository.',
  },
  unavailable: {
    status: 503,
    message: "Couldn't check that repository on GitHub. Please try again.",
  },
} as const;

const previewRepoRefusal = (outcome: keyof typeof PREVIEW_REPO_REFUSALS) => {
  const { status, message } = PREVIEW_REPO_REFUSALS[outcome];
  return new Response(JSON.stringify({ success: false, code: 'PREVIEW_REPO_REFUSED', message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

/**
 * A quiz that links source material (pages and decks) is built from it, so a
 * student who can see none of it has nothing to be quizzed on: every linked
 * document is still a draft, or none has been indexed yet. Fixed copy, shown
 * as-is by the quiz list and the attempt modal (they read `message`).
 */
const SOURCE_MATERIAL_UNAVAILABLE_MESSAGE =
  "This quiz's source material isn't available yet. Ask your instructor.";

/** The 409 a start or restart answers when nothing linked is available. */
const sourceMaterialUnavailableResponse = () =>
  new Response(
    JSON.stringify({
      success: false,
      code: 'SOURCE_MATERIAL_UNAVAILABLE',
      message: SOURCE_MATERIAL_UNAVAILABLE_MESSAGE,
      error: SOURCE_MATERIAL_UNAVAILABLE_MESSAGE,
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } }
  );

export async function action({ request }: Route.ActionArgs) {
  // Only handle POST requests
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Import server-only repositories
  const { ClassmojiService, QuizAttemptNotFoundError } = await import('@classmoji/services');
  try {
    const data = await request.json();

    const jsonResponse = (status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (!data?._action) {
      return jsonResponse(400, 'Invalid action');
    }

    // The single gate for start/restart/metrics. TEACHER belongs here for the
    // same reason OWNER and ASSISTANT do: staff take quizzes to preview them,
    // and restartQuiz takes a preview repository from any of them (see its
    // `isInstructor` check).
    const allowedRoles: Role[] = ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'];

    const resolveOrgContext = async () => {
      switch (data._action) {
        case 'startQuiz': {
          if (!data.quizId) {
            return { response: jsonResponse(400, 'Missing quizId') };
          }

          const quiz = await ClassmojiService.quiz.findById(data.quizId);
          if (!quiz) {
            return { response: jsonResponse(404, 'Quiz not found') };
          }

          return {
            context: {
              classroomId: quiz.classroom_id,
              quiz,
              metadata: { quiz_id: data.quizId },
            },
          };
        }

        case 'restartQuiz': {
          if (!data.quizId) {
            return { response: jsonResponse(400, 'Missing quizId') };
          }

          const quiz = await ClassmojiService.quiz.findById(data.quizId);
          if (!quiz) {
            return { response: jsonResponse(404, 'Quiz not found') };
          }

          return {
            context: {
              classroomId: quiz.classroom_id,
              quiz,
              metadata: { quiz_id: data.quizId },
            },
          };
        }

        case 'updateMetrics': {
          if (!data.attemptId) {
            return { response: jsonResponse(400, 'Missing attemptId') };
          }

          const attempt = await ClassmojiService.quizAttempt.findById(data.attemptId);

          // Gracefully handle missing attempts (e.g., after restart/deletion)
          if (!attempt) {
            return {
              response: new Response(JSON.stringify({ success: true, skipped: true }), {
                headers: { 'Content-Type': 'application/json' },
              }),
            };
          }

          return {
            context: {
              classroomId: attempt.quiz.classroom_id,
              attempt,
              metadata: {
                attempt_id: data.attemptId,
                quiz_id: attempt.quiz_id,
              },
            },
          };
        }

        case 'recordModalClose': {
          if (!data.attemptId) {
            return { response: jsonResponse(400, 'Missing attemptId') };
          }

          const attempt = await ClassmojiService.quizAttempt.findById(data.attemptId);

          if (!attempt) {
            return {
              response: new Response(JSON.stringify({ success: true, skipped: true }), {
                headers: { 'Content-Type': 'application/json' },
              }),
            };
          }

          return {
            context: {
              classroomId: attempt.quiz.classroom_id,
              attempt,
              metadata: {
                attempt_id: data.attemptId,
                quiz_id: attempt.quiz_id,
              },
            },
          };
        }

        case 'recordModalOpen': {
          if (!data.attemptId) {
            return { response: jsonResponse(400, 'Missing attemptId') };
          }

          const attempt = await ClassmojiService.quizAttempt.findById(data.attemptId);

          if (!attempt) {
            return {
              response: new Response(JSON.stringify({ success: true, skipped: true }), {
                headers: { 'Content-Type': 'application/json' },
              }),
            };
          }

          return {
            context: {
              classroomId: attempt.quiz.classroom_id,
              attempt,
              metadata: {
                attempt_id: data.attemptId,
                quiz_id: attempt.quiz_id,
              },
            },
          };
        }

        default:
          return { response: jsonResponse(400, 'Invalid action') };
      }
    };

    const { context, response: contextResponse } = await resolveOrgContext();
    if (contextResponse) {
      return contextResponse;
    }

    // Every branch above addresses its record by a body-supplied id, so the
    // classroom id carried out of that record is what authorizes the call. The
    // previous shape read a slug off the record and let the auth layer resolve it
    // again, which left nothing tying the authorized classroom to the quiz or
    // attempt mutated below. `access.classroom` is that same row.
    const access = await assertClassroomAccess({
      request,
      classroomId: context.classroomId,
      allowedRoles,
      resourceType: 'QUIZ_API_ACTION',
      attemptedAction: data._action,
      metadata: context.metadata,
    });
    assertClassroomMutationAllowed({
      status: access.classroom.status,
      role: access.membership!.role,
    });

    // Check AI agent availability AFTER auth (preserves audit logging)
    if (!isAIAgentConfigured()) {
      return new Response(JSON.stringify({ error: 'AI features are not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // The same visibility rule every quiz surface uses (Pro, quizzes not
    // switched off). Returned rather than thrown so the body is the fixed
    // refusal the quiz UI knows how to show. A failed lookup throws, and the
    // catch below answers it as any other failure (a 500 with fixed copy), so
    // it neither serves the quiz nor tells the student quizzes are gone.
    if (!(await quizzesVisibleOrThrow(context.classroomId))) {
      return new Response(JSON.stringify(QUIZZES_UNAVAILABLE_BODY), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { userId } = access;

    /**
     * The pre-attempt source-material check (quiz source material §4.3).
     *
     * A quiz with NO linked documents is ungrounded and behaves exactly as it
     * always has: no extra query. One with links answers 409 when none of them
     * would reach this user's prompt, BEFORE an attempt exists, so a refused
     * start consumes no attempt.
     */
    const sourceMaterialRefusal = async (
      quiz: { id: string; classroom_id: string; source_material?: unknown[] } | undefined
    ): Promise<Response | null> => {
      if (!quiz?.source_material?.length) return null;
      const { configured, startable } = await ClassmojiService.quizSourceMaterial.countStartable({
        quizId: quiz.id,
        classroomId: quiz.classroom_id,
        userId,
      });
      return configured > 0 && startable === 0 ? sourceMaterialUnavailableResponse() : null;
    };

    // The caller's session, for the GitHub user token a staff preview's
    // repository is checked with. While an admin views as a student ("View
    // As"), the session and `userId` above are that student's, so the
    // ownership checks below admit the student's own attempts and nobody
    // else's.
    const { getAuthSession } = await import('@classmoji/auth/server');
    const authData = await getAuthSession(request);

    switch (data._action) {
      case 'startQuiz': {
        try {
          // If attemptId is provided, use it (for resuming specific attempts)
          // Otherwise create a new attempt respecting max_attempts
          let attempt;

          if (data.attemptId) {
            // Resume specific attempt (e.g., admin preview with pre-created attempt).
            // Bound to `quizId`, because that is the quiz every gate above was
            // resolved from: the classroom membership, the mutation check and
            // the quiz-visibility check all answer for THAT quiz's classroom, so
            // an attempt on any other one would run under gates that never
            // examined it. `findWithMessages` throws when there is no such
            // attempt, so both cases land on the same 404 below — and only
            // that error does; anything else the query raises still surfaces.
            const attemptData = await ClassmojiService.quizAttempt
              .findWithMessages(data.attemptId)
              .catch((error: unknown) => {
                if (error instanceof QuizAttemptNotFoundError) return null;
                throw error;
              });
            if (
              !attemptData?.attempt ||
              attemptData.attempt.quiz_id.toString() !== data.quizId.toString()
            ) {
              return new Response(JSON.stringify({ error: 'Attempt not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            // Verify ownership
            if (attemptData.attempt.user_id.toString() !== userId.toString()) {
              return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            attempt = attemptData.attempt;
          } else {
            // Nothing linked is available to this user: refuse BEFORE the
            // attempt row exists, so the refusal costs no attempt.
            const refusal = await sourceMaterialRefusal(context.quiz);
            if (refusal) return refusal;

            // Create new attempt with max_attempts validation, on the chat
            // runtime. A student with no repository for a code-aware quiz
            // still gets an attempt: the chat runs it on the concepts.
            const result = await ClassmojiService.quizAttempt.createNew(
              data.quizId,
              userId,
              access.membership!
            );

            if (!result.success) {
              return new Response(JSON.stringify(result), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            // Fetch the full attempt with quiz data
            const attemptData = await ClassmojiService.quizAttempt.findWithMessages(
              result.attemptId!
            );
            attempt = attemptData.attempt;
          }

          // Every attempt runs on the chat runtime and starts through its own
          // session (api.quiz-chat.session) when its drawer opens; nothing here
          // touches it. Its id goes back as for any started attempt, so the
          // quiz list opens it the same way. An attempt from the retired
          // ai-agent runtime can no longer be started or continued.
          if (!isTriggerChatAttempt(attempt)) {
            return runtimeMismatchResponse();
          }

          return new Response(JSON.stringify({ attemptId: attempt.id }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          console.error('Error starting quiz:', error);
          throw error;
        }
      }

      case 'updateMetrics': {
        try {
          if (!data.attemptId) {
            return new Response(JSON.stringify({ error: 'Missing attemptId' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const attempt = context.attempt;

          // Gracefully handle deleted attempts (e.g., after restart)
          if (!attempt) {
            return new Response(JSON.stringify({ success: true, skipped: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (attempt.user_id.toString() !== userId.toString()) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // CRITICAL: Reject updates for an already-completed attempt from the
          // retired ai-agent runtime. A chat attempt is completed by its task after the student's
          // last message, so its drawer sends the time since then once it sees
          // the completion; the service takes it only within ten minutes of
          // the completion, and only ever raises its two durations.
          if (attempt.completed_at && !isTriggerChatAttempt(attempt)) {
            return new Response(
              JSON.stringify({
                success: false,
                skipped: true,
                reason: 'Quiz already completed',
                completedAt: attempt.completed_at,
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const metrics = extractDurationMetrics(data);
          const result = await ClassmojiService.quizAttempt.updateDurations(
            data.attemptId,
            metrics
          );

          return new Response(JSON.stringify({ success: true, updated: result }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          console.log(error);
          // If error is about record not found, treat it as success (attempt was deleted)
          if (error instanceof Error && error.message?.includes('Record to update not found')) {
            return new Response(JSON.stringify({ success: true, skipped: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw error;
        }
      }

      case 'recordModalClose': {
        try {
          if (!data.attemptId) {
            return new Response(JSON.stringify({ error: 'Missing attemptId' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const attempt = context.attempt;

          if (!attempt) {
            return new Response(JSON.stringify({ success: true, skipped: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Don't record close if quiz is already completed
          if (attempt.completed_at) {
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (attempt.user_id.toString() !== userId.toString()) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Extract metrics if provided (for atomic close + metrics update)
          const metrics = extractDurationMetrics(data);
          const hasMetrics = Object.keys(metrics).length > 0;

          const result = await ClassmojiService.quizAttempt.recordModalClosed(
            data.attemptId,
            hasMetrics ? metrics : null
          );

          return new Response(JSON.stringify({ success: true, updated: result }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          console.error('[recordModalClose] Error:', error);
          throw error;
        }
      }

      case 'recordModalOpen': {
        try {
          if (!data.attemptId) {
            return new Response(JSON.stringify({ error: 'Missing attemptId' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const attempt = context.attempt;

          if (!attempt) {
            return new Response(JSON.stringify({ success: true, skipped: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Don't calculate gap if quiz is already completed
          if (attempt.completed_at) {
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (attempt.user_id.toString() !== userId.toString()) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const result = await ClassmojiService.quizAttempt.calculateAndApplyModalGap(
            data.attemptId
          );

          return new Response(
            JSON.stringify({
              success: true,
              gapApplied: result.gapApplied,
              gapMs: result.gapMs,
              durations: {
                total_duration_ms: result.total_duration_ms,
                unfocused_duration_ms: result.unfocused_duration_ms,
              },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch (error: unknown) {
          console.error('[recordModalOpen] Error:', error);
          throw error;
        }
      }

      case 'restartQuiz': {
        try {
          // Nothing linked is available to this user: refuse before anything
          // changes — no attempt is created.
          const refusal = await sourceMaterialRefusal(context.quiz);
          if (refusal) return refusal;

          // A teaching-team preview of a code-aware quiz names the repository
          // to test with (OWNER, TEACHER and ASSISTANT only, as in startQuiz).
          // The chat runtime explores it with the GitHub App's installation
          // token, which reaches every repository the app is installed on, so
          // the name is taken only when the caller's own GitHub account can
          // open it: a preview reads what that person can read. Checked before
          // anything changes, so a refusal creates no attempt. The owner is
          // the classroom's organization, never input.
          const isInstructor = ['OWNER', 'ASSISTANT', 'TEACHER'].includes(access.membership!.role);
          const previewRepo =
            isInstructor && typeof data.repoName === 'string' && data.repoName
              ? data.repoName
              : null;
          if (previewRepo) {
            const { previewRepoAccess } = await import('./previewRepoAccess.server');
            const repoAccess = await previewRepoAccess({
              token: authData?.token,
              owner: access.classroom.git_organization?.login,
              repo: previewRepo,
            });
            if (repoAccess === 'sign_in' && !authData?.userLogin) {
              // No GitHub account linked to this sign-in at all.
              return previewRepoRefusal('connect');
            }
            if (repoAccess !== 'readable') return previewRepoRefusal(repoAccess);
          }

          // A new attempt, on the chat runtime, respecting max_attempts.
          const result = await ClassmojiService.quizAttempt.createNew(
            data.quizId,
            userId,
            access.membership!
          );

          if (!result.success) {
            return new Response(JSON.stringify(result), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // The preview's repository, checked above: saved to agent_config,
          // where the chat runtime reads it.
          if (previewRepo) {
            await ClassmojiService.quizAttempt.updateAgentConfig(result.attemptId!, {
              instructorRepoName: previewRepo,
            });
          }

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          if (error instanceof Response) return error;
          console.error('[restartQuiz] Error:', error);
          return new Response(JSON.stringify({ success: false, message: RESTART_FAILED_MESSAGE }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      default:
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }
  } catch (error: unknown) {
    // A gate's refusal (access, classroom status) goes back exactly as thrown.
    if (error instanceof Response) return error;
    console.error('API Quiz action error:', error);
    return new Response(JSON.stringify({ success: false, error: GENERIC_FAILURE_MESSAGE }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
