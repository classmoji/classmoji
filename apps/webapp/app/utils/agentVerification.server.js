/**
 * Unified session verification via ai-agent service
 *
 * IMPORTANT: This is the ONLY way webapp should verify session ownership.
 * Webapp should NOT query the database directly for session ownership.
 *
 * Architecture:
 * 1. Webapp authenticates user via BetterAuth session (getAuthSession)
 * 2. Webapp asks ai-agent to verify session ownership (this module)
 * 3. ai-agent checks memory first, then database fallback
 * 4. Webapp trusts ai-agent's response for SSE authorization
 *
 * Benefits:
 * - ai-agent is single source of truth for session state
 * - Supports crash recovery (ai-agent checks DB if memory is empty)
 * - Webapp stays stateless
 */

import { io } from 'socket.io-client';
import crypto from 'crypto';
import { signPayload } from './agentAuth.server';

// Singleton socket connection for verification requests
let verificationSocket = null;
let connectionPromise = null;

/**
 * Get or create a socket connection for verification
 */
function getVerificationConnection() {
  if (verificationSocket?.connected) {
    return Promise.resolve(verificationSocket);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    const AI_AGENT_URL = process.env.AI_AGENT_URL;
    if (!AI_AGENT_URL) {
      connectionPromise = null;
      reject(new Error('AI agent is not configured (AI_AGENT_URL not set)'));
      return;
    }

    console.log('[agentVerification] Connecting to ai-agent:', AI_AGENT_URL);

    verificationSocket = io(AI_AGENT_URL, {
      transports: ['websocket', 'polling'],
      timeout: 5000,
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 500,
    });

    const connectTimeout = setTimeout(() => {
      connectionPromise = null;
      reject(new Error('Verification connection timeout'));
    }, 5000);

    verificationSocket.once('connect', () => {
      clearTimeout(connectTimeout);
      console.log('[agentVerification] Connected to ai-agent');
      connectionPromise = null;
      resolve(verificationSocket);
    });

    verificationSocket.once('connect_error', error => {
      clearTimeout(connectTimeout);
      connectionPromise = null;
      console.error('[agentVerification] Connection failed:', error.message);
      reject(error);
    });
  });

  return connectionPromise;
}

/**
 * Agent types for session verification
 */
export const AgentType = {
  QUIZ: 'QUIZ',
  PROMPT_ASSISTANT: 'PROMPT_ASSISTANT',
  SYLLABUS_BOT: 'SYLLABUS_BOT',
};

/**
 * Verify session ownership via ai-agent
 *
 * @param {Object} options - Verification options
 * @param {string} options.sessionId - The session/attempt ID to verify
 * @param {string} options.agentType - One of AgentType values
 * @param {string} options.userId - The user ID to check ownership against
 * @returns {Promise<{ valid: boolean, sessionStatus: string | null, error?: string }>}
 */
export async function verifySessionOwnership({ sessionId, agentType, userId }) {
  const requestId = crypto.randomUUID();

  return new Promise(async (resolve, reject) => {
    let socket;
    let settled = false;
    let timeout;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket) {
        socket.off('message', handler);
        socket.off('disconnect', disconnectHandler);
      }
    };

    const handler = message => {
      // Filter by requestId for proper correlation
      if (message.type === 'SESSION_VERIFIED' && message.requestId === requestId) {
        cleanup();
        resolve(message.payload);
      }
    };

    const disconnectHandler = () => {
      cleanup();
      reject(new Error('Socket disconnected during verification'));
    };

    try {
      socket = await getVerificationConnection();

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Session verification timeout'));
      }, 5000);

      socket.on('message', handler);
      socket.once('disconnect', disconnectHandler);

      // Sign the payload for service authentication
      const signedPayload = signPayload({
        sessionId,
        agentType,
        userId: userId?.toString(),
      });

      socket.emit('message', {
        type: 'VERIFY_SESSION',
        requestId,
        payload: signedPayload,
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Close the verification socket connection (for cleanup/testing)
 */
export function closeVerificationConnection() {
  if (verificationSocket) {
    console.log('[agentVerification] Closing connection');
    verificationSocket.disconnect();
    verificationSocket = null;
    connectionPromise = null;
  }
}

// Clean up on process exit
process.on('SIGINT', closeVerificationConnection);
process.on('SIGTERM', closeVerificationConnection);

// Vite HMR: Remove listeners before module reload to prevent duplicates
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    process.off('SIGINT', closeVerificationConnection);
    process.off('SIGTERM', closeVerificationConnection);
  });
}
