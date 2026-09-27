import { useState, useCallback, useRef, useEffect } from 'react';
import { serverErrorLine } from '~/utils/serverErrorLine';

interface UsePromptAssistantOptions {
  classroomSlug: string;
}

interface PromptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  suggestions?: PromptSuggestion[];
  explorationSteps?: ExplorationStep[];
  timestamp: number;
}

interface PromptSuggestion {
  [key: string]: unknown;
}

interface ExplorationStep {
  action: string;
  toolName: string;
  [key: string]: unknown;
}

interface FormContext {
  [key: string]: unknown;
}

/**
 * What the assistant shows when a request fails and the server sent no line of
 * its own (see serverErrorLine: a reply's `message`, else an `error` that is
 * text rather than a bare code). An exception's text (a network failure, a body
 * that isn't JSON) is never shown.
 */
const INIT_FAILED = "The prompt assistant couldn't start. Please try again.";
const SEND_FAILED = 'Could not send your message. Please try again.';

/**
 * What the assistant shows once no answer can arrive in this conversation (its
 * stream has closed). The "New conversation" button is the way forward; it is
 * the same line the server sends for a session it no longer holds.
 */
const CONVERSATION_ENDED = 'This conversation has ended. Start a new one to keep going.';

/** Tell the server a session is over. Callers decide whether to wait for it. */
const postEndSession = (classroomSlug: string, sessionId: string) => {
  const formData = new FormData();
  formData.append('_action', 'endSession');
  formData.append('classroomSlug', classroomSlug);
  formData.append('sessionId', sessionId);

  return fetch('/api/quiz/prompt-assistant', {
    method: 'POST',
    body: formData,
  });
};

/**
 * Hook for managing prompt assistant conversations
 * Handles SSE streaming, message state, and suggestions
 */
