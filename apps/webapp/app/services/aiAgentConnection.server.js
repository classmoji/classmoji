/**
 * Singleton WebSocket connection manager for ai-agent service
 * Maintains a single persistent connection that's reused across all AI operations
 *
 * SECURITY FEATURES:
 * - requestId for correlation (prevents cross-request message mixing)
 * - HMAC signing for service-to-service authentication
 *
 * USAGE:
 * All agent types (quiz, syllabus bot, prompt assistant) use sendRequest directly:
 *
 *   import { sendRequest } from '~/services/aiAgentConnection.server';
 *
 *   // Initialize session
 *   const result = await sendRequest('AGENT_TYPE_INIT', payload, {
 *     timeout: 60000,
 *     responseTypes: ['AGENT_TYPE_READY'],
 *     onStreamData: step => handleStep(step),
 *   });
 *
 *   // Send message
 *   const response = await sendRequest('AGENT_TYPE_MESSAGE', { id, content }, {
 *     timeout: 120000,
 *     responseTypes: ['AGENT_TYPE_RESPONSE'],
 *   });
 *
 *   // End session (fire-and-forget)
 *   await sendRequest('AGENT_TYPE_END', { id }, {
 *     timeout: 5000,
 *     responseTypes: [],
 *   });
 */

import { io } from 'socket.io-client';
import crypto from 'crypto';
import { signPayload } from '~/utils/agentAuth.server';

let socket = null;
let connectionPromise = null;

/**
 * Get or create a singleton socket connection
 */
function getConnection() {
  // Return existing connected socket
  if (socket?.connected) {
    return Promise.resolve(socket);
  }

  // Return pending connection if one is in progress
  if (connectionPromise) {
    return connectionPromise;
  }

  // Create new connection
  connectionPromise = new Promise((resolve, reject) => {
    const AI_AGENT_URL = process.env.AI_AGENT_URL;
    if (!AI_AGENT_URL) {
      connectionPromise = null;
      reject(new Error('AI agent is not configured (AI_AGENT_URL not set)'));
      return;
    }

    socket = io(AI_AGENT_URL, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    const connectTimeout = setTimeout(() => {
      connectionPromise = null;
      reject(new Error('Connection timeout'));
    }, 10000);

    socket.once('connect', () => {
      clearTimeout(connectTimeout);
      connectionPromise = null;
      resolve(socket);
    });

    socket.once('connect_error', error => {
      clearTimeout(connectTimeout);
      connectionPromise = null;
      console.error('[AIAgent] Connection failed:', error);
      reject(error);
    });
  });

  return connectionPromise;
}

/**
 * Send a message and wait for specific response types.
 *
 * SECURITY: Uses requestId for correlation to prevent cross-request message mixing.
 * Messages are filtered by BOTH type AND requestId/sessionId.
 *
 * @param {string} type - Message type (e.g., 'QUIZ_INIT', 'SYLLABUS_BOT_MESSAGE')
 * @param {Object} payload - Message payload (must include session identifier)
 * @param {Object} options - Request options
 * @param {number} [options.timeout=30000] - Request timeout in ms
 * @param {string[]} [options.responseTypes=[]] - Expected response type(s) to wait for
 * @param {Function} [options.onStreamData] - Callback for streaming data (exploration steps)
 * @param {Function} [options.onWelcomeMessage] - Callback for welcome messages (quiz-specific)
 * @returns {Promise<{type: string, payload: Object}>}
 */
export async function sendRequest(type, payload, options = {}) {
  const { timeout = 30000, responseTypes = [], onStreamData = null, onWelcomeMessage = null } = options;

  const socket = await getConnection();

  // Generate unique request ID for correlation
  const requestId = crypto.randomUUID();
  // Extract sessionId from payload for backwards compatibility filtering
  // Support attemptId (quizzes), sessionId (prompt assistant), and conversationId (syllabus bot)
  const sessionId = payload?.sessionId || payload?.attemptId || payload?.conversationId;

  return new Promise((resolve, reject) => {
    const explorationSteps = [];
    let timeoutHandle;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      socket.off('message', messageHandler);
    };

    // Create a unique handler for this request
    const messageHandler = msg => {
      // SECURITY: Filter by requestId (primary) or sessionId (fallback for legacy)
      // This prevents receiving another user's response
      const matchesRequest = msg.requestId === requestId;
      const matchesSession =
        sessionId &&
        (msg.payload?.sessionId === sessionId ||
          msg.payload?.attemptId === sessionId ||
          msg.payload?.conversationId === sessionId);

      // For streaming events (EXPLORATION_STEP), match by session
      if (msg.type === 'EXPLORATION_STEP' && matchesSession) {
        explorationSteps.push(msg.payload.step);
        if (onStreamData) {
          onStreamData(msg.payload.step);
        }
        return; // Don't resolve yet, keep listening
      }

      // For welcome messages (emitted before QUIZ_READY), match by session
      if (msg.type === 'WELCOME_MESSAGE' && matchesSession) {
        if (onWelcomeMessage) {
          onWelcomeMessage(msg.payload);
        }
        return; // Don't resolve yet, keep listening for QUIZ_READY
      }

      // For session recovery events, match by session
      if (msg.type === 'SESSION_RECOVERED' && matchesSession) {
        return;
      }

      // For response types, require requestId match (or sessionId fallback)
      if (responseTypes.includes(msg.type)) {
        if (!matchesRequest && !matchesSession) {
          // This message is for a different request, ignore it
          return;
        }

        cleanup();

        // Resolve with response
        resolve({
          type: msg.type,
          payload: {
            ...msg.payload,
            explorationSteps,
          },
        });
        return;
      }

      // Handle errors - must match our request
      if (msg.type === 'ERROR' && (matchesRequest || matchesSession)) {
        cleanup();
        reject(new Error(msg.payload?.error || 'Request failed'));
        return;
      }
    };

    // Register message handler
    socket.on('message', messageHandler);

    // Set timeout
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Request timeout after ${timeout}ms for requestId: ${requestId}`));
    }, timeout);

    // Send the message with requestId for correlation and HMAC signature
    const signedPayload = signPayload(payload);
    socket.emit('message', {
      type,
      requestId, // Include for correlation
      payload: signedPayload,
    });

    // Special handling for fire-and-forget messages (no response expected)
    const fireAndForgetTypes = ['QUIZ_END', 'SYLLABUS_BOT_END', 'PROMPT_ASSISTANT_END'];
    if (fireAndForgetTypes.includes(type) && responseTypes.length === 0) {
      // Give it a moment to send, then resolve
      setTimeout(() => {
        cleanup();
        resolve({ type, payload: {} });
      }, 100);
    }
  });
}

/**
 * Gracefully close the connection (for cleanup)
 */
export function closeConnection() {
  if (socket) {
    socket.disconnect();
    socket = null;
    connectionPromise = null;
  }
}

// Clean up on process exit
process.on('SIGINT', closeConnection);
process.on('SIGTERM', closeConnection);

// Vite HMR: Remove listeners before module reload to prevent duplicates
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    process.off('SIGINT', closeConnection);
    process.off('SIGTERM', closeConnection);
  });
}
