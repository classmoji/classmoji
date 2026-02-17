import { useRevalidator } from 'react-router';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { checkForCompletion } from '~/utils/quizUtils';
import { useDarkMode } from '~/hooks';
import ChatEditor from '../../../routes/student.$class.quizzes/ChatEditor';
import { useQuizFocusMetrics } from './useQuizFocusMetrics';
import QuizMessageList from './QuizMessageList';

/**
 * Debug flag for quiz metrics logging. Set to true to diagnose time tracking issues.
 * See docs/RUN_QUIZ_TEST.md for testing procedures.
 */
const DEBUG_QUIZ_METRICS = false;

/**
 * QuizAttemptInterface - A reusable quiz interface component for routes
 *
 * This component handles all quiz interactions including:
 * - DB polling via revalidation for real-time updates
 * - Time tracking with focus/unfocus detection
 * - Dark mode support
 * - Message sending and receiving
 * - Quiz completion detection
 *
 * @param {Object} quiz - The quiz object
 * @param {Object} attempt - The current attempt object
 * @param {Array} messages - Initial messages array
 * @param {string} userLogin - User's login/username
 * @param {boolean} readOnly - Whether the interface is read-only (completed attempts)
 * @param {boolean} showTimestamps - Whether to show message timestamps
 * @param {Object} focusMetrics - Pre-calculated focus metrics (for completed attempts)
 * @param {boolean} isVisible - Whether the drawer/modal containing this component is visible
 */
