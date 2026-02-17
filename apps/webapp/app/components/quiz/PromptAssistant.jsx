import { useState, useRef, useEffect } from 'react';
import { Avatar, Button, Typography, Spin, Tag, Tooltip, Collapse } from 'antd';
import {
  SendOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  CodeOutlined,
  FileSearchOutlined,
  SearchOutlined,
  CloseOutlined,
  UserOutlined,
  RocketOutlined,
  BranchesOutlined,
  ExperimentOutlined,
  GithubOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import { usePromptAssistant } from '~/hooks/usePromptAssistant';
import { useUser } from '~/hooks';

import './PromptAssistant.css';

const { Text } = Typography;

/**
 * Chat panel for AI-assisted quiz prompt creation
 */
export function PromptAssistant({
  classroomSlug,
  formContext,
  exampleRepoUrl,
  onApplySuggestion,
  isDarkMode,
  onClose,
}) {
  const {
    messages,
    isStreaming,
    isInitializing,
    explorationSteps,
    error,
    hasCodeExploration,
    isActive,
    initSession,
    sendMessage,
    clearConversation,
    restartWithCodeExploration,
  } = usePromptAssistant({ classroomSlug });

  const { user } = useUser();
  const userLogin = user?.login;

  const [inputValue, setInputValue] = useState('');
  const [copiedField, setCopiedField] = useState(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const textareaRef = useRef(null);

  const showCodeExplorationPrompt =
    exampleRepoUrl && !hasCodeExploration && isActive && !isInitializing;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, explorationSteps]);

  useEffect(() => {
    if (showCodeExplorationPrompt && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [showCodeExplorationPrompt]);

  useEffect(() => {
    if (!isActive && !isInitializing) {
      initSession(formContext, exampleRepoUrl);
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 100) + 'px';
    }
  }, [inputValue]);

  const handleSend = async () => {
    const content = inputValue.trim();
    if (!content || isStreaming) return;
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    await sendMessage(content);
  };

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleApply = suggestion => {
    if (onApplySuggestion && suggestion) onApplySuggestion(suggestion);
  };

  const handleCopy = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleStartCodeExploration = async () => {
    await restartWithCodeExploration(formContext, exampleRepoUrl);
  };

  return (
    <div className={`prompt-assistant ${isDarkMode ? 'dark' : 'light'}`}>
      {/* Header */}
      <div className="pa-header">
        <div className="pa-header-title">
          <span className="pa-header-icon">✨</span>
          <span>Promptmoji</span>
          {hasCodeExploration && (
            <Tag color="gold" style={{ marginLeft: 8, fontSize: 11 }}>
              Code-Aware
            </Tag>
          )}
        </div>
        <div className="pa-header-actions">
          {isActive && (
            <Tooltip title="Clear chat">
              <button className="pa-icon-btn" onClick={clearConversation}>
                <DeleteOutlined />
              </button>
            </Tooltip>
          )}
          <Tooltip title="Close">
            <button className="pa-icon-btn" onClick={onClose}>
              <CloseOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="pa-messages">
        {showCodeExplorationPrompt && (
          <div className="pa-code-banner">
            <CodeOutlined style={{ fontSize: 16 }} />
            <div className="pa-code-banner-text">
              <strong>Repository available</strong>
              <span>Explore code for better prompts</span>
            </div>
            <Button size="small" onClick={handleStartCodeExploration} loading={isInitializing}>
              Explore
            </Button>
          </div>
        )}

        {isInitializing ? (
          <div className="pa-loading">
            <Spin size="small" />
            <span>{hasCodeExploration ? 'Analyzing code...' : 'Starting...'}</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="pa-empty">
            <p>Describe the quiz you want to create and I'll help generate prompts.</p>
            <div className="pa-suggestions">
              <button onClick={() => setInputValue('Create a JavaScript fundamentals quiz')}>
                JavaScript quiz
              </button>
              <button onClick={() => setInputValue('Help me write a rubric for React hooks')}>
                React hooks
              </button>
              <button onClick={() => setInputValue('Quiz about async/await and promises')}>
                Async/Promises
              </button>
            </div>
          </div>
        ) : (
          <>
            {messages.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isDarkMode={isDarkMode}
                userLogin={userLogin}
                onApply={handleApply}
                onCopy={handleCopy}
                copiedField={copiedField}
              />
            ))}
          </>
        )}

        {explorationSteps.length > 0 && <ExplorationSteps steps={explorationSteps} />}

        {isStreaming && (
          <div className="pa-typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}

        {error && <div className="pa-error">{error}</div>}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="pa-input-container">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe your quiz..."
          disabled={isStreaming || !isActive}
          rows={1}
        />
        <button
          className={`pa-send-btn ${inputValue.trim() && isActive ? 'active' : ''}`}
          onClick={handleSend}
          disabled={!inputValue.trim() || !isActive || isStreaming}
        >
          {isStreaming ? <Spin size="small" /> : <SendOutlined />}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message, isDarkMode, userLogin, onApply, onCopy, copiedField }) {
  const isUser = message.role === 'user';
  const { content, suggestions } = parseSuggestions(message.content);

  return (
    <div className={`pa-message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser && (
        <Avatar style={{ backgroundColor: '#fffdf5', fontSize: '20px', flexShrink: 0, border: '1px solid #ffd66b' }}>✨</Avatar>
      )}
      <div className="pa-message-content">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents}>
          {content}
        </ReactMarkdown>
        {(message.suggestions?.length > 0 ? message.suggestions : suggestions).map(
          (suggestion, idx) => (
            <SuggestionCard
              key={idx}
              suggestion={suggestion}
              isDarkMode={isDarkMode}
              onApply={onApply}
              onCopy={onCopy}
              copiedField={copiedField}
            />
          )
        )}
      </div>
      {isUser &&
        (userLogin ? (
          <Avatar
            src={`https://github.com/${userLogin}.png?size=40`}
            style={{ backgroundColor: '#52c41a', flexShrink: 0 }}
          >
            {userLogin[0]?.toUpperCase()}
          </Avatar>
        ) : (
          <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#52c41a', flexShrink: 0 }} />
        ))}
    </div>
  );
}

