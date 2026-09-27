/**
 * Quiz API endpoint - handles all quiz-related actions
 *
 * SECURITY MEASURES:
 * 1. Authentication: All requests require valid userId from cookie
 * 2. Authorization: Users can only access their own quiz attempts
 * 3. Attempt Ownership Verification:
 *    - sendMessage: Verifies user owns the attempt before allowing messages
 *    - completeQuiz: Verifies user owns the attempt before marking complete
 *    - restartQuiz: Ends the prior ai-agent session only when the named attempt
 *      is the caller's own attempt on the quiz being restarted
 * 4. Audit Logging: All unauthorized access attempts are logged
 * 5. Admin Access: Admins preview quizzes as themselves, creating their own attempts
 *    - This ensures data isolation between admin previews and student attempts
 *
 * ACTIONS:
 * - startQuiz: Creates or resumes a quiz attempt for the authenticated user
 * - sendMessage: Adds a message to a quiz attempt (ownership verified)
 * - completeQuiz: Marks a quiz attempt as complete (ownership verified)
 * - updateMetrics: Updates duration metrics for a quiz attempt
 * - recordModalClose: Records when the quiz modal is closed
 * - recordModalOpen: Calculates gap time and adds to unfocused duration when modal reopens
 * - restartQuiz: Deletes and restarts a quiz attempt (dev mode only)
 */
