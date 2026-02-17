import { useCallback, useEffect, useRef } from 'react';

const sanitizeInputValue = value => {
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
}) {
  const baseTotalRef = useRef(sanitizeInputValue(initialTotalMs));
  const baseUnfocusedRef = useRef(sanitizeInputValue(initialUnfocusedMs));
  const sessionStartRef = useRef(null);
  const unfocusedStartRef = useRef(null);
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

  // Update base values when server reports higher values (e.g., after modal gap calculation)
  // CRITICAL: Must reset sessionStartRef to prevent double-counting time already in the base
  useEffect(() => {
    const sanitizedTotal = sanitizeInputValue(initialTotalMs);
    const sanitizedUnfocused = sanitizeInputValue(initialUnfocusedMs);

    const totalIncreased = sanitizedTotal > baseTotalRef.current;
    const unfocusedIncreased = sanitizedUnfocused > baseUnfocusedRef.current;

    if (totalIncreased) {
      baseTotalRef.current = sanitizedTotal;
    }
    if (unfocusedIncreased) {
      baseUnfocusedRef.current = sanitizedUnfocused;
    }

    // If base was updated from server (e.g., modal gap applied), reset session start
    // to prevent double-counting the elapsed time already absorbed into the base.
    // Without this reset, getMetricsSnapshot() would add (now - originalSessionStart)
    // to a base that already includes that time, inflating the total.
    if ((totalIncreased || unfocusedIncreased) && sessionStartRef.current !== null) {
      sessionStartRef.current = Date.now();
    }
  }, [initialTotalMs, initialUnfocusedMs]);

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
      window.removeEventListener('blur-sm', handleBlur);
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
  };
}