export function usePromptAssistant({ classroomSlug }: UsePromptAssistantOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PromptMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [explorationSteps, setExplorationSteps] = useState<ExplorationStep[]>([]);
  const [latestSuggestions, setLatestSuggestions] = useState<PromptSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasCodeExploration, setHasCodeExploration] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  // The stream replays buffered replies on every reconnect; a reply already
  // shown is skipped by its messageId.
  const seenReplyIdsRef = useRef<Set<string>>(new Set());
  // The live session for the unmount cleanup, which runs outside any render.
  const sessionIdRef = useRef<string | null>(null);
  // Bumped by each start and by unmount. A start that resolves after either
  // has been superseded: it ends the session it opened instead of showing it.
  const initSeqRef = useRef(0);

  /**
   * Close the stream for good: no reply can arrive in this conversation.
   */
  const stopStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  /**
   * Initialize a new prompt assistant session
   */
  const initSession = useCallback(
    async (formContext: FormContext, exampleRepoUrl: string | null = null) => {
      const seq = ++initSeqRef.current;
      const isCurrent = () => seq === initSeqRef.current;
      setIsInitializing(true);
      setError(null);
      let failure = INIT_FAILED;

      try {
        const formData = new FormData();
        formData.append('_action', 'initSession');
        formData.append('classroomSlug', classroomSlug);
        formData.append('formContext', JSON.stringify(formContext));
        if (exampleRepoUrl) {
          formData.append('exampleRepoUrl', exampleRepoUrl);
        }

        const response = await fetch('/api/quiz/prompt-assistant', {
          method: 'POST',
          body: formData,
        });

        // A body that isn't JSON (an error page) reads as no body at all.
        const result = await response.json().catch(() => null);

        if (!response.ok || !result || result.error) {
          failure = serverErrorLine(result) ?? INIT_FAILED;
          throw new Error(`initSession failed (${response.status})`);
        }

        // Superseded while starting (the panel unmounted, or another start
        // began): end the session this start opened rather than leave it open.
        if (!isCurrent()) {
          postEndSession(classroomSlug, result.sessionId).catch(() => {});
          return null;
        }

        sessionIdRef.current = result.sessionId;
        seenReplyIdsRef.current = new Set();
        setSessionId(result.sessionId);
        setHasCodeExploration(result.hasCodeExploration);

        // Add welcome message
        setMessages([
          { id: 'welcome', role: 'assistant', content: result.message, timestamp: Date.now() },
        ]);

        // Start SSE stream
        connectToStream(result.sessionId);

        return result;
      } catch (err: unknown) {
        if (isCurrent()) setError(failure);
        throw err;
      } finally {
        if (isCurrent()) setIsInitializing(false);
      }
    },
    [classroomSlug]
  );

  /**
   * Connect to SSE stream for real-time updates
   */
  const connectToStream = useCallback(
    (sid: string) => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // `org` lets the stream authorize a session this server has no record of
      // (after a webapp restart).
      const eventSource = new EventSource(
        `/api/quiz/prompt-assistant/stream/${sid}?org=${encodeURIComponent(classroomSlug)}`
      );
      eventSourceRef.current = eventSource;

      eventSource.addEventListener('exploration_step', event => {
        const data = JSON.parse(event.data);
        setExplorationSteps(prev => [...prev.slice(-9), data]); // Keep last 10
      });

      eventSource.addEventListener('assistant_response', event => {
        const data = JSON.parse(event.data);

        // A replay of a reply already shown: nothing changes.
        if (data.messageId) {
          if (seenReplyIdsRef.current.has(data.messageId)) return;
          seenReplyIdsRef.current.add(data.messageId);
        }

        setIsStreaming(false);
        setExplorationSteps([]);

        // Add assistant message
        const newMessage: PromptMessage = {
          id: data.messageId ?? `msg-${Date.now()}`,
          role: 'assistant' as const,
          content: data.content,
          suggestions: data.suggestions,
          explorationSteps: data.explorationSteps,
          timestamp: Date.now(),
        };

        setMessages(prev => [...prev, newMessage]);

        // Store latest suggestions for easy access
        if (data.suggestions?.length > 0) {
          setLatestSuggestions(data.suggestions[0]);
        }
      });

      // Two failures arrive on this one listener: a server-sent `event: error`
      // (carries a JSON payload) and a transport failure (carries nothing). The
      // copy is fixed for both.
      eventSource.addEventListener('error', event => {
        const messageEvent = event as MessageEvent;

        if (messageEvent.data) {
          let payload: unknown = null;
          try {
            payload = JSON.parse(messageEvent.data);
          } catch {
            // A non-JSON body is still a failure; report it with fixed copy.
          }
          const line = serverErrorLine(payload) ?? SEND_FAILED;
          // A lost session: stop here rather than reconnect and replay.
          if (line === CONVERSATION_ENDED) stopStream();
          setError(line);
          setIsStreaming(false);
          return;
        }

        // Transport failure. EventSource reconnects from transient drops on its
        // own, so only CLOSED means no answer can arrive.
        if (eventSource.readyState === EventSource.CLOSED) {
          stopStream();
          setError(CONVERSATION_ENDED);
          setIsStreaming(false);
        }
      });

      eventSource.addEventListener('done', () => {
        eventSource.close();
      });

      eventSource.onerror = () => {};
    },
    [classroomSlug, stopStream]
  );

  /**
   * Send a message to the assistant
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId || !content.trim()) return;

      // The POST only acknowledges receipt; the reply comes back over SSE. A
      // stream still connecting will do (the server replays what it missed);
      // a closed one could never deliver the reply, or clear isStreaming.
      const stream = eventSourceRef.current;
      if (!stream || stream.readyState === EventSource.CLOSED) {
        setError(CONVERSATION_ENDED);
        return;
      }

      setIsStreaming(true);
      setError(null);
      setExplorationSteps([]);

      // Add user message immediately
      const userMessage: PromptMessage = {
        id: `msg-${Date.now()}`,
        role: 'user' as const,
        content,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, userMessage]);

      try {
        const formData = new FormData();
        formData.append('_action', 'sendMessage');
        formData.append('classroomSlug', classroomSlug);
        formData.append('sessionId', sessionId);
        formData.append('content', content);

        const response = await fetch('/api/quiz/prompt-assistant', {
          method: 'POST',
          body: formData,
        });

        // A body that isn't JSON (an error page) reads as no body at all.
        const result = await response.json().catch(() => null);

        // A new conversation began meanwhile; this outcome was the old one's.
        if (sessionIdRef.current !== sessionId) return;

        if (!response.ok || !result || result.error) {
          const line = serverErrorLine(result) ?? SEND_FAILED;
          if (line === CONVERSATION_ENDED) stopStream();
          setError(line);
          setIsStreaming(false);
        }

        // Response will come via SSE
      } catch {
        if (sessionIdRef.current !== sessionId) return;
        // The request itself failed (network): fixed copy, not its text.
        setError(SEND_FAILED);
        setIsStreaming(false);
      }
    },
    [sessionId, classroomSlug, stopStream]
  );

  /**
   * Close the stream, end the server session and clear the conversation.
   * Ending is best-effort: a failed request still clears the panel.
   */
  const closeSession = useCallback(async () => {
    stopStream();
    if (!sessionId) return;
    // No longer the live session: a late reply to a send is ignored from here,
    // and an unmount meanwhile doesn't end it a second time.
    sessionIdRef.current = null;

    try {
      await postEndSession(classroomSlug, sessionId);
    } catch {
      // Cleanup is best-effort
    }

    setSessionId(null);
    setMessages([]);
    setLatestSuggestions(null);
    setExplorationSteps([]);
    setIsStreaming(false);
  }, [sessionId, classroomSlug, stopStream]);

  /**
   * End the current session, then open another. Pending from the start, so a
   * second can't begin meanwhile; if the panel unmounts while the session
   * ends, nothing new opens.
   */
  const startOver = useCallback(
    async (formContext: FormContext, exampleRepoUrl: string | null) => {
      const seq = initSeqRef.current;
      setError(null);
      setIsInitializing(true);
      await closeSession();
      if (seq !== initSeqRef.current) return null;
      return initSession(formContext, exampleRepoUrl);
    },
    [closeSession, initSession]
  );

  /**
   * Start a new conversation: end the current session and open another with
   * the same form context. The repo goes along only if the current session
   * explored it.
   */
  const restart = useCallback(
    (formContext: FormContext, exampleRepoUrl: string | null = null) =>
      startOver(formContext, hasCodeExploration ? exampleRepoUrl : null),
    [startOver, hasCodeExploration]
  );

  /**
   * Restart session with code exploration enabled
   * Ends current session and re-initializes with example repo URL
   */
  const restartWithCodeExploration = useCallback(
    async (formContext: FormContext, exampleRepoUrl: string) => {
      if (!exampleRepoUrl) {
        setError('No example repository URL provided');
        return;
      }

      // Re-initialize with code exploration
      return startOver(formContext, exampleRepoUrl);
    },
    [startOver]
  );

  // Cleanup on unmount: supersede a start still pending, close the stream and
  // end the session without waiting.
  useEffect(() => {
    return () => {
      initSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (sessionIdRef.current) {
        postEndSession(classroomSlug, sessionIdRef.current).catch(() => {});
      }
    };
  }, []);

  return {
    // State
    sessionId,
    messages,
    isStreaming,
    isInitializing,
    explorationSteps,
    latestSuggestions,
    error,
    hasCodeExploration,
    isActive: !!sessionId,

    // Actions
    initSession,
    sendMessage,
    restart,
    restartWithCodeExploration,
  };
}
