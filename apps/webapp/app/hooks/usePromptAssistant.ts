import { useState, useCallback, useRef, useEffect } from 'react';

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

  /**
   * Initialize a new prompt assistant session
   */
  const initSession = useCallback(
    async (formContext: FormContext, exampleRepoUrl: string | null = null) => {
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
          { id: 'welcome', role: 'assistant', content: result.message, timestamp: Date.now() },
        ]);

        // Start SSE stream
        connectToStream(result.sessionId);

        return result;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
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
  const connectToStream = useCallback((sid: string) => {
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
      const newMessage: PromptMessage = {
        id: `msg-${Date.now()}`,
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

    eventSource.addEventListener('error', event => {
      const messageEvent = event as MessageEvent;
      const data = messageEvent.data ? JSON.parse(messageEvent.data) : {};
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
    async (content: string) => {
      if (!sessionId || !content.trim()) return;

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

        const result = await response.json();

        if (!response.ok || result.error) {
          throw new Error(result.error || 'Failed to send message');
        }

        // Response will come via SSE
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
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
    async (formContext: FormContext, exampleRepoUrl: string) => {
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
