/**
 * useImportStream - Client hook for SSE-based import progress
 *
 * Subscribes to real-time progress events during slide imports.
 * Returns current step, progress counts, done/error states, and the final slideId.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

interface ImportProgress {
  step: string;
  current?: number;
  total?: number;
  filename?: string;
}

export function useImportStream(importId: string | null) {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [slideId, setSlideId] = useState<string | null>(null); // The actual slideId from done event
  const eventSourceRef = useRef<EventSource | null>(null);

  // Reset state when importId changes
  useEffect(() => {
    setProgress(null);
    setError(null);
    setIsDone(false);
    setIsConnected(false);
    setSlideId(null);
  }, [importId]);

  // Subscribe to SSE stream
  useEffect(() => {
    if (!importId) return;

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/slides/import/stream/${importId}`);
    eventSourceRef.current = eventSource;

    // Handle incoming messages
    // Our SSE endpoint sends all events as 'data: {...}\n\n' (no named events)
    eventSource.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setIsConnected(true);
        } else if (data.type === 'step') {
          setProgress({
            step: data.step,
            current: data.current,
            total: data.total,
            filename: data.filename,
          });
        } else if (data.type === 'done') {
          setSlideId(data.slideId); // Extract slideId from done event
          setIsDone(true);
          eventSource.close();
        } else if (data.type === 'error') {
          setError(data.message || 'Import failed');
          eventSource.close();
        }
      } catch (e: unknown) {
        console.error('[useImportStream] Failed to parse event:', e);
      }
    };

    // Handle connection errors
    eventSource.onerror = () => {
      // Only treat as error if we never connected successfully
      if (!isConnected && !isDone) {
        setError('Failed to connect to import progress stream');
      }
      eventSource.close();
    };

    // Cleanup on unmount or importId change
    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [importId]);

  // Manual disconnect function
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  return {
    progress,
    error,
    isDone,
    isConnected,
    slideId, // The actual slideId (available after done event)
    disconnect,
  };
}
