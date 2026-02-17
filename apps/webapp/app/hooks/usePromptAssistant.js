import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Hook for managing prompt assistant conversations
 * Handles SSE streaming, message state, and suggestions
 */
export function usePromptAssistant({ classroomSlug }) {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [explorationSteps, setExplorationSteps] = useState([]);
  const [latestSuggestions, setLatestSuggestions] = useState(null);
  const [error, setError] = useState(null);
  const [hasCodeExploration, setHasCodeExploration] = useState(false);

  const eventSourceRef = useRef(null);

  /**
   * Initialize a new prompt assistant session
   */
  const initSession = useCallback(
    async (formContext, exampleRepoUrl = null) => {
      setIsInitializing(true);
      setError(null);

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

        const result = await response.json();

        if (!response.ok || result.error) {
          throw new Error(result.error || 'Failed to initialize session');
        }

        setSessionId(result.sessionId);
        setHasCodeExploration(result.hasCodeExploration);

        // Add welcome message
        setMessages([
          {
            id: 'welcome',
            role: 'assistant',
            content: result.message,
            timestamp: Date.now(),
          },
        ]);

        // Start SSE stream
        connectToStream(result.sessionId);

        return result;
      } catch (err) {
        setError(err.message);
        throw err;
      } finally {
        setIsInitializing(false);
      }
    },
    [classroomSlug]
  );

  /**
   * Connect to SSE stream for real-time updates
   */
  const connectToStream = useCallback(sid => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/quiz/prompt-assistant/stream/${sid}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('connected', () => {});

    eventSource.addEventListener('exploration_step', event => {
      const data = JSON.parse(event.data);
      setExplorationSteps(prev => [...prev.slice(-9), data]); // Keep last 10
    });

    eventSource.addEventListener('assistant_response', event => {
      const data = JSON.parse(event.data);
      setIsStreaming(false);
      setExplorationSteps([]);

      // Add assistant message
      const newMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
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

    eventSource.addEventListener('error', event => {
      const data = event.data ? JSON.parse(event.data) : {};
      setError(data.error || 'Connection error');
      setIsStreaming(false);
    });

    eventSource.addEventListener('done', () => {
      eventSource.close();
    });

    eventSource.onerror = () => {};
  }, []);

  /**
   * Send a message to the assistant
   */
  const sendMessage = useCallback(
    async content => {
      if (!sessionId || !content.trim()) return;

      setIsStreaming(true);
      setError(null);
      setExplorationSteps([]);

      // Add user message immediately
      const userMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
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

        const result = await response.json();

        if (!response.ok || result.error) {
          throw new Error(result.error || 'Failed to send message');
        }

        // Response will come via SSE
      } catch (err) {
        setError(err.message);
        setIsStreaming(false);
      }
    },
    [sessionId, classroomSlug]
  );

  /**
   * End the session
   */
  const endSession = useCallback(async () => {
    if (!sessionId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    try {
      const formData = new FormData();
      formData.append('_action', 'endSession');
      formData.append('classroomSlug', classroomSlug);
      formData.append('sessionId', sessionId);

      await fetch('/api/quiz/prompt-assistant', {
        method: 'POST',
        body: formData,
      });
    } catch {
      // Cleanup is best-effort
    }

    setSessionId(null);
    setMessages([]);
    setLatestSuggestions(null);
    setExplorationSteps([]);
    setHasCodeExploration(false);
  }, [sessionId, classroomSlug]);

  /**
   * Restart session with code exploration enabled
   * Ends current session and re-initializes with example repo URL
   */
  const restartWithCodeExploration = useCallback(
    async (formContext, exampleRepoUrl) => {
      if (!exampleRepoUrl) {
        setError('No example repository URL provided');
        return;
      }

      // End existing session if active
      if (sessionId) {
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }

        try {
          const formData = new FormData();
          formData.append('_action', 'endSession');
          formData.append('classroomSlug', classroomSlug);
          formData.append('sessionId', sessionId);

          await fetch('/api/quiz/prompt-assistant', {
            method: 'POST',
            body: formData,
          });
        } catch {
          // Cleanup is best-effort
        }

        setSessionId(null);
        setMessages([]);
        setLatestSuggestions(null);
        setExplorationSteps([]);
      }

      // Re-initialize with code exploration
      return initSession(formContext, exampleRepoUrl);
    },
    [sessionId, classroomSlug, initSession]
  );

  /**
   * Clear conversation and start fresh (keeps session)
   */
  const clearConversation = useCallback(() => {
    setMessages([]);
    setLatestSuggestions(null);
    setExplorationSteps([]);
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
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
    endSession,
    clearConversation,
    restartWithCodeExploration,
  };
}
