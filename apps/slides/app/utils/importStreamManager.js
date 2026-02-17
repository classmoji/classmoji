/**
 * Import Stream Manager
 *
 * Singleton pub/sub for slide import progress events.
 * Handles communication between the async import process and SSE endpoints.
 *
 * Features:
 * - Event buffering for late-connecting clients (replay)
 * - Automatic cleanup after import completes
 */

import { EventEmitter } from 'events';

class ImportStreamManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Support multiple concurrent imports
    this.eventBuffers = new Map(); // slideId -> Array of buffered events
    this.cleanupTimers = new Map(); // slideId -> cleanup timeout handle
  }

  /**
   * Subscribe to import progress events
   * Returns an unsubscribe function that MUST be called on disconnect
   *
   * @param {string} slideId - The slide being imported
   * @param {Function} callback - Called with each event { type, step, ... }
   * @returns {Function} Unsubscribe function
   */
  subscribe(slideId, callback) {
    const eventName = `import:${slideId}`;
    this.on(eventName, callback);

    // Replay buffered events so late subscribers don't miss early messages
    const buffered = this.eventBuffers.get(slideId);
    if (buffered?.length) {
      for (const event of buffered) {
        try {
          callback(event);
        } catch (error) {
          console.error('[importStreamManager] Error replaying buffered event:', error);
        }
      }
    }

    // Return unsubscribe function
    return () => {
      this.off(eventName, callback);
    };
  }

  /**
   * Publish a progress event
   *
   * @param {string} slideId - The slide being imported
   * @param {Object} event - Event object { type: 'step'|'done'|'error', ... }
   */
  publish(slideId, event) {
    const eventName = `import:${slideId}`;

    // Buffer all events for late-connecting clients
    if (!this.eventBuffers.has(slideId)) {
      this.eventBuffers.set(slideId, []);
    }
    const buffer = this.eventBuffers.get(slideId);
    buffer.push(event);

    // Prevent unbounded growth (keep last 100 events)
    if (buffer.length > 100) {
      buffer.shift();
    }

    this.emit(eventName, event);

    // Schedule cleanup on completion events
    if (event.type === 'done' || event.type === 'error') {
      this.scheduleCleanup(slideId);
    }
  }

  /**
   * Schedule cleanup after import completes
   * Delay allows late-connecting clients to receive buffered events
   *
   * @param {string} slideId
   * @param {number} delayMs - Delay before cleanup (default 60s)
   */
  scheduleCleanup(slideId, delayMs = 60000) {
    // Cancel any existing cleanup timer
    const existingTimer = this.cleanupTimers.get(slideId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule delayed cleanup
    const timer = setTimeout(() => {
      this.eventBuffers.delete(slideId);
      this.cleanupTimers.delete(slideId);
    }, delayMs);

    this.cleanupTimers.set(slideId, timer);
  }

  /**
   * Force immediate cleanup (for testing or explicit cleanup)
   *
   * @param {string} slideId
   */
  forceCleanup(slideId) {
    const timer = this.cleanupTimers.get(slideId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(slideId);
    }
    this.eventBuffers.delete(slideId);
  }

  /**
   * Get statistics (for debugging/monitoring)
   */
  getStats() {
    return {
      activeImports: this.eventBuffers.size,
      pendingCleanups: this.cleanupTimers.size,
    };
  }
}

// Singleton instance
export const importStreamManager = new ImportStreamManager();
