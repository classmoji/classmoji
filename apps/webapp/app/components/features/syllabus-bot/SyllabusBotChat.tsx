import { useRef, useEffect, useState, useCallback } from 'react';
import { IconChevronRight, IconFileText, IconBook, IconHelp, IconFile } from '@tabler/icons-react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { buildContentReferenceUrl } from '~/utils/contentReferenceUrl';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: ContentReference[];
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

interface SyllabusBotChatProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  isInitializing: boolean;
  suggestedQuestions: (SuggestedQuestion | string)[];
  error: string | null;
  onSendMessage: (message: string) => void;
  onAskSuggestedQuestion: (question: SuggestedQuestion | string) => void;
  onReset: () => void;
  classroomSlug: string;
  slidesUrl: string;
  userLogin: string | null;
  courseName: string;
}

function useTypewriter(fullText: string, active: boolean) {
  const [revealed, setRevealed] = useState(active ? 0 : fullText.length);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setRevealed(fullText.length);
      return;
    }
    setRevealed(0);
    lastTimeRef.current = 0;

    const words = fullText.split(/(?<=\s)/);
    let wordIndex = 0;
    let charCount = 0;

    const step = (time: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = time;
      const elapsed = time - lastTimeRef.current;

      if (elapsed > 18) {
        lastTimeRef.current = time;
        if (wordIndex < words.length) {
          charCount += words[wordIndex].length;
          wordIndex++;
          setRevealed(charCount);
        }
      }

      if (wordIndex < words.length) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setRevealed(fullText.length);
      }
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [fullText, active]);

  return active ? fullText.slice(0, revealed) : fullText;
}

function TypewriterMessage({
  content,
  isLatest,
  onRevealDone,
  children,
}: {
  content: string;
  isLatest: boolean;
  onRevealDone: () => void;
  children: (text: string) => React.ReactNode;
}) {
  const [revealing, setRevealing] = useState(isLatest);
  const text = useTypewriter(content, revealing);

  useEffect(() => {
    if (revealing && text.length >= content.length) {
      setRevealing(false);
      onRevealDone();
    }
  }, [text, content, revealing, onRevealDone]);

  return <>{children(text)}</>;
}

const SyllabusBotChat = ({
  messages,
  isStreaming,
  isInitializing,
  suggestedQuestions,
  error,
  onSendMessage,
  onAskSuggestedQuestion,
  classroomSlug,
  slidesUrl,
  courseName,
}: SyllabusBotChatProps) => {
  const [inputValue, setInputValue] = useState('');
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set(['welcome']));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!isInitializing) {
      inputRef.current?.focus();
    }
  }, [isInitializing]);

  const handleSend = () => {
    if (!inputValue.trim() || isStreaming) return;
    onSendMessage(inputValue.trim());
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleHint = (question: SuggestedQuestion | string) => {
    if (isStreaming) return;
    onAskSuggestedQuestion(question);
  };

  const markRevealed = useCallback((id: string) => {
    setRevealedIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const getReferenceIcon = (type: string) => {
    switch (type) {
      case 'page': return <IconFileText size={13} />;
      case 'slides': return <IconBook size={13} />;
      case 'platform_docs': return <IconHelp size={13} />;
      default: return <IconFile size={13} />;
    }
  };

  const hasUserMessages = messages.some(m => m.role === 'user');
  const visibleMessages = messages.filter(m => !(m.id === 'welcome' && !hasUserMessages));
  const lastAssistantId = [...visibleMessages].reverse().find(m => m.role === 'assistant')?.id;

  return (
    <>
      {/* Scrollable body */}
      <div className="askmoji-body">
        {/* Course header */}
        <div className="askmoji-course-name">{courseName}</div>
        <div className="askmoji-course-sub">Ask about assignments, deadlines, tokens, or the syllabus.</div>

        {/* Hints (empty state) */}
        {!hasUserMessages && suggestedQuestions.length > 0 && (
          <div className="askmoji-hints">
            {suggestedQuestions.map((q, idx) => {
              const text = typeof q === 'string' ? q : q.text || String(q);
              return (
                <button
                  key={idx}
                  type="button"
                  className="askmoji-hint"
                  onClick={() => handleHint(q)}
                  disabled={isStreaming}
                >
                  <IconChevronRight size={11} />
                  <span>{text}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Messages */}
        {visibleMessages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'user' ? (
              <div className="askmoji-msg askmoji-msg--user">
                <span className="askmoji-chevron">&#x276F;</span>
                <span className="askmoji-user-text">{msg.content}</span>
              </div>
            ) : (
              <TypewriterMessage
                content={msg.content}
                isLatest={msg.id === lastAssistantId && !revealedIds.has(msg.id)}
                onRevealDone={() => markRevealed(msg.id)}
              >
                {(text) => (
                  <div className="askmoji-msg askmoji-msg--moji">
                    <ReactMarkdown
                      rehypePlugins={[rehypeHighlight]}
                      components={{
                        p: ({ children }) => <p>{children}</p>,
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                        ),
                        ul: ({ children }) => <ul>{children}</ul>,
                        ol: ({ children }) => <ol>{children}</ol>,
                        li: ({ children }) => <li>{children}</li>,
                      }}
                    >
                      {text}
                    </ReactMarkdown>

                    {/* Content references -- only show after fully revealed */}
                    {revealedIds.has(msg.id) && msg.references && msg.references.length > 0 && (
                      <div className="askmoji-refs">
                        {msg.references.map((ref, idx) => {
                          const url = buildContentReferenceUrl(ref, classroomSlug, slidesUrl);
                          return (
                            <a
                              key={idx}
                              href={url || '#'}
                              target={url ? '_blank' : undefined}
                              rel="noopener noreferrer"
                              className="askmoji-ref"
                            >
                              {getReferenceIcon(ref.referenceType)}
                              {ref.displayText}
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </TypewriterMessage>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {isStreaming && (
          <div className="askmoji-typing">
            <div className="askmoji-typing-dot" />
            <div className="askmoji-typing-dot" />
            <div className="askmoji-typing-dot" />
          </div>
        )}

        {/* Error */}
        {error && <div className="askmoji-error">{error}</div>}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="askmoji-input-bar" onClick={() => inputRef.current?.focus()}>
        <span className="askmoji-chevron">&#x276F;</span>
        <div className="askmoji-input-wrap">
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || isInitializing}
          />
          {inputValue ? (
            <span className="askmoji-input-display">
              {inputValue}
              {!isStreaming && !isInitializing && <span className="askmoji-cursor" />}
            </span>
          ) : (
            <span className="askmoji-input-display askmoji-input-display--empty">
              Ask about the course...
            </span>
          )}
        </div>
      </div>
    </>
  );
};

export default SyllabusBotChat;
