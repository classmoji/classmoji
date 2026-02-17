/**
 * SSE Endpoint for Slide Import Progress
 *
 * Streams real-time import progress events to the client.
 * Client connects after starting an import to receive live updates:
 *   - step events: { type: 'step', step: 'processing_images', current: 5, total: 20 }
 *   - done event: { type: 'done', slideId: 'abc123' }
 *   - error event: { type: 'error', message: 'Upload failed' }
 *
 * Security:
 * - Requires authentication via BetterAuth
 * - Uses random UUID importId (not guessable)
 * - Short-lived streams (cleanup after completion)
 */

import { getAuthSession } from '@classmoji/auth/server';
import { importStreamManager } from '~/utils/importStreamManager';

export async function loader({ params, request }) {
  const { importId } = params;

  // Validate importId is a UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!importId || !uuidRegex.test(importId)) {
    return new Response('Invalid import ID', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Authenticate user (basic auth check)
  const authData = await getAuthSession(request);
  if (!authData) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Create SSE stream
  // Store unsubscribe function for cleanup on disconnect
  let unsubscribe = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const sendEvent = (event) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed, ignore
        }
      };

      // Send initial connection confirmation
      sendEvent({
        type: 'connected',
        importId,
        timestamp: Date.now(),
      });

      // Subscribe to import progress events
      // importStreamManager replays buffered events for late-connecting clients
      unsubscribe = importStreamManager.subscribe(importId, (event) => {
        sendEvent(event);

        // Close stream when import completes or errors
        if (event.type === 'done' || event.type === 'error') {
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              // Already closed
            }
            if (unsubscribe) {
              unsubscribe();
            }
          }, 100);
        }
      });
    },

    cancel() {
      // Client disconnected - clean up subscription to prevent memory leaks
      if (unsubscribe) {
        unsubscribe();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
