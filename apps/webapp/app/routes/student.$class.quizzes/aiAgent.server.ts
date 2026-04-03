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
interface CodeAwareOptions {
  orgLogin: string;
  repoName: string;
  accessToken: string;
}

interface QuizCallbacks {
  onExplorationStep?: ((step: unknown) => void) | null;
  onWelcomeMessage?: ((msg: unknown) => void) | null;
}

interface AgentResponse {
  payload: Record<string, unknown>;
}

export async function initializeQuizViaAgent(
  attemptId: string,
  quizConfig: Record<string, unknown>,
  codeAwareOptions: CodeAwareOptions | null = null,
  callbacks: QuizCallbacks = {}
) {
  const { onExplorationStep = null, onWelcomeMessage = null } = callbacks || {};
  const _isCodeAware = !!codeAwareOptions;

  try {
    const payload: Record<string, unknown> = {
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

    const agentResponse = response as AgentResponse;
    return {
      openingMessage: agentResponse.payload.openingMessage as string,
      explorationSteps: (agentResponse.payload.explorationSteps as unknown[]) || [],
      codebasePath: agentResponse.payload.codebasePath as string,
    };
  } catch (error: unknown) {
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
export async function sendMessageToAgent(
  attemptId: string,
  content: string,
  messageId: string | null = null,
  onExplorationStep: ((step: unknown) => void) | null = null
) {
  try {
    const response = await sendRequest(
      'STUDENT_MESSAGE',
      {
        attemptId,
        content,
        messageId,
      },
      {
        timeout: MESSAGE_TIMEOUT,
        responseTypes: ['AGENT_RESPONSE'],
        onStreamData: onExplorationStep,
      }
    );

    const agentResponse = response as AgentResponse;
    return {
      content: agentResponse.payload.content as string,
      explorationSteps: (agentResponse.payload.explorationSteps as unknown[]) || [],
    };
  } catch (error: unknown) {
    console.error('[sendMessageToAgent] Error:', error);
    throw error;
  }
}

/**
 * End quiz session and cleanup
 */
export async function endQuizSession(attemptId: string) {
  try {
    // For cleanup, we don't need to wait for response
    await sendRequest(
      'QUIZ_END',
      {
        attemptId,
      },
      {
        timeout: 5000,
        responseTypes: [], // Don't wait for response
      }
    );
  } catch (error: unknown) {
    // Cleanup is best-effort, don't throw
    console.log(error);
  }
}
