/**
 * SSE endpoint for streaming syllabus bot messages in real-time
 * Frontend connects to /api/syllabus-bot/stream/:conversationId
 *
 * Security Architecture:
 * 1. Authenticate user via BetterAuth session (getAuthSession)
 * 2. Bind the conversation to this caller and re-check their CURRENT membership
 *    of the conversation's classroom (plan P1-3, review finding 3)
 * 3. Verify session ownership via ai-agent
 * 4. Stream events from agentStreamManager
 *
 * Step 2 reads the conversation row directly. The route's original "thin auth
 * layer, never query the DB" note no longer holds and has not for a while — the
 * Pro gate below already resolves the conversation's classroom through Prisma —
 * and it cannot hold here: a membership that ended after the conversation
 * started must stop the stream, and ai-agent's ownership check answers only
 * "did this user open it", which stays true forever.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getAuthSession, assertClassroomAccess } from '@classmoji/auth/server';
import { verifySessionOwnership, AgentType } from '~/utils/agentVerification.server';
import agentStreamManager from '~/utils/agentStreamManager';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';

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

  // 2. Bind the conversation to this caller, and re-check membership on EVERY
  //    (re)subscribe. Ownership alone is not enough: it is a fact about who
  //    opened the conversation and never changes, so a member removed from the
  //    classroom mid-conversation would otherwise keep an open stream usable.
  //    One scoped query, so "no such conversation" and "not yours" are the same
  //    answer and the id space cannot be probed.
  const conversation = await getPrisma().aIConversation.findFirst({
    where: { id: conversationId, user_id: authData.userId, type: 'SYLLABUS_BOT' },
    select: { classroom_id: true },
  });
  if (!conversation) {
    console.warn(
      `[syllabus-bot-stream] Forbidden access: User ${authData.userId} tried to access conversation ${conversationId}`
    );
    return new Response('Forbidden', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Throws a 401/403 Response, which React Router serves as-is. Deliberately
  // OUTSIDE the try below, whose catch turns everything into a 500/503 — a
  // refusal must not be reported to the client as an ai-agent outage.
  // Addressed by classroom id, so the membership checked is the one that owns
  // this conversation rather than whatever classroom the caller is browsing.
  await assertClassroomAccess({
    request,
    classroomId: conversation.classroom_id,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'SYLLABUS_BOT',
    attemptedAction: 'stream_subscribe',
  });

  // 3. Verify session ownership via ai-agent
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

    // 3b. Pro gate. Ownership alone isn't enough — a conversation opened while
    // the classroom was Pro must not keep streaming after the plan lapses.
    const entitlement =
      await ClassmojiService.entitlement.canUseSyllabusBotForConversation(conversationId);
    if (!entitlement.allowed) {
      console.warn(
        `[syllabus-bot-stream] Pro required for conversation ${conversationId} (user ${authData.userId})`
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

  // 4. Create SSE stream
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
      unsubscribe = agentStreamManager.subscribeToSession(
        conversationId,
        (event: { type: string; data: unknown }) => {
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
        }
      );

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
