import { useCallback, useEffect, useRef } from 'react';

const sanitizeInputValue = (value: number | null | undefined) => {
  if (value === undefined || value === null) return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const rounded = Math.round(numeric);
  return rounded < 0 ? 0 : rounded;
};

export function useQuizFocusMetrics({
  isActive,
  attemptId,
  initialTotalMs = 0,
  initialUnfocusedMs = 0,
}: {
  isActive: boolean;
  attemptId: unknown;
  initialTotalMs?: number;
  initialUnfocusedMs?: number;
}) {
  const baseTotalRef = useRef(sanitizeInputValue(initialTotalMs));
  const baseUnfocusedRef = useRef(sanitizeInputValue(initialUnfocusedMs));
  const sessionStartRef = useRef<number | null>(null);
  const unfocusedStartRef = useRef<number | null>(null);
  const sessionInitializedRef = useRef(false);

  const startUnfocused = useCallback(() => {
    if (unfocusedStartRef.current !== null) return;
    unfocusedStartRef.current = Date.now();
  }, []);

  const stopUnfocused = useCallback(() => {
    if (unfocusedStartRef.current === null) return;
    const unfocusedDuration = Date.now() - unfocusedStartRef.current;
    baseUnfocusedRef.current += unfocusedDuration;
    unfocusedStartRef.current = null;
  }, []);

  const getMetricsSnapshot = useCallback(() => {
    const now = Date.now();
    let total = baseTotalRef.current;
    if (sessionStartRef.current !== null) {
      total += now - sessionStartRef.current;
    }

    let unfocused = baseUnfocusedRef.current;
    if (unfocusedStartRef.current !== null) {
      unfocused += now - unfocusedStartRef.current;
    }

    return {
      totalMs: Math.max(0, Math.round(total)),
      unfocusedMs: Math.max(0, Math.round(unfocused)),
    };
  }, []);

  const finalizeCurrentSession = useCallback(() => {
    if (sessionStartRef.current !== null) {
      const duration = Date.now() - sessionStartRef.current;
      baseTotalRef.current += duration;
      sessionStartRef.current = null;
    }
    stopUnfocused();
    return getMetricsSnapshot();
  }, [getMetricsSnapshot, stopUnfocused]);

  // Initialize base values only when attemptId changes (new attempt)
  // Don't reset if just the initial values update (from revalidation)
  useEffect(() => {
    const sanitizedTotal = sanitizeInputValue(initialTotalMs);
    const sanitizedUnfocused = sanitizeInputValue(initialUnfocusedMs);

    baseTotalRef.current = sanitizedTotal;
    baseUnfocusedRef.current = sanitizedUnfocused;
    sessionStartRef.current = null;
    unfocusedStartRef.current = null;
    sessionInitializedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  /**
   * Stored values from the server (the gap added on open, a refreshed
   * attempt): each one above this tracker's count now replaces it, and its
   * running segment counts on from now (the time so far is in the stored
   * value). A value at or below the count is a write this tab already made,
   * and changes nothing. Total and unfocused are raised independently.
   */
  const raiseTo = useCallback(
    (totalMs: number | null | undefined, unfocusedMs: number | null | undefined) => {
      const total = sanitizeInputValue(totalMs);
      const unfocused = sanitizeInputValue(unfocusedMs);
      const current = getMetricsSnapshot();
      const now = Date.now();
      if (total > current.totalMs) {
        baseTotalRef.current = total;
        if (sessionStartRef.current !== null) sessionStartRef.current = now;
      }
      if (unfocused > current.unfocusedMs) {
        baseUnfocusedRef.current = unfocused;
        if (unfocusedStartRef.current !== null) unfocusedStartRef.current = now;
      }
    },
    [getMetricsSnapshot]
  );

  // A revalidated attempt can carry higher stored values.
  useEffect(() => {
    raiseTo(initialTotalMs, initialUnfocusedMs);
  }, [initialTotalMs, initialUnfocusedMs, raiseTo]);

  // Main effect: Start session and set up event listeners
  useEffect(() => {
    if (!attemptId) return undefined;
    if (typeof window === 'undefined') return undefined;

    // Only initialize session once per attempt
    if (!sessionInitializedRef.current) {
      sessionStartRef.current = Date.now();
      sessionInitializedRef.current = true;
    }

    // Only set up event listeners if tracking is active
    if (!isActive) return undefined;

    // Tracking resumed after a stop (the quiz reopened after the server would
    // not complete it): time counts again from now. The stopped segment is
    // already in the base, so nothing is counted twice.
    if (sessionStartRef.current === null) {
      sessionStartRef.current = Date.now();
    }

    const doc = typeof document !== 'undefined' ? document : null;

    if (doc) {
      // Only start unfocused if the document is actually hidden (not just lacking focus)
      // document.hasFocus() can return false during initial mount even when the user is on the page
      const isHidden = doc.visibilityState === 'hidden' || doc.hidden;
      if (isHidden) {
        startUnfocused();
      }
    }

    const handleVisibilityChange = () => {
      if (!doc) return;
      if (doc.visibilityState === 'hidden') {
        startUnfocused();
      } else if (doc.visibilityState === 'visible') {
        stopUnfocused();
      }
    };

    const handleBlur = () => startUnfocused();
    const handleFocus = () => stopUnfocused();
    const handlePagePersist = () => finalizeCurrentSession();

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    if (doc) {
      doc.addEventListener('visibilitychange', handleVisibilityChange);
    }
    window.addEventListener('beforeunload', handlePagePersist);
    window.addEventListener('pagehide', handlePagePersist);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      if (doc) {
        doc.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      window.removeEventListener('beforeunload', handlePagePersist);
      window.removeEventListener('pagehide', handlePagePersist);

      // Only finalize if we're actually done (not just re-rendering)
      if (isActive) {
        finalizeCurrentSession();
      }
    };
  }, [attemptId, finalizeCurrentSession, isActive, startUnfocused, stopUnfocused]);

  return {
    getMetricsSnapshot,
    finalizeCurrentSession,
    raiseTo,
  };
}