function SuggestionCard({ suggestion, isDarkMode, onApply, onCopy, copiedField }) {
  if (!suggestion?.systemPrompt && !suggestion?.rubricPrompt) return null;

  const extras = [
    suggestion.name && `Name: ${suggestion.name}`,
    suggestion.subject && `Subject: ${suggestion.subject}`,
    suggestion.questionCount && `${suggestion.questionCount} questions`,
    suggestion.difficultyLevel,
  ].filter(Boolean);

  return (
    <div className="pa-suggestion">
      <div className="pa-suggestion-header">
        <span>Generated Suggestion</span>
        <Button
          type="primary"
          size="small"
          icon={<CheckOutlined />}
          onClick={() => onApply(suggestion)}
        >
          Apply
        </Button>
      </div>
      {extras.length > 0 && (
        <div className="pa-suggestion-tags">
          {extras.map((e, i) => (
            <span key={i} className="pa-tag">
              {e}
            </span>
          ))}
        </div>
      )}
      {suggestion.rubricPrompt && (
        <Collapse
          ghost
          size="small"
          defaultActiveKey={['rubric']}
          items={[
            {
              key: 'rubric',
              label: (
                <div className="pa-collapse-label">
                  <span>Rubric Prompt</span>
                  <Button
                    type="text"
                    size="small"
                    icon={copiedField === 'rubric' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={e => {
                      e.stopPropagation();
                      onCopy(suggestion.rubricPrompt, 'rubric');
                    }}
                  />
                </div>
              ),
              children: <pre className="pa-prompt-preview">{suggestion.rubricPrompt}</pre>,
            },
          ]}
        />
      )}
      {suggestion.systemPrompt && (
        <Collapse
          ghost
          size="small"
          defaultActiveKey={['system']}
          items={[
            {
              key: 'system',
              label: (
                <div className="pa-collapse-label">
                  <span>System Prompt</span>
                  <Button
                    type="text"
                    size="small"
                    icon={copiedField === 'system' ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={e => {
                      e.stopPropagation();
                      onCopy(suggestion.systemPrompt, 'system');
                    }}
                  />
                </div>
              ),
              children: <pre className="pa-prompt-preview">{suggestion.systemPrompt}</pre>,
            },
          ]}
        />
      )}
    </div>
  );
}

function ExplorationSteps({ steps }) {
  const getIcon = name => {
    const n = name?.includes('__') ? name.split('__').pop() : (name || '');
    // Trigger-mode tools
    if (n === 'explore_codebase') return <RocketOutlined style={{ color: '#3b82f6' }} />;
    if (n === 'github_tree') return <BranchesOutlined style={{ color: '#06b6d4' }} />;
    if (n === 'github_read') return <GithubOutlined style={{ color: '#10b981' }} />;
    if (n === 'synthesize') return <ExperimentOutlined style={{ color: '#8b5cf6' }} />;
    // Local/sandbox-mode tools
    if (n === 'Read' || n === 'secure_read') return <FileTextOutlined style={{ color: '#10b981' }} />;
    if (n === 'Grep' || n === 'secure_grep') return <SearchOutlined style={{ color: '#f97316' }} />;
    if (n === 'Glob' || n === 'secure_glob') return <FolderOpenOutlined style={{ color: '#6366f1' }} />;
    if (n === 'Bash') return <CodeOutlined style={{ color: '#f59e0b' }} />;
    return <CodeOutlined style={{ color: '#8c8c8c' }} />;
  };

  return (
    <div className="pa-exploration">
      {steps.slice(-3).map((s, i) => (
        <div key={i} className="pa-exploration-step">
          {getIcon(s.toolName)}
          <span>{s.action}</span>
        </div>
      ))}
    </div>
  );
}

function parseSuggestions(text) {
  if (!text) return { content: '', suggestions: [] };
  const suggestions = [];
  const regex = /```suggestion\s*([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.systemPrompt || parsed.rubricPrompt) suggestions.push(parsed);
    } catch (error) { console.log(error); }
  }
  return { content: text.replace(/```suggestion[\s\S]*?```/g, '').trim(), suggestions };
}

const markdownComponents = {
  pre: ({ children, ...props }) => (
    <pre className="pa-md-pre" {...props}>
      {children}
    </pre>
  ),
  code: ({ inline, className, children, ...props }) =>
    inline ? (
      <code className="pa-md-code" {...props}>
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  p: ({ children }) => <p style={{ margin: 0 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '8px 0', paddingLeft: 18 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '8px 0', paddingLeft: 18 }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
};

export default PromptAssistant;
