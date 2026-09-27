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
 * @param {Object} options - Optional: { onExplorationStep, onWelcomeMessage, mcpToken }
 */
interface CodeAwareOptions {
  orgLogin: string;
  repoName: string;
  accessToken: string;
}

/**
 * The per-call MCP read token (quiz source material, Stage 2). Sent at the TOP
 * of the payload, never inside `quizConfig`: the ai-agent persists quizConfig
 * into the attempt's agent_config, and a token must never be stored. Never
 * logged here either.
 */
export interface QuizMcpToken {
  accessToken: string;
  /** ISO 8601, as Ask Moji sends it. */
  expiresAt: string;
}

interface QuizCallbacks {
  onExplorationStep?: ((step: unknown) => void) | null;
  onWelcomeMessage?: ((msg: unknown) => void) | null;
  /** Omitted when minting failed: the ai-agent then runs without verification. */
  mcpToken?: QuizMcpToken;
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
  const { onExplorationStep = null, onWelcomeMessage = null, mcpToken } = callbacks || {};
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

    if (mcpToken) payload.mcpToken = mcpToken;

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
 * @param {Object} options - Optional: { messageId, onExplorationStep, mcpToken }
 */
export async function sendMessageToAgent(
  attemptId: string,
  content: string,
  {
    messageId = null,
    onExplorationStep = null,
    mcpToken,
  }: {
    messageId?: string | null;
    onExplorationStep?: ((step: unknown) => void) | null;
    /** This turn's MCP read token; omitted when minting failed. */
    mcpToken?: QuizMcpToken;
  } = {}
) {
  try {
    const response = await sendRequest(
      'STUDENT_MESSAGE',
      {
        attemptId,
        content,
        messageId,
        ...(mcpToken ? { mcpToken } : {}),
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
