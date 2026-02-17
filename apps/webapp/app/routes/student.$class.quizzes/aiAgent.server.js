import { sendRequest } from '~/services/aiAgentConnection.server';

const INIT_TIMEOUT = 300000; // 5 min for cloning + exploration (code-aware can take 1-2+ min with slow API)
const MESSAGE_TIMEOUT = 300000; // 5 min for complex LLM responses + exploration tool calls

/**
 * Initialize a quiz session via WebSocket to ai-agent service.
 * Supports both standard and code-aware modes.
 *
 * @param {string} attemptId - Quiz attempt ID
 * @param {Object} quizConfig - Quiz configuration (systemPrompt, rubricPrompt, etc.)
 * @param {Object|null} codeAwareOptions - Optional: { orgLogin, repoName, accessToken }
 * @param {Object} callbacks - Optional callbacks: { onExplorationStep, onWelcomeMessage }
 */
export async function initializeQuizViaAgent(
  attemptId,
  quizConfig,
  codeAwareOptions = null,
  callbacks = {}
) {
  const { onExplorationStep = null, onWelcomeMessage = null } = callbacks || {};
  const isCodeAware = !!codeAwareOptions;

  try {
    const payload = {
      attemptId,
      quizConfig,
    };

    // Add code-aware options if provided
    if (codeAwareOptions) {
      payload.orgLogin = codeAwareOptions.orgLogin;
      payload.repoName = codeAwareOptions.repoName;
      payload.accessToken = codeAwareOptions.accessToken;
    }

    const response = await sendRequest('QUIZ_INIT', payload, {
      timeout: INIT_TIMEOUT,
      responseTypes: ['QUIZ_READY'],
      onStreamData: onExplorationStep,
      onWelcomeMessage,
    });

    return {
      openingMessage: response.payload.openingMessage,
      explorationSteps: response.payload.explorationSteps || [],
      codebasePath: response.payload.codebasePath,
    };
  } catch (error) {
    console.error('[initializeQuizViaAgent] Error:', error);
    throw error;
  }
}

/**
 * Send student message and get agent response via WebSocket.
 * Works for both standard and code-aware quiz sessions.
 *
 * @param {string} attemptId - Quiz attempt ID
 * @param {string} content - Student message content
 * @param {string|null} messageId - Optional message ID
 * @param {Function|null} onExplorationStep - Optional callback for real-time exploration steps
 */
export async function sendMessageToAgent(attemptId, content, messageId = null, onExplorationStep = null) {
  try {
    const response = await sendRequest('STUDENT_MESSAGE', {
      attemptId,
      content,
      messageId,
    }, {
      timeout: MESSAGE_TIMEOUT,
      responseTypes: ['AGENT_RESPONSE'],
      onStreamData: onExplorationStep,
    });

    return {
      content: response.payload.content,
      explorationSteps: response.payload.explorationSteps || [],
    };
  } catch (error) {
    console.error('[sendMessageToAgent] Error:', error);
    throw error;
  }
}

/**
 * End quiz session and cleanup
 */
export async function endQuizSession(attemptId) {
  try {
    // For cleanup, we don't need to wait for response
    await sendRequest('QUIZ_END', {
      attemptId,
    }, {
      timeout: 5000,
      responseTypes: [], // Don't wait for response
    });
  } catch (error) {
    // Cleanup is best-effort, don't throw
    console.log(error);
  }
}
