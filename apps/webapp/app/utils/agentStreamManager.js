/**
 * Unified stream manager for all AI agents
 * Handles pub/sub between ai-agent WebSocket events and SSE endpoints
 *
 * Supports:
 * - Quiz exploration steps and responses
 * - Prompt assistant responses and suggestions
 * - Syllabus bot messages and content references
 *
 * Features:
 * - Event buffering for late-connecting clients (replay)
 * - Session ownership tracking for authorization
 * - Delayed cleanup to handle reconnection scenarios
 */

import { EventEmitter } from 'events';

class AgentStreamManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Support many concurrent sessions
    this.eventBuffers = new Map(); // sessionId -> Array of buffered events
    this.sessionOwnership = new Map(); // sessionId -> { classroomSlug, userId, createdAt }
    this.cleanupTimers = new Map(); // sessionId -> cleanup timeout handle
  }

  // ===========================================================================
  // SESSION OWNERSHIP (used by SSE endpoints for authorization)
  // ===========================================================================

  /**
   * Register session ownership for authorization checks
   * Called when a session is initialized
   *
   * @param {string} sessionId - Attempt or conversation ID
   * @param {string} classroomSlug - Classroom that owns this session
   * @param {string} userId - User who created this session
   */
  registerSession(sessionId, classroomSlug, userId) {
    // Cancel any pending cleanup for this session
    const existingTimer = this.cleanupTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.cleanupTimers.delete(sessionId);
    }

    this.sessionOwnership.set(sessionId, {
      classroomSlug,
      userId: userId?.toString(),
      createdAt: Date.now(),
    });
  }

  /**
   * Get session ownership info for authorization
   *
   * @param {string} sessionId
   * @returns {{ classroomSlug: string, userId: string, createdAt: number } | null}
   */
  getSessionOwnership(sessionId) {
    return this.sessionOwnership.get(sessionId) || null;
  }

  // ===========================================================================
  // SUBSCRIBE/PUBLISH (unified pattern for all agent types)
  // ===========================================================================

  /**
   * Subscribe to events for a session (used by SSE endpoints)
   * Returns an unsubscribe function that MUST be called on disconnect
   *
   * @param {string} sessionId - The session to subscribe to
   * @param {Function} callback - Called with each event { type, data }
   * @returns {Function} Unsubscribe function
   */
  subscribeToSession(sessionId, callback) {
    const eventName = `agent:${sessionId}`;
    this.on(eventName, callback);

    // Replay buffered events so late subscribers don't miss early messages
    const buffered = this.eventBuffers.get(sessionId);
    if (buffered?.length) {
      for (const event of buffered) {
        try {
          callback(event);
        } catch (error) {
          console.error('[agentStreamManager] Error replaying buffered event:', error);
        }
      }
    }

    // Return unsubscribe function
    return () => {
      this.off(eventName, callback);
    };
  }

  /**
   * Alias for subscribeToSession (backwards compatibility)
   * @deprecated Use subscribeToSession instead
   */
  subscribeToAttempt(attemptId, callback) {
    return this.subscribeToSession(attemptId, callback);
  }

  /**
   * Publish event for a session (called when ai-agent emits)
   *
   * @param {string} sessionId - The session to publish to
   * @param {Object} event - Event object with { type, data }
   */
  publishEvent(sessionId, event) {
    const eventName = `agent:${sessionId}`;

    // Buffer important events for late-connecting clients
    // NOTE: Do NOT buffer 'done' or 'error' - these are terminal events that should only
    // be received once. Buffering them causes infinite reconnection loops because
    // EventSource auto-reconnects and immediately receives the buffered terminal event.
    const bufferableTypes = ['message', 'ready', 'quiz_ready', 'message_ready', 'assistant_response', 'content_reference'];
    if (bufferableTypes.includes(event.type)) {
      if (!this.eventBuffers.has(sessionId)) {
        this.eventBuffers.set(sessionId, []);
      }
      const buffer = this.eventBuffers.get(sessionId);
      buffer.push(event);
      // Prevent unbounded growth
      if (buffer.length > 50) {
        buffer.shift();
      }
    }

    this.emit(eventName, event);
  }

  // ===========================================================================
  // SPECIFIC EVENT PUBLISHERS (convenience methods)
  // ===========================================================================

  /**
   * Publish an exploration step event
   */
  publishStep(sessionId, step) {
    this.publishEvent(sessionId, { type: 'exploration_step', data: step });
  }

  /**
   * Publish quiz ready event
   */
  publishQuizReady(sessionId, data) {
    this.publishEvent(sessionId, { type: 'quiz_ready', data });
  }

  /**
   * Publish message ready event (agent response)
   */
  publishMessageReady(sessionId, data) {
    this.publishEvent(sessionId, { type: 'message_ready', data });
  }

  /**
   * Publish assistant response (for prompt assistant)
   */
  publishAssistantResponse(sessionId, data) {
    this.publishEvent(sessionId, { type: 'assistant_response', data });
  }

  /**
   * Publish content reference (for syllabus bot)
   */
  publishContentReference(sessionId, data) {
    this.publishEvent(sessionId, { type: 'content_reference', data });
  }

  /**
   * Publish error event
   */
  publishError(sessionId, error) {
    this.publishEvent(sessionId, { type: 'error', data: { error: error.message || error } });
  }

  /**
   * Signal that streaming is complete
   * Automatically schedules session cleanup after a delay
   */
  publishDone(sessionId) {
    this.publishEvent(sessionId, { type: 'done', data: {} });
    // Schedule cleanup after delay to allow late-connecting clients to receive buffered events
    this.cleanupSession(sessionId);
  }

  // ===========================================================================
  // BUFFER & CLEANUP METHODS
  // ===========================================================================

  /**
   * Enqueue event to buffer (backwards compatibility)
   * @deprecated Use publishEvent instead which handles buffering
   */
  enqueueEvent(sessionId, event) {
    this.publishEvent(sessionId, event);
  }

  /**
   * Clean up session when it ends
   * Uses delayed cleanup to allow late-connecting clients to receive buffered events
   *
   * @param {string} sessionId
   * @param {Object} options
   * @param {number} options.delayMs - Delay before cleanup (default 30s)
   */
  cleanupSession(sessionId, { delayMs = 30000 } = {}) {
    // Cancel any existing cleanup timer
    const existingTimer = this.cleanupTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule delayed cleanup
    const timer = setTimeout(() => {
      this.sessionOwnership.delete(sessionId);
      this.eventBuffers.delete(sessionId);
      this.cleanupTimers.delete(sessionId);
    }, delayMs);

    this.cleanupTimers.set(sessionId, timer);
  }

  /**
   * Force immediate cleanup (for testing or explicit session end)
   *
   * @param {string} sessionId
   */
  forceCleanupSession(sessionId) {
    // Cancel any pending delayed cleanup
    const timer = this.cleanupTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(sessionId);
    }

    this.sessionOwnership.delete(sessionId);
    this.eventBuffers.delete(sessionId);
  }

  /**
   * Get statistics about active sessions (for debugging/monitoring)
   */
  getStats() {
    return {
      activeSessions: this.sessionOwnership.size,
      bufferedSessions: this.eventBuffers.size,
      pendingCleanups: this.cleanupTimers.size,
    };
  }
}

// Singleton instance
const agentStreamManager = new AgentStreamManager();

export default agentStreamManager;
