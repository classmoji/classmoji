/**
 * Quiz API endpoint - handles all quiz-related actions
 *
 * SECURITY MEASURES:
 * 1. Authentication: All requests require valid userId from cookie
 * 2. Authorization: Users can only access their own quiz attempts
 * 3. Attempt Ownership Verification:
 *    - sendMessage: Verifies user owns the attempt before allowing messages
 *    - completeQuiz: Verifies user owns the attempt before marking complete
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
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { getQuestionProgressFromMessage, checkForCompletion } from '@classmoji/utils';

const extractDurationMetrics = payload => {
  if (!payload) return {};

  const sanitize = value => {
    if (value === undefined || value === null) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const rounded = Math.round(numeric);
    return rounded < 0 ? 0 : rounded;
  };

  const metrics = {};
  const total = sanitize(payload.totalDurationMs ?? payload.total_duration_ms);
  const unfocused = sanitize(payload.unfocusedDurationMs ?? payload.unfocused_duration_ms);

  if (total !== undefined) metrics.totalDurationMs = total;
  if (unfocused !== undefined) metrics.unfocusedDurationMs = unfocused;

  return metrics;
};

export async function action({ request }) {
  // Only handle POST requests
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Import server-only modules
  const { ClassmojiService } = await import('@classmoji/services');
  const { getInstallationToken } = await import('../student.$class.quizzes/helpers.server');
  const { initializeQuizViaAgent, sendMessageToAgent, endQuizSession } = await import(
    '../student.$class.quizzes/aiAgent.server'
  );
  try {
    const data = await request.json();

    const jsonResponse = (status, message) =>
      new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (!data?._action) {
      return jsonResponse(400, 'Invalid action');
    }

    const allowedRoles = ['STUDENT', 'ASSISTANT', 'OWNER'];

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

          const classroomSlug =
            quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            attemptData.attempt.quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(attemptData.attempt.quiz.classroom_id))
              .slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            attempt.quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(attempt.quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            attempt.quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(attempt.quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            attempt.quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(attempt.quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

          const classroomSlug =
            attempt.quiz.classroom?.slug ||
            (await ClassmojiService.classroom.findById(attempt.quiz.classroom_id)).slug;

          return {
            context: {
              classroomSlug,
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

    const access = await assertClassroomAccess({
      request,
      classroomSlug: context.classroomSlug,
      allowedRoles,
      resourceType: 'QUIZ_API_ACTION',
      attemptedAction: data._action,
      metadata: context.metadata,
    });

    // Check AI agent availability AFTER auth (preserves audit logging)
    if (!isAIAgentConfigured()) {
      return new Response(JSON.stringify({ error: 'AI features are not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { userId } = access;

    // Check if admin is impersonating a student (for "View As" feature)
    // Impersonating admins can interact with quiz attempts on behalf of students
    const { getAuthSession } = await import('@classmoji/auth/server');
    const authData = await getAuthSession(request);
    const isImpersonating = !!authData?.session?.session?.impersonatedBy;

    switch (data._action) {
      case 'startQuiz': {
        try {
          // If attemptId is provided, use it (for resuming specific attempts)
          // Otherwise create a new attempt respecting max_attempts
          let attempt;

          if (data.attemptId) {
            // Resume specific attempt (e.g., admin preview with pre-created attempt)
            const attemptData = await ClassmojiService.quizAttempt.findWithMessages(data.attemptId);
            if (!attemptData?.attempt) {
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
            // Create new attempt with max_attempts validation
            const result = await ClassmojiService.quizAttempt.createNew(
              data.quizId,
              userId,
              access.membership
            );

            if (!result.success) {
              return new Response(JSON.stringify(result), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            // Fetch the full attempt with quiz data
            const attemptData = await ClassmojiService.quizAttempt.findWithMessages(result.attemptId);
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

          // Check if this is a code-aware quiz (linked to a module with code context enabled)
          if (attempt.quiz.module_id && attempt.quiz.include_code_context) {

            // Process in background to allow SSE connection
            // Note: ai-agent now handles welcome message generation and publishing
            setTimeout(async () => {
              try {
                // Check if user is an instructor (OWNER or ASSISTANT)
                const isInstructor = ['OWNER', 'ASSISTANT', 'TEACHER'].includes(access.membership?.role);

                let repoName;

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
                  if (freshAttempt?.agent_config?.instructorRepoName) {
                    repoName = freshAttempt.agent_config.instructorRepoName;
                  } else {
                    // Instructor didn't select a repo for code-aware quiz
                    throw new Error('Please select a repository to test with.');
                  }
                } else {
                  // Standard flow: find student's repo
                  const repo = await ClassmojiService.repository.findByStudent(
                    attempt.quiz.module_id,
                    userId
                  );
                  if (!repo) {
                    throw new Error('No repository found for this module.');
                  }
                  repoName = repo.name;
                }

                // Prefer user's ghu_ token (per-user rate limits) with installation token fallback
                // ai-agent validates the token with GitHub before use, falls back if invalid
                const gitOrganization = attempt.quiz.classroom.git_organization;
                const userToken = authData?.token;
                const accessToken = userToken || await getInstallationToken(gitOrganization);

                // Load classroom settings for LLM configuration
                const classroomSettings = attempt.quiz.classroom?.settings;

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
                  },
                  // Code-aware options
                  {
                    orgLogin: gitOrganization.login,
                    repoName,
                    accessToken,
                  }
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
              } catch (error) {
                console.error('[startQuiz] Quiz-agent initialization failed:', error);

                // Fallback to standard LLM
                const fallbackMessage = error?.message?.includes('No repository found')
                  ? `Welcome to your quiz! This assignment doesn't have a linked repository. Let's discuss the concepts. Ready to begin?`
                  : `Welcome! I'm having trouble accessing your code right now, but we can still proceed. Let's discuss the concepts. Ready to begin?`;

                await ClassmojiService.aiConversation.addMessage(attempt.id, 'ASSISTANT', fallbackMessage, true);
                await ClassmojiService.quizAttempt.incrementQuestionsAsked(attempt.id);
              }
            }, 100); // Small delay to allow response to return first

            // Return attemptId immediately — background task saves messages to DB,
            // frontend picks them up via polling (revalidation)
            return new Response(JSON.stringify({ attemptId: attempt.id }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } else {
            // Standard quiz without code context - use ai-agent service
            // Return attemptId immediately — frontend polls DB for new messages
            const responsePromise = new Response(JSON.stringify({ attemptId: attempt.id }), {
              headers: { 'Content-Type': 'application/json' },
            });

            // Generate first question in background via ai-agent
            // Note: ai-agent now handles welcome message generation and publishing
            setTimeout(async () => {
              try {
                // Load classroom settings for LLM configuration
                const classroomSettings = attempt.quiz.classroom?.settings;

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
                  }
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
                const fallbackQuestion = `Let's begin with your first question. Can you tell me about your understanding of the key concepts we'll be covering today?`;

                await ClassmojiService.aiConversation.addMessage(attempt.id, 'ASSISTANT', fallbackQuestion, true);
                await ClassmojiService.quizAttempt.incrementQuestionsAsked(attempt.id);
              }
            }, 100); // Small delay to allow response to return first

            return responsePromise;
          }
        } catch (error) {
          console.error('Error starting quiz:', error);
          throw error;
        }
      }

      case 'sendMessage': {
        try {
          // SECURITY: Verify the user owns this attempt before allowing message
          const attemptData = context.attemptData;

          if (!attemptData.attempt || !attemptData.attempt.quiz) {
            throw new Error('Attempt or quiz data not found');
          }

          // SECURITY CHECK: Verify the authenticated user owns this quiz attempt
          // Allow if admin is impersonating (View As feature)
          if (attemptData.attempt.user_id.toString() !== userId.toString() && !isImpersonating) {
            console.error(
              `[sendMessage] Security violation: User ${userId} tried to send message to attempt ${data.attemptId} owned by ${attemptData.attempt.user_id}`
            );

            // Log the security violation
            await ClassmojiService.audit.create({
              classroom_id: attemptData.attempt.quiz.classroom_id,
              user_id: userId.toString(),
              role: 'STUDENT',
              resource_id: data.attemptId,
              resource_type: 'QUIZ_ATTEMPT_MESSAGE_UNAUTHORIZED',
              action: 'ACCESS_DENIED',
              data: {
                unauthorized_access: true,
                attempted_attempt_id: data.attemptId,
                owner_user_id: attemptData.attempt.user_id.toString(),
                attempted_action: 'sendMessage',
              },
            });

            return new Response(JSON.stringify({ error: 'Forbidden' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Note: ai-agent saves user message via conversationStorage in handleStudentMessage
          // No need to save here - avoiding duplicate writes

          let aiResponse;

          try {
            // Send message via WebSocket to ai-agent service
            // Both standard and code-aware quizzes use the same unified path
            // ai-agent saves all messages (user, exploration steps, response) to DB
            const result = await sendMessageToAgent(
              data.attemptId,
              data.content
            );

            aiResponse = result.content;
          } catch (agentError) {
            console.error('[sendMessage] Quiz-agent failed:', agentError);

            let friendlyError;

            if (agentError.message?.includes('timeout')) {
              // Timeout waiting for ai-agent (likely AI API slow/overloaded)
              friendlyError =
                `The AI API appears to be slow or overloaded right now. ` +
                `This is on their end, not ours! Please wait a moment and try again—your quiz progress is saved.`;
            } else {
              // ai-agent returned an error message - use it directly if available
              friendlyError = agentError.message ||
                `I'm having trouble right now. Please try again—your quiz progress is saved.`;
            }

            aiResponse = friendlyError;

            await ClassmojiService.aiConversation.addMessage(data.attemptId, 'ASSISTANT', aiResponse, false, {
              errorType: 'AGENT_FAILURE',
              errorMessage: agentError?.message,
            });

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
          const currentQuestionsAsked = attemptData.questionsAsked || 0;
          const hasQuestion = Boolean(questionProgress);
          const isNewQuestion =
            hasQuestion && questionProgress.questionNumber > currentQuestionsAsked;

          const completionData = checkForCompletion(aiResponse);

          // Ensure interactive buttons are present when agent forgets to include them
          if (!aiResponse.includes('[BUTTON:') && !completionData && !hasQuestion) {
            aiResponse = `${aiResponse.trim()}\n\n[BUTTON:TRY_AGAIN] [BUTTON:NEXT]`;
          }

          // Note: ai-agent already saved assistant response and questions_asked via conversationStorage
          // ai-agent sets absolute value, so no increment needed here

          const updatedQuestionsAsked = isNewQuestion
            ? questionProgress.questionNumber
            : currentQuestionsAsked;

          // Check for quiz completion
          const newQuestionsAsked = Math.max(
            updatedQuestionsAsked,
            questionProgress?.questionNumber || 0
          );
          if (newQuestionsAsked >= (attemptData.questionCount || 5)) {
            const completion = completionData || checkForCompletion(aiResponse);
            if (completion) {
              await ClassmojiService.quizAttempt.completeAttempt(data.attemptId);
            }
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[sendMessage] Error:', error);

          const friendlyError = `I'm having trouble closing out your quiz right now. Please wait a moment and tap "Next" again, or refresh the page if it persists—your progress is already saved.`;

          await ClassmojiService.aiConversation.addMessage(data.attemptId, 'ASSISTANT', friendlyError, false, {
            errorType: 'GENERAL_FAILURE',
          });

          return new Response(JSON.stringify({ success: false, error: friendlyError }), {
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
        } catch (error) {
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
          const result = await ClassmojiService.quizAttempt.updateDurations(data.attemptId, metrics);

          return new Response(JSON.stringify({ success: true, updated: result }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.log(error);
          // If error is about record not found, treat it as success (attempt was deleted)
          if (error.message?.includes('Record to update not found')) {
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
        } catch (error) {
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

          const result = await ClassmojiService.quizAttempt.calculateAndApplyModalGap(data.attemptId);

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
        } catch (error) {
          console.error('[recordModalOpen] Error:', error);
          throw error;
        }
      }

      case 'restartQuiz': {
        try {
          // Cleanup via ai-agent service BEFORE creating new attempt
          if (data.attemptId) {
            await endQuizSession(data.attemptId);
          }

          // Create a new attempt using the service
          const result = await ClassmojiService.quizAttempt.createNew(
            data.quizId,
            userId,
            access.membership
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
            await ClassmojiService.quizAttempt.updateAgentConfig(result.attemptId, {
              instructorRepoName: data.repoName,
            });
          }

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('[restartQuiz] Error:', error);
          return new Response(JSON.stringify({ success: false, message: error.message }), {
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
  } catch (error) {
    console.error('API Quiz action error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
