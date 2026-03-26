/**
 * SSE endpoint for streaming syllabus bot messages in real-time
 * Frontend connects to /api/syllabus-bot/stream/:conversationId
 *
 * Security Architecture:
 * 1. Authenticate user via BetterAuth session (getAuthSession)
 * 2. Verify session ownership via ai-agent (NOT direct DB query)
 * 3. Stream events from agentStreamManager
 *
 * This follows the "webapp as thin auth layer" pattern where ai-agent
 * is the single source of truth for session ownership.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getAuthSession } from '@classmoji/auth/server';
import { verifySessionOwnership, AgentType } from '~/utils/agentVerification.server';
import agentStreamManager from '~/utils/agentStreamManager';

export async function loader({ params, request }: LoaderFunctionArgs) {
  const conversationId = params.conversationId!;

  // 1. Authenticate user via BetterAuth session
  const authData = await getAuthSession(request);
  if (!authData) {
    console.warn(
      `[syllabus-bot-stream] Unauthorized access attempt for conversation ${conversationId}`
    );
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // 2. Verify session ownership via ai-agent (NOT direct DB query)
  try {
    const verification = await verifySessionOwnership({
      sessionId: conversationId,
      agentType: AgentType.SYLLABUS_BOT,
      userId: authData.userId.toString(),
    });

    if (!(verification as { valid: boolean }).valid) {
      console.warn(
        `[syllabus-bot-stream] Forbidden access: User ${authData.userId} tried to access conversation ${conversationId}`
      );
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Log session status for debugging
    if ((verification as { sessionStatus?: string }).sessionStatus === 'recoverable') {
      console.log(`[syllabus-bot-stream] Session ${conversationId} is recoverable from DB`);
    }
  } catch (error: unknown) {
    console.error(`[syllabus-bot-stream] Verification failed for ${conversationId}:`, error);

    // Return 503 if ai-agent is unavailable (client can retry)
    const errMessage = error instanceof Error ? error.message : '';
    if (errMessage.includes('timeout') || errMessage.includes('disconnect')) {
      return new Response('Service unavailable', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain',
          'Retry-After': '5',
        },
      });
    }

    return new Response('Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  console.log(
    `[syllabus-bot-stream] Authorized client connected for conversation ${conversationId} by user ${authData.userId}`
  );

  // 3. Create SSE stream
  // CRITICAL: unsubscribe must be accessible from cancel() to prevent memory leaks
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event: { type: string; data: unknown }) => {
        const data = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch (enqueueError: unknown) {
          // Stream closed, ignore
          console.log(enqueueError);
        }
      };

      // Send initial connection confirmation
      sendEvent({
        type: 'connected',
        data: { conversationId, timestamp: Date.now() },
      });

      // Subscribe to events for this conversation
      unsubscribe = agentStreamManager.subscribeToSession(conversationId, (event: { type: string; data: unknown }) => {
        sendEvent(event);

        // Close stream when done
        if (event.type === 'done' || event.type === 'error') {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // Already closed
            }
            if (unsubscribe) {
              unsubscribe();
              console.log(
                `[syllabus-bot-stream] Cleaned up listener for conversation ${conversationId}`
              );
            }
          }, 100);
        }
      });

      console.log(`[syllabus-bot-stream] Subscribed to conversation ${conversationId}`);
    },

    cancel() {
      // CRITICAL: Must unsubscribe to prevent memory leaks
      if (unsubscribe) {
        unsubscribe();
        console.log(
          `[syllabus-bot-stream] Client disconnected, cleaned up listener for conversation ${conversationId}`
        );
      } else {
        console.log(`[syllabus-bot-stream] Client disconnected for conversation ${conversationId}`);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
