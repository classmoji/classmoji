/**
 * SSE endpoint for streaming prompt assistant responses in real-time
 * Frontend connects to /api/quiz/prompt-assistant/stream/:sessionId
 *
 * Security Architecture:
 * 1. Authenticate user via cookie
 * 2. Verify session ownership via ai-agent (verifySessionOwnership)
 * 3. Falls back to in-memory session check (graceful degradation)
 * 4. Stream events from agentStreamManager
 *
 * Access: Requires authenticated instructor with org access
 */

import { assertClassroomAccess } from '~/utils/helpers';
import { verifySessionOwnership, AgentType } from '~/utils/agentVerification.server';
import agentStreamManager from '~/utils/agentStreamManager';

export async function loader({ params, request }) {
  const { sessionId } = params;

  // Look up session ownership for authorization (in-memory fallback)
  const sessionOwnership = agentStreamManager.getSessionOwnership(sessionId);

  // 1. Verify session ownership via ai-agent first (single source of truth)
  try {
    // Get user from org access check (will authenticate via cookie)
    const url = new URL(request.url);
    const classroomSlug = sessionOwnership?.classroomSlug || url.searchParams.get('org');

    if (!classroomSlug) {
      console.warn(`[prompt-assistant-stream] Session not found and no org provided: ${sessionId}`);
      return new Response('Session not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Verify user has access to the classroom
    const { userId } = await assertClassroomAccess({
      request,
      classroomSlug,
      allowedRoles: ['OWNER', 'ASSISTANT'],
      resourceType: 'PROMPT_ASSISTANT_STREAM',
      attemptedAction: 'subscribe',
    });

    // Try ai-agent verification
    const verification = await verifySessionOwnership({
      sessionId,
      agentType: AgentType.PROMPT_ASSISTANT,
      userId: userId.toString(),
    });

    if (!verification.valid) {
      // If ai-agent says invalid but we have in-memory ownership, check that
      if (sessionOwnership && sessionOwnership.userId === userId.toString()) {
        console.log(`[prompt-assistant-stream] ai-agent verification failed but in-memory ownership valid`);
      } else {
        console.warn(
          `[prompt-assistant-stream] Forbidden access: User ${userId} tried to access session ${sessionId}`
        );
        return new Response('Forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    console.log(
      `[prompt-assistant-stream] Authorized client connected for session ${sessionId} (classroom: ${classroomSlug})`
    );
  } catch (error) {
    // If verification fails, fall back to in-memory check
    if (error.message?.includes('timeout') || error.message?.includes('disconnect')) {
      console.warn(`[prompt-assistant-stream] ai-agent verification failed, using in-memory fallback`);

      if (!sessionOwnership) {
        console.warn(`[prompt-assistant-stream] Session not found: ${sessionId}`);
        return new Response('Session not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // Verify the requester has access to the classroom that owns this session
      try {
        await assertClassroomAccess({
          request,
          classroomSlug: sessionOwnership.classroomSlug,
          allowedRoles: ['OWNER', 'ASSISTANT'],
          resourceType: 'PROMPT_ASSISTANT_STREAM',
          attemptedAction: 'subscribe',
        });
      } catch (orgError) {
        console.warn(
          `[prompt-assistant-stream] Unauthorized access attempt for session ${sessionId}:`,
          orgError.message
        );
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      console.log(
        `[prompt-assistant-stream] Client connected for session ${sessionId} via in-memory fallback`
      );
    } else if (error.status === 401 || error.status === 403) {
      // Auth error from assertClassroomAccess
      console.warn(
        `[prompt-assistant-stream] Unauthorized access attempt for session ${sessionId}:`,
        error.message
      );
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    } else {
      console.error(`[prompt-assistant-stream] Verification error:`, error);
      return new Response('Internal server error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  // 2. Create SSE stream
  // CRITICAL: unsubscribe must be accessible from cancel() to prevent memory leaks
  let unsubscribe = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = event => {
        // Map internal event types to client-friendly names
        const mappedEvent = {
          ...event,
          type: mapEventType(event.type),
        };

        const data = `event: ${mappedEvent.type}\ndata: ${JSON.stringify(mappedEvent.data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch (error) {
          // Stream closed, ignore
          console.log(error);
        }
      };

      // Send initial connection confirmation
      sendEvent({
        type: 'connected',
        data: { sessionId, timestamp: Date.now() },
      });

      // Subscribe to events for this session (using unified method)
      unsubscribe = agentStreamManager.subscribeToSession(sessionId, event => {
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
              console.log(`[prompt-assistant-stream] Cleaned up listener for session ${sessionId}`);
            }
          }, 100);
        }
      });

      console.log(`[prompt-assistant-stream] Subscribed to session ${sessionId}`);
    },

    cancel() {
      // CRITICAL: Must unsubscribe to prevent memory leaks
      if (unsubscribe) {
        unsubscribe();
        console.log(`[prompt-assistant-stream] Client disconnected, cleaned up listener for session ${sessionId}`);
      } else {
        console.log(`[prompt-assistant-stream] Client disconnected for session ${sessionId}`);
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

/**
 * Map internal event types to client-friendly names
 */
function mapEventType(type) {
  switch (type) {
    case 'message_ready':
      return 'assistant_response';
    default:
      return type;
  }
}