function QuizAttemptInterface({
  quiz,
  attempt,
  messages: initialMessages = [],
  userLogin,
  readOnly = false,
  showTimestamps = false,
  focusMetrics = null,
  isVisible = true,
}) {
  const [messages, setMessages] = useState(initialMessages || []);
  // inputValue state removed — ChatEditor owns editor content and submits directly
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false); // True while waiting for AI response after user sends
  const [isQuizComplete, setIsQuizComplete] = useState(false);
  const [evaluationData, setEvaluationData] = useState(null);
  const [completionFocusMetrics, setCompletionFocusMetrics] = useState(null);
  const revalidator = useRevalidator();
  const revalidateRef = useRef(() => revalidator.revalidate());
  // Keep ref fresh across re-renders (revalidator may change)
  revalidateRef.current = () => revalidator.revalidate();
  const startingQuizRef = useRef(false);
  const welcomeInjectedRef = useRef(false);
  const pendingUserMessageRef = useRef(null); // Tracks optimistic user message content during sends
  const explorationStepBaseRef = useRef(0); // Count of exploration steps before current send/load started
  const finalizeRef = useRef(null); // Store finalize function for unmount cleanup
  const { isDarkMode } = useDarkMode();

  const attemptId = attempt?.id;
  const initialTotalDurationMs = Number(attempt?.total_duration_ms ?? 0);
  const initialUnfocusedDurationMs = Number(attempt?.unfocused_duration_ms ?? 0);

  // Calculate if we should actively track time
  const shouldTrackTime = useMemo(() => {
    if (!attemptId) return false;
    if (readOnly) return false;
    if (attempt?.completed_at) return false;
    if (isQuizComplete) return false;
    return true;
  }, [attemptId, readOnly, attempt?.completed_at, isQuizComplete]);

  const { getMetricsSnapshot, finalizeCurrentSession } = useQuizFocusMetrics({
    isActive: shouldTrackTime,
    attemptId,
    initialTotalMs: initialTotalDurationMs,
    initialUnfocusedMs: initialUnfocusedDurationMs,
  });

  const lastMetricsRef = useRef({
    totalMs: Math.max(0, Math.round(initialTotalDurationMs)),
    unfocusedMs: Math.max(0, Math.round(initialUnfocusedDurationMs)),
  });

  useEffect(() => {
    lastMetricsRef.current = {
      totalMs: Math.max(0, Math.round(initialTotalDurationMs)),
      unfocusedMs: Math.max(0, Math.round(initialUnfocusedDurationMs)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  // Keep finalize ref updated for unmount cleanup
  useEffect(() => {
    finalizeRef.current = finalizeCurrentSession;
  }, [finalizeCurrentSession]);

  useEffect(() => {
    const totalMs = Math.round(initialTotalDurationMs);
    const unfocusedMs = Math.round(initialUnfocusedDurationMs);
    lastMetricsRef.current = {
      totalMs: Math.max(lastMetricsRef.current.totalMs, totalMs),
      unfocusedMs: Math.max(lastMetricsRef.current.unfocusedMs, unfocusedMs),
    };
  }, [initialTotalDurationMs, initialUnfocusedDurationMs]);

  const sendMetricsUpdate = useCallback(
    ({ reason = 'passive', finalize = false, preferBeacon = false } = {}) => {
      if (!attemptId || readOnly) return;

      // CRITICAL: Don't send updates for completed quizzes
      if (isQuizComplete) return;

      const snapshot = finalize ? finalizeCurrentSession() : getMetricsSnapshot();
      if (DEBUG_QUIZ_METRICS)
        console.log('[QuizMetrics] Snapshot received:', snapshot, 'finalize:', finalize);
      if (!snapshot) {
        if (DEBUG_QUIZ_METRICS) console.log('[QuizMetrics] No snapshot available');
        return;
      }

      const previous = lastMetricsRef.current;
      const deltaTotal = snapshot.totalMs - previous.totalMs;
      const deltaUnfocused = snapshot.unfocusedMs - previous.unfocusedMs;

      // Skip if no change
      if (deltaTotal === 0 && deltaUnfocused === 0) return;

      // Validate metrics before sending
      if (snapshot.unfocusedMs > snapshot.totalMs) {
        console.warn('[QuizMetrics] Invalid metrics: unfocused > total', snapshot);
        // Cap unfocused to total
        snapshot.unfocusedMs = snapshot.totalMs;
      }

      const payload = {
        _action: 'updateMetrics',
        attemptId,
        totalDurationMs: snapshot.totalMs,
        unfocusedDurationMs: snapshot.unfocusedMs,
        reason,
      };
      if (DEBUG_QUIZ_METRICS) console.log('[QuizMetrics] Sending payload:', payload);

      const sendViaFetch = () =>
        fetch('/api/quiz', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(response => {
            if (!response.ok) {
              console.error('[QuizMetrics] API error:', response.status, response.statusText);
            }
            return response;
          })
          .catch(error => {
            console.error('[QuizMetrics] Failed to persist quiz metrics:', error);
          });

      let sent = false;

      if (
        preferBeacon &&
        typeof navigator !== 'undefined' &&
        typeof Blob !== 'undefined' &&
        typeof navigator.sendBeacon === 'function'
      ) {
        try {
          const beaconPayload = JSON.stringify(payload);
          sent = navigator.sendBeacon(
            '/api/quiz',
            new Blob([beaconPayload], { type: 'application/json' })
          );
        } catch (error) {
          console.error('[QuizMetrics] sendBeacon error:', error);
          sent = false;
        }
      }

      if (!sent) {
        void sendViaFetch();
      }

      lastMetricsRef.current = snapshot;
    },
    [attemptId, finalizeCurrentSession, getMetricsSnapshot, readOnly, isQuizComplete]
  );

  // Periodic metrics updates - save every 30 seconds
  // Store interval/timeout refs to allow manual cleanup on completion
  const periodicTimersRef = useRef({ timeout: null, interval: null });

  useEffect(() => {
    if (!shouldTrackTime || !attemptId) return undefined;

    // Initial save after 5 seconds to verify tracking works
    const initialTimeout = setTimeout(() => {
      sendMetricsUpdate({ reason: 'initial_checkpoint' });
    }, 5000);

    // Then save every 30 seconds
    const intervalId = setInterval(() => {
      sendMetricsUpdate({ reason: 'periodic' });
    }, 30000);

    // Store refs for manual cleanup
    periodicTimersRef.current = { timeout: initialTimeout, interval: intervalId };

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
      periodicTimersRef.current = { timeout: null, interval: null };
    };
  }, [shouldTrackTime, attemptId, sendMetricsUpdate]);

  useEffect(() => {
    return () => {
      if (attemptId) {
        sendMetricsUpdate({ reason: 'unmount', finalize: true, preferBeacon: true });
      }
    };
  }, [attemptId, sendMetricsUpdate]);

  useEffect(() => {
    if (!attemptId) {
      return undefined;
    }

    if (typeof document === 'undefined') {
      return undefined;
    }

    const handleVisibilityHidden = () => {
      if (document.visibilityState === 'hidden') {
        sendMetricsUpdate({ reason: 'tab_hidden', preferBeacon: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityHidden);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityHidden);
    };
  }, [attemptId, sendMetricsUpdate]);

  useEffect(() => {
    if (!attemptId) {
      return undefined;
    }

    if (typeof window === 'undefined') {
      return undefined;
    }

    const handlePageHide = () => {
      // Manually trigger the "close" logic here to ensure the timestamp is recorded
      // even if the React unmount cycle gets cut off by the browser.
      // Use ref to avoid stale closure - matches pattern in unmount effect (line 386)
      const snapshot = finalizeRef.current ? finalizeRef.current() : null;

      // Safety check: ensure snapshot exists before accessing properties
      if (!snapshot) return;

      const payload = {
        _action: 'recordModalClose',
        attemptId,
        totalDurationMs: snapshot.totalMs,
        unfocusedDurationMs: snapshot.unfocusedMs,
      };

      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/quiz',
          new Blob([JSON.stringify(payload)], { type: 'application/json' })
        );
      }
    };

    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
  }, [attemptId]);

  // Track drawer/modal visibility to record gap time as unfocused.
  //
  // IMPORTANT: When the drawer closes, the user navigates away and this component
  // UNMOUNTS entirely. When they return, a NEW component instance mounts.
  // This means we can't rely on React state/refs to detect "reopen" - they reset.
  //
  // Strategy:
  // 1. On visibility change to false (drawer closing): record modal_closed_at
  // 2. On component MOUNT: always call recordModalOpen to check for pending gap
  //    (server returns early if no modal_closed_at is set)
  // 3. On unmount: ONLY record modal_closed_at if user explicitly closed the modal
  //    (not on React re-renders or initial mount)
  const previousVisibleRef = useRef(isVisible);
  const hasCalledModalOpenRef = useRef(false);
  const hasUserClosedModalRef = useRef(false); // Track if user explicitly closed

  // On mount: check for pending gap time from a previous session
  useEffect(() => {
    if (!attemptId || readOnly || isQuizComplete || hasCalledModalOpenRef.current) return;

    hasCalledModalOpenRef.current = true;

    // Always call recordModalOpen on mount - server will check if modal_closed_at exists
    // If it does, it calculates gap and clears the timestamp
    // If not, it's a no-op
    fetch('/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _action: 'recordModalOpen',
        attemptId,
      }),
    })
      .then(res => res.json())
      .then(data => {
        // Only revalidate if gap was actually applied
        if (data?.gapApplied) {
          revalidateRef.current();
        }
      })
      .catch(error => {
        console.error('[QuizAttemptInterface] recordModalOpen failed:', error);
      });
  }, [attemptId, readOnly, isQuizComplete]);

  // Track visibility changes within the same component lifecycle
  useEffect(() => {
    if (!attemptId || readOnly || isQuizComplete) return;

    const wasVisible = previousVisibleRef.current;
    const nowVisible = isVisible;

    // Drawer was closed → finalize metrics AND record close atomically
    if (wasVisible && !nowVisible) {
      // Mark that user explicitly closed the modal
      hasUserClosedModalRef.current = true;

      const snapshot = finalizeCurrentSession();

      // Send metrics AND record close in ONE request
      // Server uses row-level locking to handle race conditions
      const payload = {
        _action: 'recordModalClose',
        attemptId,
        totalDurationMs: snapshot.totalMs,
        unfocusedDurationMs: snapshot.unfocusedMs,
      };

      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/quiz',
          new Blob([JSON.stringify(payload)], { type: 'application/json' })
        );
      } else {
        fetch('/api/quiz', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    }

    previousVisibleRef.current = nowVisible;
  }, [attemptId, isVisible, readOnly, isQuizComplete, finalizeCurrentSession]);

  // On unmount: record modal close with metrics as backup
  // We call recordModalClose if:
  // 1. User explicitly closed via visibility change (hasUserClosedModalRef.current === true), OR
  // 2. Session was active for > 1 second (indicates real usage, not React re-render artifact)
  // This prevents premature calls during strict mode but handles the navigation-away case
  // where the component unmounts before isVisible changes to false
  useEffect(() => {
    const currentAttemptId = attemptId;
    return () => {
      if (!currentAttemptId || readOnly) return;

      const snapshot = finalizeRef.current ? finalizeRef.current() : null;
      const hasSignificantSession = snapshot?.totalMs > 1000;

      // Fire recordModalClose if user explicitly closed OR if this was a real session
      // The 1-second threshold filters out React strict mode double-mounting artifacts
      if (hasUserClosedModalRef.current || hasSignificantSession) {
        const payload = {
          _action: 'recordModalClose',
          attemptId: currentAttemptId,
          totalDurationMs: snapshot?.totalMs,
          unfocusedDurationMs: snapshot?.unfocusedMs,
        };

        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            '/api/quiz',
            new Blob([JSON.stringify(payload)], { type: 'application/json' })
          );
        }
      }
    };
  }, [attemptId, readOnly]);

  // Dynamically load highlight.js theme based on dark mode
  useEffect(() => {
    // Remove any existing highlight.js theme
    const existingLink = document.querySelector('link[data-hljs-theme]');
    if (existingLink) {
      existingLink.remove();
    }

    // Add the appropriate theme
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-hljs-theme', 'true');

    if (isDarkMode) {
      link.href =
        'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
    } else {
      link.href =
        'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    }

    document.head.appendChild(link);

    return () => {
      // Cleanup when component unmounts
      const linkToRemove = document.querySelector('link[data-hljs-theme]');
      if (linkToRemove) {
        linkToRemove.remove();
      }
    };
  }, [isDarkMode]);

  // Initialize messages and check for completion
  useEffect(() => {
    if (initialMessages) {
      // Filter out SYSTEM messages (exploration steps) for display
      const displayMessages = initialMessages.filter(m => m.role !== 'system');
      setMessages(displayMessages);
      welcomeInjectedRef.current = displayMessages.length > 0;

      // Check if we're waiting for the first question after welcome message
      // If we have exactly 1 assistant message (the welcome) and no opening message yet, set loading
      const assistantMessages = displayMessages.filter(m => m.role === 'assistant');
      const hasOpeningMessage = assistantMessages.some(m => m.metadata?.isOpeningMessage);
      const hasWelcomeOnly = assistantMessages.length === 1 && !hasOpeningMessage;
      if (hasWelcomeOnly && !readOnly) {
        setLoading(true);
      }

      // Check if quiz is already complete from loaded messages
      for (const msg of displayMessages) {
        if (msg.role === 'assistant') {
          const completion = checkForCompletion(msg.content);
          if (completion) {
            setIsQuizComplete(true);
            setEvaluationData(completion);
            break;
          }
        }
      }
    }
  }, [initialMessages, readOnly]);

  // Auto-start quiz if attempt exists but has no real messages
  useEffect(() => {
    // Only start if we have attemptId BUT no real messages (SYSTEM already filtered from messages state)
    const hasRealMessages = messages.some(m => m.role === 'assistant' || m.role === 'user');

    if (attemptId && !hasRealMessages && !readOnly && !startingQuizRef.current) {
      startingQuizRef.current = true;
      setLoading(true);

      // Start quiz with the existing attemptId
      fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'startQuiz',
          quizId: quiz.id,
          attemptId: attemptId, // Pass the attemptId
        }),
      })
        .then(async res => {
          if (!res.ok) {
            const text = await res.text();
            console.error('Server error response:', text);
            throw new Error(`HTTP error! status: ${res.status}`);
          }
          return res.json();
        })
        .then(() => {
          // Quiz started successfully - keep startingQuizRef true to prevent re-runs
          // Keep loading true - polling will detect when messages arrive
          // Trigger a re-fetch of the loader data
          revalidateRef.current();
        })
        .catch(error => {
          console.error('Error starting quiz:', error);
          setLoading(false);
          startingQuizRef.current = false;
          const errorMessage = {
            id: 1,
            role: 'ASSISTANT',
            content: `I'm having trouble starting the quiz. Error: ${error.message}. Please try refreshing the page.`,
          };
          setMessages([errorMessage]);
        });
    }
  }, [messages, quiz.id, attemptId, readOnly]);

  // Poll DB for real-time updates while loading OR sending (replaces SSE streaming)
  // The ai-agent saves all messages to the DB — we just revalidate to pick them up.
  // This works reliably across multiple Fly.io machines since all read from the same DB.
  useEffect(() => {
    if (readOnly || !attemptId || (!loading && !sending)) return;

    const interval = setInterval(() => {
      revalidateRef.current();
    }, 1500);

    return () => clearInterval(interval);
  }, [attemptId, loading, sending, readOnly]);

  // Update messages when quiz data changes (after revalidation)
  // Derives exploration steps from SYSTEM messages and manages loading state
  useEffect(() => {
    if (readOnly) return;
    if (!attemptId) return;

    const updatedMessages = initialMessages || [];

    // Filter out SYSTEM messages (exploration steps) from display messages
    const displayMessages = updatedMessages.filter(m => m.role !== 'system');

    // Smart merge: during sends, preserve the optimistic user message until DB catches up
    if (sending && pendingUserMessageRef.current) {
      const dbHasUserMsg = displayMessages.some(
        m => m.role?.toLowerCase() === 'user' && m.content === pendingUserMessageRef.current
      );
      if (!dbHasUserMsg) {
        // DB hasn't saved our message yet — append it so it stays visible
        setMessages([...displayMessages, { id: 'pending-user-msg', role: 'USER', content: pendingUserMessageRef.current }]);
      } else {
        // DB caught up — use DB messages directly
        setMessages(displayMessages);
      }
    } else {
      setMessages(displayMessages);
    }

    if (displayMessages.length > 0) {
      welcomeInjectedRef.current = true;
    }

    // Determine if we should stop loading:
    // Loading stops when we get an assistant message with isOpeningMessage metadata
    // (the first real question after exploration), or when the latest message is from assistant
    // and it's not just a welcome message
    if (loading && displayMessages.length > 0) {
      const assistantMessages = displayMessages.filter(m => m.role === 'assistant');
      const hasOpeningMessage = assistantMessages.some(m => m.metadata?.isOpeningMessage);
      // Also check: if last message is assistant and user sent the most recent user message before it
      const lastMsg = displayMessages[displayMessages.length - 1];
      const lastIsAssistantResponse = lastMsg?.role === 'assistant' && !lastMsg?.metadata?.isWelcomeMessage;

      if (hasOpeningMessage || (assistantMessages.length >= 2 && lastIsAssistantResponse)) {
        setLoading(false);
      }
    }

    // Check for completion in updated messages
    if (!isQuizComplete) {
      for (const msg of displayMessages) {
        if (msg.role === 'assistant') {
          const completion = checkForCompletion(msg.content);
          if (completion) {
            setIsQuizComplete(true);
            setEvaluationData(completion);

            const completionMetrics = finalizeCurrentSession();
            lastMetricsRef.current = completionMetrics;

            // Calculate focus metrics for display
            const totalMs = completionMetrics.totalMs;
            const unfocusedMs = completionMetrics.unfocusedMs;
            const focusedMs = Math.max(0, totalMs - unfocusedMs);
            const focusPercentage = totalMs > 0 ? Math.round((focusedMs / totalMs) * 100) : 100;

            setCompletionFocusMetrics({
              totalMs,
              focusedMs,
              percentage: focusPercentage,
            });

            // CRITICAL: Immediately stop periodic timers to prevent further updates
            if (periodicTimersRef.current.timeout) {
              clearTimeout(periodicTimersRef.current.timeout);
            }
            if (periodicTimersRef.current.interval) {
              clearInterval(periodicTimersRef.current.interval);
            }
            periodicTimersRef.current = { timeout: null, interval: null };

            // Complete the quiz in the backend
            fetch('/api/quiz', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                _action: 'completeQuiz',
                attemptId: attemptId,
                totalDurationMs: completionMetrics.totalMs,
                unfocusedDurationMs: completionMetrics.unfocusedMs,
              }),
            })
              .then(() => {
                revalidateRef.current();
              })
              .catch(error => {
                console.error('Error completing quiz:', error);
              });
            break;
          }
        }
      }
    }
  }, [initialMessages, attemptId, isQuizComplete, finalizeCurrentSession, readOnly, loading, sending]);

  const handleSend = async (messageContent) => {
    if (!messageContent || !attemptId) {
      return;
    }

    const userMessage = {
      id: messages.length + 1,
      role: 'USER',
      content: messageContent,
    };

    // Optimistic update: show user message immediately
    setMessages(prev => [...prev, userMessage]);
    pendingUserMessageRef.current = messageContent;
    // Snapshot current exploration step count so real-time indicator only shows NEW steps
    explorationStepBaseRef.current = (initialMessages || []).filter(
      m => m.role === 'system' && m.metadata?.isExplorationStep
    ).length;
    setSending(true);

    try {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'sendMessage',
          attemptId,
          content: messageContent,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // The POST blocks until ai-agent saves the response, so it's in DB now.
      pendingUserMessageRef.current = null;
      setSending(false);
      revalidateRef.current();
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = {
        id: messages.length + 2,
        role: 'ASSISTANT',
        content: "I'm having trouble connecting right now. Please try again in a moment.",
      };
      setMessages(prev => [...prev, errorMessage]);
      pendingUserMessageRef.current = null;
      setSending(false);
    }
  };

  const handleQuickAction = async action => {
    if (!attemptId) {
      return;
    }

    const userMessage = {
      id: messages.length + 1,
      role: 'USER',
      content: action,
    };

    setMessages(prev => [...prev, userMessage]);
    pendingUserMessageRef.current = action;
    // Snapshot current exploration step count so real-time indicator only shows NEW steps
    explorationStepBaseRef.current = (initialMessages || []).filter(
      m => m.role === 'system' && m.metadata?.isExplorationStep
    ).length;
    setSending(true);

    try {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _action: 'sendMessage',
          attemptId,
          content: action,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      pendingUserMessageRef.current = null;
      setSending(false);
      revalidateRef.current();
    } catch (error) {
      console.error('Error sending quick action:', error);
      const errorMessage = {
        id: messages.length + 2,
        role: 'ASSISTANT',
        content: "I'm having trouble connecting right now. Please try again in a moment.",
      };
      setMessages(prev => [...prev, errorMessage]);
      pendingUserMessageRef.current = null;
      setSending(false);
    }
  };

  // Derive real-time exploration steps from SYSTEM messages in the DB
  // Only include steps AFTER the base count (set when a send starts) so the
  // real-time indicator shows only steps from the current operation, not history.
  const explorationSteps = useMemo(() => {
    if (!initialMessages) return [];
    const allSteps = initialMessages
      .filter(m => m.role === 'system' && m.metadata?.isExplorationStep);
    // During sends, slice off steps that existed before the send started
    const newSteps = sending ? allSteps.slice(explorationStepBaseRef.current) : allSteps;
    return newSteps.map(m => ({
      action: m.content,
      toolName: m.metadata.toolName,
      toolInput: m.metadata.toolInput,
      timestamp: m.timestamp ? new Date(m.timestamp).getTime() : 0,
    }));
  }, [initialMessages, sending]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QuizMessageList
          messages={messages}
          loading={loading || sending}
          isDarkMode={isDarkMode}
          userLogin={userLogin}
          onQuickAction={readOnly ? null : handleQuickAction}
          readOnly={readOnly}
          showTimestamps={showTimestamps}
          explorationSteps={(loading || sending) ? explorationSteps : []}
          isQuizComplete={isQuizComplete}
          evaluationData={evaluationData}
          focusMetrics={focusMetrics || completionFocusMetrics}
          questionCount={quiz?.question_count || 0}
        />
      </div>

      {!readOnly && (
        <div
          style={{
            borderTop: isDarkMode ? '1px solid #374151' : '1px solid #f0f0f0',
            paddingTop: 16,
            marginTop: 16,
          }}
        >
          <div
            style={{
              opacity: isQuizComplete ? 0.5 : 1,
              pointerEvents: isQuizComplete ? 'none' : 'auto',
            }}
          >
            <ChatEditor
              onSubmit={handleSend}
              loading={loading || sending}
              disabled={isQuizComplete}
              placeholder={
                isQuizComplete
                  ? 'Quiz completed!'
                  : 'Type your response... (use Code button to add code snippets)'
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default QuizAttemptInterface;