import { assertClassroomAccess } from '~/utils/helpers';
import { assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { runBackgroundTask } from '~/utils/backgroundTask.server';
import {
  getQuestionProgressFromMessage,
  checkForCompletion,
  repoNamespace,
} from '@classmoji/utils';
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
 * The ai-agent's platform budget guard (AI_MAX_BUDGET_USD) stopped the turn.
 * aiAgentConnection carries the ERROR payload's `code` onto the thrown error.
 */
const isBudgetExceeded = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'BUDGET_EXCEEDED';

/**
 * Saved in place of a first question when the budget guard stopped the opening
 * turn. It does not say "restart the quiz", because a student can't: createNew
 * refuses a new attempt while this one is incomplete (the quiz list offers to
 * resume it instead), and resuming doesn't re-run startQuiz, since the ai-agent
 * already saved the welcome message. Sending a message does work: the ai-agent
 * recovers the session it dropped and, with questions_asked still 0, presents
 * Question 1. That is also why nothing here invents a question or advances
 * questions_asked.
 */
const BUDGET_STOPPED_START_MESSAGE =
  "Your first question couldn't be prepared. Send any message to try again.";

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
 * Fixed copy for failures. Whatever went wrong is logged here and never sent to
 * the browser or saved into the transcript.
 */
const GENERIC_FAILURE_MESSAGE = 'Something went wrong. Please try again.';
const REPLY_FAILED_MESSAGE = "That reply couldn't be finished. Please send your message again.";
const RESTART_FAILED_MESSAGE = "Couldn't start a new attempt. Please try again.";

/**
 * ai-agent codes whose text is fixed copy meant for the student (see
 * aiAgentConnection's USER_FACING_ERROR_CODES), so a failed reply may show it.
 * Every other code, API_ERROR included, gets REPLY_FAILED_MESSAGE.
 *
 * This decides what an AGENT_FAILURE row is SAVED with. What the transcript
 * SHOWS is decided by the list of the same name in @classmoji/services
 * (quizAttempt.service.ts, toTranscriptFields), which rewrites any
 * AGENT_FAILURE row whose code is not on it to the fixed line. That list is the
 * one that counts, and this one must match it. A refused source-material
 * recovery is therefore not saved as an AGENT_FAILURE at all (see sendMessage).
 */
const STUDENT_FACING_AGENT_CODES = ['BUDGET_EXCEEDED'];

/**
 * A quiz that links source material (pages and decks) is built from it, so a
 * student who can see none of it has nothing to be quizzed on: every linked
 * document is still a draft, or none has been indexed yet. Fixed copy, shown
 * as-is by the quiz list and the attempt modal (they read `message`).
 */
const SOURCE_MATERIAL_UNAVAILABLE_MESSAGE =
  "This quiz's source material isn't available yet. Ask your instructor.";

/**
 * The ai-agent's own refusal for the same state, raised when its load at
 * attempt start (or on session recovery) finds no document for this user — a
 * page unpublished between the pre-check and the init, say. aiAgentConnection
 * carries the ERROR payload's `code` onto the thrown error.
 */
const isSourceMaterialUnavailable = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'source_material_unavailable';

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

/**
 * How long a start on a quiz with linked source material waits for the
 * ai-agent's verdict on it (see startQuiz). The verdict normally lands well
 * inside this — the welcome is saved right after the material loads — so the
 * bound only matters when the ai-agent is slow or ignores a duplicate init;
 * the start then answers as it always has.
 */
const SOURCE_MATERIAL_VERDICT_MS = 5000;

/** The verdict, or `false` (not refused) once SOURCE_MATERIAL_VERDICT_MS passes. */
const verdictWithin = (verdict: Promise<boolean>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), SOURCE_MATERIAL_VERDICT_MS);
  });
  return Promise.race([verdict, elapsed]).finally(() => clearTimeout(timer));
};

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
  const { getInstallationToken, gitlabProjectAccess } =
    await import('../student.$class.quizzes/helpers.server');
  const { initializeQuizViaAgent, sendMessageToAgent, endQuizSession } =
    await import('../student.$class.quizzes/aiAgent.server');
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

    // The single gate for start/send/complete/metrics. TEACHER belongs here for
    // the same reason OWNER and ASSISTANT do: staff take quizzes to preview
    // them, and the code-aware branch below already expects a TEACHER to reach
    // it (see the `isInstructor` check in startQuiz).
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

        case 'sendMessage': {
          if (!data.attemptId) {
            return { response: jsonResponse(400, 'Missing attemptId') };
          }

          const attemptData = await ClassmojiService.quizAttempt.findWithMessages(data.attemptId);
          if (!attemptData?.attempt) {
            return { response: jsonResponse(404, 'Attempt not found') };
          }

          return {
            context: {
              classroomId: attemptData.attempt.quiz.classroom_id,
              attemptData,
              metadata: {
                attempt_id: data.attemptId,
                quiz_id: attemptData.attempt.quiz_id,
              },
            },
          };
        }

        case 'completeQuiz': {
          if (!data.attemptId) {
            return { response: jsonResponse(400, 'Missing attemptId') };
          }

          const attempt = await ClassmojiService.quizAttempt.findById(data.attemptId);
          if (!attempt) {
            return { response: jsonResponse(404, 'Attempt not found') };
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

        case 'restartQuiz': {
          if (!data.quizId) {
            return { response: jsonResponse(400, 'Missing quizId') };
          }

          const quiz = await ClassmojiService.quiz.findById(data.quizId);
          if (!quiz) {
            return { response: jsonResponse(404, 'Quiz not found') };
          }

          // `attemptId` names the session to tear down and nothing else — the
          // attempt this branch creates always belongs to the caller. Resolve it
          // here so the branch below can hold it against this quiz and this
          // caller before ending anything. Anything that is not a string names
          // no attempt: the column is text, and handing Prisma a number raises
          // a validation error rather than simply missing.
          const attempt =
            typeof data.attemptId === 'string' && data.attemptId
              ? await ClassmojiService.quizAttempt.findById(data.attemptId)
              : null;

          return {
            context: {
              classroomId: quiz.classroom_id,
              quiz,
              attempt,
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
     * start consumes no attempt. The ai-agent repeats the check at init.
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

    /**
     * Removes an attempt nothing has happened on (no message saved, no
     * question asked) once its start is refused for source material: left in
     * place it would count toward max_attempts and block a new attempt, though
     * the student never got a question. This is the race between the check
     * above and a start (a document unpublished in between). An attempt with
     * history is kept, and `false` says so. One already gone counts as removed.
     */
    const discardUnstartedAttempt = async (attemptId: string): Promise<boolean> => {
      const current = await ClassmojiService.quizAttempt
        .findWithMessages(attemptId)
        .catch((error: unknown) => {
          if (error instanceof QuizAttemptNotFoundError) return null;
          throw error;
        });
      if (!current) return true;
      if (current.messages.length > 0 || (current.questionsAsked ?? 0) > 0) return false;
      try {
        await ClassmojiService.quizAttempt.deleteAttempt(attemptId);
      } catch (error) {
        // A second refusal of the same start can remove it first (P2025).
        if ((error as { code?: unknown } | null)?.code !== 'P2025') throw error;
      }
      return true;
    };

    /**
     * The MCP read token this ai-agent call carries (quiz source material,
     * Stage 2), minted for the caller the way Ask Moji mints it: every call,
     * reusing a live token with time left. The quiz uses it to read linked
     * documents in full and, when the quiz allows it, to search the course.
     *
     * A mint failure does NOT fail the turn: the quiz runs without that
     * verification. NEVER LOG THE TOKEN; it goes only into the HMAC-signed
     * payload, never to the browser and never into storage.
     */
    const mintQuizMcpToken = async (): Promise<
      { accessToken: string; expiresAt: string } | undefined
    > => {
      try {
        const { mintMcpAccessToken } = await import('@classmoji/auth/mcp-token');
        const { accessToken, expiresAt } = await mintMcpAccessToken(userId);
        return { accessToken, expiresAt: expiresAt.toISOString() };
      } catch (error) {
        console.error(
          '[quiz] MCP token mint failed; continuing without course verification:',
          error instanceof Error ? error.message : 'unknown error'
        );
        return undefined;
      }
    };

    // Check if admin is impersonating a student (for "View As" feature)
    // Impersonating admins can interact with quiz attempts on behalf of students
    const { getAuthSession } = await import('@classmoji/auth/server');
    const authData = await getAuthSession(request);
    const isImpersonating = !!(authData as { session?: { session?: { impersonatedBy?: string } } })
      ?.session?.session?.impersonatedBy;

    switch (data._action) {
      case 'startQuiz': {
        try {
          // If attemptId is provided, use it (for resuming specific attempts)
          // Otherwise create a new attempt respecting max_attempts
          let attempt;
          // Whether the source-material pre-check has already run for this call.
          let materialChecked = false;

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
              // A refused start removes its attempt (discardUnstartedAttempt),
              // so a page still open on it learns why, not "not found". The
              // check is this caller's, on the quiz already gated above; it
              // says nothing about the attempt id.
              const refusal = await sourceMaterialRefusal(context.quiz);
              if (refusal) return refusal;
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
            materialChecked = true;

            // Create new attempt with max_attempts validation
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

          // Skip if already started - check AIConversation messages (not attempt.messages)
          // This prevents duplicate initialization when the browser makes multiple requests
          const messagesCheck = await ClassmojiService.quizAttempt.findWithMessages(attempt.id);
          if (messagesCheck.messages && messagesCheck.messages.length > 0) {
            return new Response(JSON.stringify({ attemptId: attempt.id }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // A fresh attempt made by restartQuiz (which ran the same check) is
          // about to start: check again, since the material can have changed
          // in between. An attempt already under way is never stopped here.
          if (!materialChecked) {
            const refusal = await sourceMaterialRefusal(context.quiz);
            if (refusal) {
              await discardUnstartedAttempt(attempt.id);
              return refusal;
            }
          }

          /**
           * The ai-agent's verdict on this start: `true` once a refusal for
           * source material has removed the attempt, `false` once it is plainly
           * going ahead (the welcome it saves after loading the material, or
           * the init's end, whatever the outcome). Only a quiz that links
           * material can be refused, so only its start waits for this (bounded
           * by SOURCE_MATERIAL_VERDICT_MS) and answers a refusal with the same
           * 409 as the check above. The browser is then never sent to an
           * attempt that is about to disappear, and never polls one.
           */
          const awaitsVerdict = Boolean(context.quiz?.source_material?.length);
          let settleVerdict: (removed: boolean) => void = () => {};
          const verdict = new Promise<boolean>(resolve => {
            settleVerdict = resolve;
          });
          const onWelcomeMessage = () => settleVerdict(false);

          /**
           * The init's refusal for source material. A brand-new attempt is
           * removed (discardUnstartedAttempt) and the start answers 409; one
           * with history keeps its transcript and gets one fixed line in place
           * of a question (no generic fallback, no count bump).
           */
          const refuseStart = async () => {
            if (await discardUnstartedAttempt(attempt.id)) {
              settleVerdict(true);
              return;
            }
            await ClassmojiService.aiConversation.addMessage(
              attempt.id,
              'ASSISTANT',
              SOURCE_MATERIAL_UNAVAILABLE_MESSAGE,
              false,
              { errorType: 'SOURCE_MATERIAL_UNAVAILABLE' }
            );
          };

          /** 409 when the verdict removed the attempt, otherwise the attempt id. */
          const startResponse = async () =>
            awaitsVerdict && (await verdictWithin(verdict))
              ? sourceMaterialUnavailableResponse()
              : new Response(JSON.stringify({ attemptId: attempt.id }), {
                  headers: { 'Content-Type': 'application/json' },
                });

          // Check if this is a code-aware quiz (linked to a repository with code context enabled)
          if (attempt.quiz.repository_id && attempt.quiz.include_code_context) {
            // Generate the first question in the background; the response
            // waits for no more than the verdict (see startResponse).
            runBackgroundTask('startQuiz:codeAware', async () => {
              try {
                // Check if user is an instructor (OWNER or ASSISTANT)
                const isInstructor = ['OWNER', 'ASSISTANT', 'TEACHER'].includes(
                  access.membership!.role
                );

                let repoName: string;

                if (isInstructor && data.repoName) {
                  // Instructor provided a repo to test with - save it for future calls
                  repoName = data.repoName;
                  // Store in agent_config so subsequent calls can use it
                  await ClassmojiService.quizAttempt.updateAgentConfig(attempt.id, {
                    instructorRepoName: repoName,
                  });
                } else if (isInstructor) {
                  // Re-fetch the attempt to get the latest agent_config
                  // (may have been updated by a concurrent call that saved instructorRepoName)
                  const freshAttempt = await ClassmojiService.quizAttempt.findById(attempt.id);
                  const agentConfig = (freshAttempt as Record<string, unknown>)?.agent_config as
                    | Record<string, unknown>
                    | undefined;
                  if (agentConfig?.instructorRepoName) {
                    repoName = agentConfig.instructorRepoName as string;
                  } else {
                    // Instructor didn't select a repo for code-aware quiz
                    throw new Error('Please select a repository to test with.');
                  }
                } else {
                  // Standard flow: find student's repo
                  const repo = await ClassmojiService.gitRepo.findByStudent(
                    attempt.quiz.repository_id!,
                    userId
                  );
                  if (!repo) {
                    throw new Error('No repository found for this repository.');
                  }
                  repoName = repo.name;
                }

                // Prefer user's ghu_ token (per-user rate limits) with installation token fallback
                // ai-agent validates the token with GitHub before use, falls back if invalid
                const gitOrganization = attempt.quiz.classroom.git_organization;
                // Gitlab: a read-only token for this one project, and where
                // it lives (the class subgroup's `projects`).
                // An instructor preview names a project by its full path
                // (any project in the class's Gitlab group, e.g. a solution
                // under templates/); that path must stay inside the group.
                let gitlabNamespace: string | null = null;
                if (gitOrganization.provider === 'GITLAB') {
                  const slash = repoName.lastIndexOf('/');
                  if (isInstructor && slash > 0) {
                    gitlabNamespace = repoName.slice(0, slash);
                    repoName = repoName.slice(slash + 1);
                    const group = gitOrganization.login.toLowerCase();
                    const ns = gitlabNamespace.toLowerCase();
                    if (ns !== group && !ns.startsWith(`${group}/`)) {
                      throw new Error("That project is not in this classroom's Gitlab group.");
                    }
                  } else {
                    gitlabNamespace = repoNamespace(
                      attempt.quiz.classroom as Parameters<typeof repoNamespace>[0]
                    );
                  }
                }
                const repoAccess = gitlabNamespace
                  ? await gitlabProjectAccess(gitOrganization, gitlabNamespace, repoName)
                  : {
                      orgLogin: gitOrganization.login,
                      accessToken: authData?.token || (await getInstallationToken(gitOrganization)),
                    };

                // Load classroom settings for LLM configuration
                const classroomSettings = attempt.quiz.classroom?.settings;
                const mcpToken = await mintQuizMcpToken();

                // Initialize via WebSocket to ai-agent service
                // ai-agent saves all messages (welcome, exploration steps, opening) to DB
                // Frontend polls DB via revalidation — no SSE callbacks needed
                const result = await initializeQuizViaAgent(
                  attempt.id,
                  {
                    systemPrompt: attempt.quiz.system_prompt,
                    rubricPrompt: attempt.quiz.rubric_prompt,
                    questionCount: attempt.quiz.question_count || 5,
                    subject: attempt.quiz.subject,
                    difficultyLevel: attempt.quiz.difficulty_level,
                    anthropicApiKey: classroomSettings?.anthropic_api_key,
                    model: classroomSettings?.code_aware_model,
                    // Repo-exploration sub-agent. Runs on the platform key in
                    // Trigger.dev regardless of anthropicApiKey.
                    explorationModel: classroomSettings?.exploration_model,
                    // Reasoning effort per phase; null = the ai-agent's
                    // platform default. The ai-agent drops it for a model that
                    // takes no effort.
                    questionEffort: classroomSettings?.question_effort,
                    gradingEffort: classroomSettings?.grading_effort,
                    explorationEffort: classroomSettings?.exploration_effort,
                  },
                  // Code-aware options
                  { ...repoAccess, repoName },
                  { mcpToken, onWelcomeMessage }
                );

                // ai-agent already saved the opening message to AIConversationMessage
                // Check first question was received
                let firstQuestion = result.openingMessage;
                if (!firstQuestion) {
                  console.error('[startQuiz] No first question received from ai-agent');
                  // Use a fallback message
                  firstQuestion = `Let's begin with the first question about your code.`;
                }

                // Note: Message and questions_asked already saved by ai-agent via conversationStorage
                // ai-agent sets absolute value, so no increment needed here
                // Frontend picks up new messages via DB polling (revalidation)
              } catch (error: unknown) {
                console.error('[startQuiz] Quiz-agent initialization failed:', error);

                // The ai-agent found nothing to build the quiz from.
                if (isSourceMaterialUnavailable(error)) {
                  await refuseStart();
                  return;
                }

                // Stopped by the budget guard: say so, and ask no question.
                if (isBudgetExceeded(error)) {
                  await ClassmojiService.aiConversation.addMessage(
                    attempt.id,
                    'ASSISTANT',
                    BUDGET_STOPPED_START_MESSAGE,
                    false,
                    { errorType: 'BUDGET_EXCEEDED' }
                  );
                  return;
                }

                // Fallback to standard LLM
                const fallbackMessage =
                  error instanceof Error && error.message?.includes('No repository found')
                    ? `Welcome to your quiz! This assignment doesn't have a linked repository. Let's discuss the concepts. Ready to begin?`
                    : `Welcome! I'm having trouble accessing your code right now, but we can still proceed. Let's discuss the concepts. Ready to begin?`;

                await ClassmojiService.aiConversation.addMessage(
                  attempt.id,
                  'ASSISTANT',
                  fallbackMessage,
                  true
                );
                await ClassmojiService.quizAttempt.incrementQuestionsAsked(attempt.id);
              } finally {
                settleVerdict(false);
              }
            });

            // The background task saves messages to the DB; the frontend picks
            // them up via polling (revalidation).
            return startResponse();
          } else {
            // Standard quiz without code context - use ai-agent service.
            // Generate the first question in the background; the response
            // waits for no more than the verdict (see startResponse), and the
            // frontend polls the DB for new messages.
            runBackgroundTask('startQuiz:standard', async () => {
              try {
                // Load classroom settings for LLM configuration
                const classroomSettings = attempt.quiz.classroom?.settings;

                const mcpToken = await mintQuizMcpToken();

                // Initialize via WebSocket to ai-agent service (no code-aware options)
                // ai-agent saves all messages to DB, frontend polls via revalidation
                const result = await initializeQuizViaAgent(
                  attempt.id,
                  {
                    systemPrompt: attempt.quiz.system_prompt,
                    rubricPrompt: attempt.quiz.rubric_prompt,
                    questionCount: attempt.quiz.question_count || 5,
                    subject: attempt.quiz.subject,
                    difficultyLevel: attempt.quiz.difficulty_level,
                    anthropicApiKey: classroomSettings?.anthropic_api_key,
                    model: classroomSettings?.llm_model,
                    // Reasoning effort per phase; null = the ai-agent's default.
                    questionEffort: classroomSettings?.question_effort,
                    gradingEffort: classroomSettings?.grading_effort,
                  },
                  null,
                  { mcpToken, onWelcomeMessage }
                );

                // ai-agent already saved the opening message to AIConversationMessage
                // Check first question was received
                let firstQuestion = result.openingMessage;
                if (!firstQuestion) {
                  console.error('[startQuiz] No first question received from ai-agent');
                  firstQuestion = `Let's begin with your first question. Can you tell me about your understanding of the key concepts we'll be covering today?`;
                }

                // Note: Message and questions_asked already saved by ai-agent via conversationStorage
                // ai-agent sets absolute value, so no increment needed here
                // Frontend picks up new messages via DB polling (revalidation)
              } catch (llmError) {
                console.error('[startQuiz] Quiz-agent error:', llmError);

                // The ai-agent found nothing to build the quiz from.
                if (isSourceMaterialUnavailable(llmError)) {
                  await refuseStart();
                  return;
                }

                // Stopped by the budget guard: say so, and ask no question.
                if (isBudgetExceeded(llmError)) {
                  await ClassmojiService.aiConversation.addMessage(
                    attempt.id,
                    'ASSISTANT',
                    BUDGET_STOPPED_START_MESSAGE,
                    false,
                    { errorType: 'BUDGET_EXCEEDED' }
                  );
                  return;
                }

                const fallbackQuestion = `Let's begin with your first question. Can you tell me about your understanding of the key concepts we'll be covering today?`;

                await ClassmojiService.aiConversation.addMessage(
                  attempt.id,
                  'ASSISTANT',
                  fallbackQuestion,
                  true
                );
                await ClassmojiService.quizAttempt.incrementQuestionsAsked(attempt.id);
              } finally {
                settleVerdict(false);
              }
            });

            return startResponse();
          }
        } catch (error: unknown) {
          console.error('Error starting quiz:', error);
          throw error;
        }
      }

      case 'sendMessage': {
        // Set once the viewer is known to own the attempt; the catch below only
        // writes to a transcript the viewer may write to.
        let ownsAttempt = false;
        // Set once the ai-agent has replied; its reply is already saved.
        let agentReplied = false;
        try {
          // SECURITY: Verify the user owns this attempt before allowing message
          const attemptData = context.attemptData;

          if (!attemptData!.attempt || !attemptData!.attempt.quiz) {
            throw new Error('Attempt or quiz data not found');
          }

          // SECURITY CHECK: Verify the authenticated user owns this quiz attempt
          // Allow if admin is impersonating (View As feature)
          if (attemptData!.attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
            console.error(
              `[sendMessage] Security violation: User ${userId} tried to send message to attempt ${data.attemptId} owned by ${attemptData!.attempt.user_id}`
            );

            // Log the security violation
            await ClassmojiService.audit.create({
              classroom_id: attemptData!.attempt.quiz.classroom_id,
              user_id: userId.toString(),
              role: 'STUDENT',
              resource_id: data.attemptId,
              resource_type: 'QUIZ_ATTEMPT_MESSAGE_UNAUTHORIZED',
              action: 'ACCESS_DENIED',
              data: {
                unauthorized_access: true,
                attempted_attempt_id: data.attemptId,
                owner_user_id: attemptData!.attempt.user_id.toString(),
                attempted_action: 'sendMessage',
              },
            });

            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          ownsAttempt = true;

          // Note: ai-agent saves user message via conversationStorage in handleStudentMessage
          // No need to save here - avoiding duplicate writes

          let aiResponse;

          try {
            // Send message via WebSocket to ai-agent service
            // Both standard and code-aware quizzes use the same unified path
            // ai-agent saves all messages (user, exploration steps, response) to DB
            const mcpToken = await mintQuizMcpToken();
            const result = await sendMessageToAgent(data.attemptId, data.content, { mcpToken });
            agentReplied = true;

            aiResponse = result.content;
          } catch (agentError) {
            console.error('[sendMessage] Quiz-agent failed:', agentError);

            // Saved into the transcript, which the student and staff both
            // read, so it is fixed copy: the ai-agent's own text only for the
            // codes it writes for students, one line for anything else (a
            // timeout included). The real error is in the log above.
            const agentCode = (agentError as { code?: unknown } | null)?.code;
            const code = typeof agentCode === 'string' ? agentCode : null;
            // A recovery refused for source material is saved exactly as a
            // refused start is: under its own errorType, which the transcript
            // shows as saved. As an AGENT_FAILURE its code would have to be on
            // the services' STUDENT_FACING_AGENT_CODES, or the student reads
            // "That reply couldn't be finished" instead of why.
            const sourceMaterialRefused = isSourceMaterialUnavailable(agentError);
            aiResponse = sourceMaterialRefused
              ? SOURCE_MATERIAL_UNAVAILABLE_MESSAGE
              : code && STUDENT_FACING_AGENT_CODES.includes(code) && agentError instanceof Error
                ? agentError.message || REPLY_FAILED_MESSAGE
                : REPLY_FAILED_MESSAGE;

            await ClassmojiService.aiConversation.addMessage(
              data.attemptId,
              'ASSISTANT',
              aiResponse,
              false,
              sourceMaterialRefused
                ? { errorType: 'SOURCE_MATERIAL_UNAVAILABLE' }
                : { errorType: 'AGENT_FAILURE', code }
            );

            return new Response(JSON.stringify({ success: false, error: 'Agent failure' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Ensure we have a response
          if (!aiResponse) {
            aiResponse =
              'I apologize, but I encountered an issue generating a response. Please try again.';
          }

          const questionProgress = getQuestionProgressFromMessage(aiResponse);
          const currentQuestionsAsked = attemptData!.questionsAsked || 0;
          const hasQuestion = Boolean(questionProgress);
          const isNewQuestion =
            hasQuestion && questionProgress!.questionNumber > currentQuestionsAsked;

          const completionData = checkForCompletion(aiResponse);

          // Ensure interactive buttons are present when agent forgets to include them
          if (!aiResponse.includes('[BUTTON:') && !completionData && !hasQuestion) {
            aiResponse = `${aiResponse.trim()}\n\n[BUTTON:TRY_AGAIN] [BUTTON:NEXT]`;
          }

          // Note: ai-agent already saved assistant response and questions_asked via conversationStorage
          // ai-agent sets absolute value, so no increment needed here

          const updatedQuestionsAsked = isNewQuestion
            ? questionProgress!.questionNumber
            : currentQuestionsAsked;

          // Check for quiz completion
          const newQuestionsAsked = Math.max(
            updatedQuestionsAsked,
            questionProgress?.questionNumber || 0
          );
          if (newQuestionsAsked >= (attemptData!.questionCount || 5)) {
            const completion = completionData || checkForCompletion(aiResponse);
            if (completion) {
              await ClassmojiService.quizAttempt.completeAttempt(data.attemptId);
            }
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          if (error instanceof Response) return error;
          console.error('[sendMessage] Error:', error);

          if (!ownsAttempt) {
            return new Response(
              JSON.stringify({ success: false, error: GENERIC_FAILURE_MESSAGE }),
              {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          // The reply is saved and the student sees it; the quiz page completes
          // the attempt itself when the reply ends it. Nothing to resend.
          if (agentReplied) {
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Saved into the transcript like an ai-agent failure, so the same
          // fixed line; the real error is in the log above.
          await ClassmojiService.aiConversation.addMessage(
            data.attemptId,
            'ASSISTANT',
            REPLY_FAILED_MESSAGE,
            false,
            {
              errorType: 'GENERAL_FAILURE',
            }
          );

          return new Response(JSON.stringify({ success: false, error: REPLY_FAILED_MESSAGE }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      case 'completeQuiz': {
        try {
          // SECURITY: Verify the user owns this attempt before allowing completion
          const attempt = context.attempt;

          if (!attempt) {
            return new Response(JSON.stringify({ error: 'Attempt not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // SECURITY CHECK: Verify the authenticated user owns this quiz attempt
          // Allow if admin is impersonating (View As feature)
          if (attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
            console.error(
              `[completeQuiz] Security violation: User ${userId} tried to complete attempt ${data.attemptId} owned by ${attempt.user_id}`
            );

            // Log the security violation
            await ClassmojiService.audit.create({
              classroom_id: attempt.quiz.classroom_id,
              user_id: userId.toString(),
              role: 'STUDENT',
              resource_id: data.attemptId,
              resource_type: 'QUIZ_ATTEMPT_COMPLETE_UNAUTHORIZED',
              action: 'ACCESS_DENIED',
              data: {
                unauthorized_access: true,
                attempted_attempt_id: data.attemptId,
                owner_user_id: attempt.user_id.toString(),
                attempted_action: 'completeQuiz',
              },
            });

            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const metrics = extractDurationMetrics(data);

          // Complete the attempt after ownership verification
          await ClassmojiService.quizAttempt.completeAttempt(data.attemptId, metrics);

          // Cleanup via ai-agent service
          await endQuizSession(data.attemptId);

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error: unknown) {
          console.error('[completeQuiz] Error:', error);
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

          if (attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // CRITICAL: Reject updates for already-completed attempts
          if (attempt.completed_at) {
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

          if (attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
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

          if (attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
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
          // changes — no session is ended and no attempt is created.
          const refusal = await sourceMaterialRefusal(context.quiz);
          if (refusal) return refusal;

          // Cleanup via ai-agent service BEFORE creating new attempt.
          // The attempt created below is the caller's own, so the only session
          // worth ending is the caller's own attempt on this same quiz. An id
          // that fails either half is skipped rather than refused: the restart
          // still proceeds, and a foreign id is answered exactly like one that
          // names nothing, so it reports nothing about what exists.
          //
          // The trade-off is that an id whose row is already gone — a preview
          // attempt deleted between page load and the restart click — no longer
          // gets its best-effort teardown, so its ai-agent session can outlive
          // the row until that session's own expiry.
          const previousAttempt = context.attempt;
          const isCallersAttemptOnThisQuiz =
            !!previousAttempt &&
            previousAttempt.quiz_id.toString() === data.quizId.toString() &&
            (previousAttempt.user_id.toString() === userId.toString() || isImpersonating);

          if (isCallersAttemptOnThisQuiz) {
            await endQuizSession(data.attemptId);
          }

          // Create a new attempt using the service
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

          // If repoName provided (instructor preview), save to agent_config immediately
          // This ensures it's available when QuizAttemptInterface auto-starts the quiz
          if (data.repoName) {
            await ClassmojiService.quizAttempt.updateAgentConfig(result.attemptId!, {
              instructorRepoName: data.repoName,
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
