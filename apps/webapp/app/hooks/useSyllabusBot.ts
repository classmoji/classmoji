import { useState, useCallback, useRef, useEffect } from 'react';
import { processResponseReferences } from '~/utils/contentReferenceUrl';
import { browserTimeZone } from '~/utils/browserTimeZone';
import { serverErrorLine } from '~/utils/serverErrorLine';

/**
 * Hook for managing syllabus bot conversations
 * Handles SSE streaming, message state, content references, and suggested questions
 */
interface UseSyllabusBotOptions {
  classroomSlug: string;
  userRole?: string;
}

interface BotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: ContentReference[];
  timestamp: number;
}

interface ContentReference {
  referenceType: string;
  contentPath: string;
  displayText: string;
  [key: string]: unknown;
}

interface SuggestedQuestion {
  text?: string;
  [key: string]: unknown;
}

/**
 * What the widget shows when a request fails and the server sent no line of its
 * own (see serverErrorLine: a reply's `message`, else an `error` that is text
 * rather than a bare code). An exception's text (a network failure, a body that
 * isn't JSON) is never shown.
 */
const INIT_FAILED = 'Could not start the assistant. Please try again.';
const SEND_FAILED = 'Could not send your message. Please try again.';

/**
 * What the widget shows once no answer can arrive in this conversation (its
 * stream has closed). The "New conversation" button is the way forward; it is
 * the same line the server sends for a session it no longer holds.
 */
const CONVERSATION_ENDED = 'This conversation has ended. Start a new one to keep asking.';

export function useSyllabusBot({ classroomSlug, userRole }: UseSyllabusBotOptions) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<SuggestedQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasContentRepo, setHasContentRepo] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  // Answers only ever arrive over SSE, so "is the stream up?" is a precondition
  // for sending, not a cosmetic detail. Tracked in a ref because sendMessage
  // must read it at call time without re-subscribing on every change.
  const streamAliveRef = useRef(false);

  /**
   * Initialize a new syllabus bot conversation
   */
  const initConversation = useCallback(async () => {
    setIsInitializing(true);
    setError(null);
    let failure = INIT_FAILED;

    try {
      const formData = new FormData();
      formData.append('_action', 'initConversation');
      if (userRole) {
        formData.append('userRole', userRole);
      }
      // The student's own zone, sent once at session start. Used only when the
      // classroom has no time zone set; the server validates it.
      const zone = browserTimeZone();
      if (zone) formData.append('browserTimezone', zone);

      const response = await fetch(`/api/syllabus-bot/${classroomSlug}`, {
        method: 'POST',
        body: formData,
      });

      // A body that isn't JSON (an error page) reads as no body at all.
      const result = await response.json().catch(() => null);

      if (!response.ok || !result || result.error) {
        failure = serverErrorLine(result) ?? INIT_FAILED;
        throw new Error(`initConversation failed (${response.status})`);
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
    } catch (err: unknown) {
      setError(failure);
      throw err;
    } finally {
      setIsInitializing(false);
    }
  }, [classroomSlug, userRole]);

  /**
   * Connect to SSE stream for real-time updates
   */
  const connectToStream = useCallback(
    (convId: string) => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(`/api/syllabus-bot/stream/${convId}`);
      eventSourceRef.current = eventSource;
      streamAliveRef.current = false;

      eventSource.addEventListener('connected', () => {
        streamAliveRef.current = true;
      });

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
        const newMessage: BotMessage = {
          id: `msg-${Date.now()}`,
          role: 'assistant' as const,
          content: cleanContent,
          references: data.references || [],
          timestamp: Date.now(),
        };

        setMessages(prev => [...prev, newMessage]);
      });

      // Two unrelated failures arrive on this one listener: a server-sent
      // `event: error` (carries a JSON payload) and a transport failure
      // (carries nothing). They need different handling.
      eventSource.addEventListener('error', event => {
        const messageEvent = event as MessageEvent;

        if (messageEvent.data) {
          let payload: unknown = null;
          try {
            payload = JSON.parse(messageEvent.data);
          } catch {
            // A non-JSON body is still a failure — just don't take the
            // listener down on the way to reporting it.
          }
          setError(serverErrorLine(payload) ?? 'Ask Moji hit an error.');
          setIsStreaming(false);
          return;
        }

        // Transport failure. EventSource retries transient drops on its own,
        // so only CLOSED is terminal — and that is exactly the case where no
        // answer can ever arrive, so the composer has to be released instead
        // of sitting disabled forever.
        if (eventSource.readyState === EventSource.CLOSED) {
          streamAliveRef.current = false;
          setError(CONVERSATION_ENDED);
          setIsStreaming(false);
        }
      });

      eventSource.addEventListener('done', () => {
        streamAliveRef.current = false;
        eventSource.close();
      });
    },
    [classroomSlug]
  );

  /**
   * Send a message to the syllabus bot
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!conversationId || !content.trim()) return;

      // The POST only acknowledges receipt; the reply comes back over SSE. If
      // that stream is down, sending would set isStreaming with nothing left
      // that could ever clear it — which is what left the input permanently
      // disabled instead of showing a failure.
      if (!streamAliveRef.current) {
        setError(CONVERSATION_ENDED);
        return;
      }

      setIsStreaming(true);
      setError(null);

      // Add user message immediately
      const userMessage: BotMessage = {
        id: `msg-${Date.now()}`,
        role: 'user' as const,
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

        // A body that isn't JSON (an error page) reads as no body at all.
        const result = await response.json().catch(() => null);

        if (!response.ok || !result || result.error) {
          setError(serverErrorLine(result) ?? SEND_FAILED);
          setIsStreaming(false);
        }

        // Response will come via SSE
      } catch {
        // The request itself failed (network): fixed copy, not its text.
        setError(SEND_FAILED);
        setIsStreaming(false);
      }
    },
    [conversationId, classroomSlug]
  );

  /**
   * Send a suggested question
   */
  const askSuggestedQuestion = useCallback(
    async (question: string | SuggestedQuestion) => {
      const text = typeof question === 'string' ? question : (question.text ?? '');
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
    streamAliveRef.current = false;

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
