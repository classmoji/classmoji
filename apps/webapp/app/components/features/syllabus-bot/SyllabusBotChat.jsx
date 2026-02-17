import { useRef, useEffect, useState } from 'react';
import { Typography, Space, Tag, Avatar } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { IconFileText, IconBook, IconHelp, IconFile, IconSend } from '@tabler/icons-react';
import { TypingIndicator } from '~/components';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { buildContentReferenceUrl } from '~/utils/contentReferenceUrl';
import theme from '~/config/theme';

const { Text } = Typography;

/**
 * SyllabusBotChat - Chat interface for the syllabus bot
 */
const SyllabusBotChat = ({
  messages,
  isStreaming,
  suggestedQuestions,
  error,
  onSendMessage,
  onAskSuggestedQuestion,
  classroomSlug,
  slidesUrl,
  userLogin,
  isDarkMode = false,
}) => {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    if (!inputValue.trim() || isStreaming) return;
    onSendMessage(inputValue.trim());
    setInputValue('');
  };

  const handleKeyPress = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestedQuestion = question => {
    if (isStreaming) return;
    onAskSuggestedQuestion(question);
  };

  // Get icon for reference type
  const getReferenceIcon = type => {
    switch (type) {
      case 'page':
        return <IconFileText size={16} />;
      case 'slides':
        return <IconBook size={16} />;
      case 'platform_docs':
        return <IconHelp size={16} />;
      // Deprecated types (backwards compatibility)
      case 'assignment':
        return <IconFileText size={16} />;
      case 'syllabus':
        return <IconBook size={16} />;
      default:
        return <IconFile size={16} />;
    }
  };

  // Render content references as clickable links
  const renderReferences = references => {
    if (!references || references.length === 0) return null;

    return (
      <div
        style={{
          marginTop: '12px',
          padding: '8px 12px',
          backgroundColor: isDarkMode ? '#1a2433' : '#f5f5f5',
          borderRadius: '6px',
          border: isDarkMode ? '1px solid #2d3748' : '1px solid #e0e0e0',
        }}
      >
        <Text
          style={{
            fontSize: '12px',
            color: isDarkMode ? '#9ca3af' : '#666',
            fontWeight: 500,
            display: 'block',
            marginBottom: '6px',
          }}
        >
          Related Content:
        </Text>
        <Space wrap>
          {references.map((ref, idx) => {
            const url = buildContentReferenceUrl(ref, classroomSlug, slidesUrl);
            return (
              <a
                key={idx}
                href={url || '#'}
                target={url ? '_blank' : undefined}
                rel="noopener noreferrer"
                style={{ textDecoration: 'none' }}
              >
                <Tag
                  icon={getReferenceIcon(ref.referenceType)}
                  color={isDarkMode ? 'blue-inverse' : 'blue'}
                  style={{ cursor: 'pointer' }}
                >
                  {ref.displayText}
                </Tag>
              </a>
            );
          })}
        </Space>
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: isDarkMode ? '#111827' : '#fff',
      }}
    >
      {/* Messages Area */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {messages.map(msg => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              gap: '12px',
              alignItems: 'flex-start',
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
            }}
          >
            {/* Avatar */}
            {msg.role === 'user' ? (
              userLogin ? (
                <Avatar
                  src={`https://github.com/${userLogin}.png?size=40`}
                  style={{ backgroundColor: '#52c41a', flexShrink: 0 }}
                >
                  {userLogin[0]?.toUpperCase()}
                </Avatar>
              ) : (
                <Avatar
                  icon={<UserOutlined />}
                  style={{ backgroundColor: '#52c41a', flexShrink: 0 }}
                />
              )
            ) : (
              <Avatar
                style={{
                  backgroundColor: '#fffdf5',
                  fontSize: '20px',
                  flexShrink: 0,
                  border: '1px solid #ffd66b',
                }}
              >
                📚
              </Avatar>
            )}

            {/* Message Content */}
            <div
              style={{
                maxWidth: '80%',
                backgroundColor:
                  msg.role === 'user'
                    ? isDarkMode
                      ? '#374151'
                      : '#f0f2f5'
                    : isDarkMode
                      ? '#1f2937'
                      : '#fff',
                padding: '12px 16px',
                borderRadius: '8px',
                border:
                  msg.role === 'assistant'
                    ? isDarkMode
                      ? '1px solid #4b5563'
                      : '1px solid #d9d9d9'
                    : 'none',
              }}
            >
              <div
                style={{
                  color: isDarkMode ? '#e5e7eb' : '#1f2937',
                  lineHeight: 1.6,
                }}
              >
                <ReactMarkdown
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    p: ({ children }) => <p style={{ margin: 0, lineHeight: 1.6 }}>{children}</p>,
                    code: ({ inline, children, ...props }) =>
                      inline ? (
                        <code
                          style={{
                            backgroundColor: isDarkMode ? '#374151' : '#f0f2f5',
                            color: isDarkMode ? '#e5e7eb' : 'inherit',
                            padding: '2px 4px',
                            borderRadius: '3px',
                            fontFamily: 'monospace',
                            fontSize: '0.9em',
                          }}
                          {...props}
                        >
                          {children}
                        </code>
                      ) : (
                        <code {...props}>{children}</code>
                      ),
                    pre: ({ children, ...props }) => (
                      <pre
                        style={{
                          backgroundColor: isDarkMode ? '#0d1117' : '#f6f8fa',
                          color: isDarkMode ? '#e5e7eb' : 'inherit',
                          padding: '12px',
                          borderRadius: '6px',
                          overflow: 'auto',
                          margin: '8px 0',
                          fontFamily: 'monospace',
                          fontSize: '13px',
                        }}
                        {...props}
                      >
                        {children}
                      </pre>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: theme.PRIMARY,
                        }}
                      >
                        {children}
                      </a>
                    ),
                    ul: ({ children }) => (
                      <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ul>
                    ),
                    li: ({ children }) => <li style={{ marginBottom: '4px' }}>{children}</li>,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>

              {/* Content References */}
              {msg.references && renderReferences(msg.references)}
            </div>
          </div>
        ))}

        {/* Streaming Indicator */}
        {isStreaming && (
          <div
            style={{
              display: 'flex',
              gap: '12px',
              alignItems: 'flex-start',
            }}
          >
            <Avatar
              style={{
                backgroundColor: '#fffdf5',
                fontSize: '20px',
                flexShrink: 0,
                border: '1px solid #ffd66b',
              }}
            >
              📚
            </Avatar>
            <div
              style={{
                backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                padding: '12px 16px',
                borderRadius: '8px',
                border: isDarkMode ? '1px solid #4b5563' : '1px solid #d9d9d9',
              }}
            >
              <Space align="center">
                <TypingIndicator color="#fadb14" />
                <Text
                  style={{
                    color: isDarkMode ? '#9ca3af' : '#666',
                    marginLeft: 4,
                  }}
                >
                  Thinking...
                </Text>
              </Space>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: isDarkMode ? '#451a03' : '#fff1f0',
              border: isDarkMode ? '1px solid #78350f' : '1px solid #ffccc7',
              borderRadius: '8px',
              color: isDarkMode ? '#fca5a5' : '#cf1322',
            }}
          >
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Questions (shown when not streaming and few messages) */}
      {suggestedQuestions.length > 0 && messages.length <= 2 && !isStreaming && (
        <div
          style={{
            padding: '8px 16px',
            borderTop: isDarkMode ? '1px solid #1f2937' : '1px solid #f0f0f0',
          }}
        >
          <Text
            style={{
              fontSize: '12px',
              color: isDarkMode ? '#9ca3af' : '#666',
              display: 'block',
              marginBottom: '8px',
            }}
          >
            Suggested questions:
          </Text>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {suggestedQuestions.map((q, idx) => (
              <button
                key={idx}
                onClick={() => handleSuggestedQuestion(q)}
                disabled={isStreaming}
                style={{
                  padding: '6px 12px',
                  border: isDarkMode ? '1px solid #374151' : '1px solid #d9d9d9',
                  backgroundColor: isDarkMode ? '#1f2937' : '#fafafa',
                  color: isDarkMode ? '#d1d5db' : 'inherit',
                  borderRadius: '16px',
                  fontSize: '13px',
                  cursor: isStreaming ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {q.text || q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Area */}
      <div
        style={{
          position: 'relative',
          padding: '12px 0 0 0',
          background: 'transparent',
        }}
        className="mx-4 mb-4"
      >
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Ask about the course..."
          rows={1}
          disabled={isStreaming}
          style={{
            width: '100%',
            padding: '12px 50px 12px 16px',
            border: isDarkMode ? '1px solid #374151' : '1px solid #d9d9d9',
            backgroundColor: isDarkMode ? '#1f2937' : '#fff',
            color: isDarkMode ? '#e5e7eb' : '#1a1a1a',
            borderRadius: '24px',
            fontSize: '14px',
            fontFamily: 'inherit',
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
            transition: 'border-color 0.15s',
            minHeight: '46px',
          }}
          onFocus={e => (e.target.style.borderColor = '#1f883d')}
          onBlur={e => (e.target.style.borderColor = isDarkMode ? '#374151' : '#d9d9d9')}
        />
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || isStreaming}
          style={{
            position: 'absolute',
            right: '8px',
            top: 'calc(12px + 23px)',
            transform: 'translateY(-50%)',
            width: '28px',
            height: '28px',
            border: 'none',
            backgroundColor:
              inputValue.trim() && !isStreaming ? '#10b981' : isDarkMode ? '#374151' : '#d9d9d9',
            color: inputValue.trim() && !isStreaming ? '#fff' : isDarkMode ? '#9ca3af' : '#666',
            borderRadius: '50%',
            cursor: inputValue.trim() && !isStreaming ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.15s',
            fontSize: '12px',
          }}
          onMouseEnter={e => {
            if (inputValue.trim() && !isStreaming) {
              e.target.style.backgroundColor = '#d4a216';
            }
          }}
          onMouseLeave={e => {
            if (inputValue.trim() && !isStreaming) {
              e.target.style.backgroundColor = '#10b981';
            }
          }}
        >
          {isStreaming ? '...' : <IconSend size={16} />}
        </button>
      </div>
    </div>
  );
};

export default SyllabusBotChat;
