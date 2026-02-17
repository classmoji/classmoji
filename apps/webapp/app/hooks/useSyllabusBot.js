import { useState, useCallback, useRef, useEffect } from 'react';
import { processResponseReferences } from '~/utils/contentReferenceUrl';

/**
 * Hook for managing syllabus bot conversations
 * Handles SSE streaming, message state, content references, and suggested questions
 */
export function useSyllabusBot({ classroomSlug, userRole }) {
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState([]);
  const [error, setError] = useState(null);
  const [hasContentRepo, setHasContentRepo] = useState(false);

  const eventSourceRef = useRef(null);

  /**
   * Initialize a new syllabus bot conversation
   */
  const initConversation = useCallback(async () => {
    setIsInitializing(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('_action', 'initConversation');
      if (userRole) {
        formData.append('userRole', userRole);
      }

      const response = await fetch(`/api/syllabus-bot/${classroomSlug}`, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        throw new Error(result.error || 'Failed to initialize conversation');
      }

      setConversationId(result.conversationId);
      setHasContentRepo(result.hasContentRepo);
      setSuggestedQuestions(result.suggestedQuestions || []);

      // Add welcome message
      setMessages([
        {
          id: 'welcome',
          role: 'assistant',
          content: result.welcomeMessage,
          references: [],
          timestamp: Date.now(),
        },
      ]);

      // Start SSE stream
      connectToStream(result.conversationId);

      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setIsInitializing(false);
    }
  }, [classroomSlug, userRole]);

  /**
   * Connect to SSE stream for real-time updates
   */
  const connectToStream = useCallback(convId => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/syllabus-bot/stream/${convId}`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('connected', () => {});

    eventSource.addEventListener('assistant_response', event => {
      const data = JSON.parse(event.data);
      setIsStreaming(false);

      // Process content to clean up embedded reference JSON
      const cleanContent = processResponseReferences(
        data.content,
        data.references,
        classroomSlug
      );

      // Add assistant message
      const newMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: cleanContent,
        references: data.references || [],
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, newMessage]);
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
  }, [classroomSlug]);

  /**
   * Send a message to the syllabus bot
   */
  const sendMessage = useCallback(
    async content => {
      if (!conversationId || !content.trim()) return;

      setIsStreaming(true);
      setError(null);

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
        formData.append('conversationId', conversationId);
        formData.append('content', content);

        const response = await fetch(`/api/syllabus-bot/${classroomSlug}`, {
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
    [conversationId, classroomSlug]
  );

  /**
   * Send a suggested question
   */
  const askSuggestedQuestion = useCallback(
    async question => {
      const text = typeof question === 'string' ? question : question.text;
      return sendMessage(text);
    },
    [sendMessage]
  );

  /**
   * End the conversation
   */
  const endConversation = useCallback(async () => {
    if (!conversationId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    try {
      const formData = new FormData();
      formData.append('_action', 'endConversation');
      formData.append('conversationId', conversationId);

      await fetch(`/api/syllabus-bot/${classroomSlug}`, {
        method: 'POST',
        body: formData,
      });
    } catch {
      // Cleanup is best-effort
    }

    setConversationId(null);
    setMessages([]);
    setSuggestedQuestions([]);
    setHasContentRepo(false);
  }, [conversationId, classroomSlug]);

  /**
   * Clear conversation and start fresh
   */
  const clearConversation = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  /**
   * Reset and reinitialize
   */
  const reset = useCallback(async () => {
    await endConversation();
    return initConversation();
  }, [endConversation, initConversation]);

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
    conversationId,
    messages,
    isStreaming,
    isInitializing,
    suggestedQuestions,
    error,
    hasContentRepo,
    isActive: !!conversationId,

    // Actions
    initConversation,
    sendMessage,
    askSuggestedQuestion,
    endConversation,
    clearConversation,
    reset,
  };
}
