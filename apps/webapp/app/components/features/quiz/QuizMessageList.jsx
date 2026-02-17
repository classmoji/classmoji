import { useRef, useEffect, useState } from 'react';
import { Space, Avatar, Collapse, Tag, Typography, Button } from 'antd';
import {
  UserOutlined,
  FileTextOutlined,
  CodeOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  RocketOutlined,
  BranchesOutlined,
  ExperimentOutlined,
  GithubOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import dayjs from 'dayjs';
import { checkForCompletion, parseQuestionComplete } from '~/utils/quizUtils';
import { QuizEvaluation, TypingIndicator } from '~/components';
import QuestionCard from './QuestionCard';
import ProgressDivider from './ProgressDivider';

const { Text } = Typography;

// Extract a complete JSON object from a string starting at a given position
// Uses bracket counting to handle nested braces properly
const extractJsonObject = (str, startIndex) => {
  if (str[startIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return {
            json: str.substring(startIndex, i + 1),
            endIndex: i,
          };
        }
      }
    }
  }

  return null; // Unbalanced braces
};

// Parse message content to extract question card data
// Format 1 (from tool): {preamble}\n\n[QUESTION_CARD]\n```json\n{...}\n```
// Format 2 (direct): {preamble}\n\n[QUESTION_CARD]\n{...}
const parseQuestionCard = content => {
  if (!content || !content.includes('[QUESTION_CARD]')) {
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }

  const markerIndex = content.indexOf('[QUESTION_CARD]');
  const afterMarker = content.substring(markerIndex + '[QUESTION_CARD]'.length);

  let jsonString = null;
  let jsonEndIndex = markerIndex; // Will be updated to actual end position

  // Find the first '{' after the marker (could be inside code block or raw)
  const firstBraceInAfterMarker = afterMarker.indexOf('{');

  if (firstBraceInAfterMarker !== -1) {
    const absoluteJsonStart = markerIndex + '[QUESTION_CARD]'.length + firstBraceInAfterMarker;
    const extracted = extractJsonObject(content, absoluteJsonStart);

    if (extracted) {
      jsonString = extracted.json;

      // Check if there's a closing code fence after the JSON
      const afterJson = content.substring(extracted.endIndex + 1);
      const closingFenceMatch = afterJson.match(/^\s*```/);

      if (closingFenceMatch) {
        // Include the closing fence in what we skip
        jsonEndIndex = extracted.endIndex + 1 + closingFenceMatch[0].length;
      } else {
        jsonEndIndex = extracted.endIndex + 1;
      }
    }
  }

  if (!jsonString) {
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }

  try {
    const questionData = JSON.parse(jsonString);

    // Extract preamble (text before [QUESTION_CARD] marker)
    const preamble = markerIndex > 0 ? content.substring(0, markerIndex).trim() : null;

    // Extract remaining content (text after the JSON block)
    const remainingContent = content.substring(jsonEndIndex).trim();

    return {
      hasQuestionCard: true,
      questionData,
      preamble,
      remainingContent,
    };
  } catch (error) {
    console.error('[parseQuestionCard] JSON.parse FAILED:', error.message);
    console.error('[parseQuestionCard] JSON string was:', jsonString?.substring(0, 200));
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }
};

// Parse message content to extract button markers
const parseMessageButtons = content => {
  const buttons = [];
  if (content.includes('[BUTTON:TRY_AGAIN]')) buttons.push('TRY_AGAIN');
  if (content.includes('[BUTTON:NEXT]')) buttons.push('NEXT');

  return {
    cleanContent: content.replace(/\[BUTTON:(TRY_AGAIN|NEXT)\]\s*/g, '').trim(),
    buttons,
  };
};

// Shared markdown component configurations
const createMarkdownComponents = (isDarkMode, isAssistant = true) => ({
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
        fontSize: isAssistant ? '14px' : '0.9em',
      }}
      {...props}
    >
      {children}
    </pre>
  ),
  code: ({ className, children, node, ...rest }) => {
    // Check for language class (syntax-highlighted code blocks)
    const hasLanguageClass = /language-(\w+)/.test(className || '');

    // Code blocks without language identifier don't get a class from rehype-highlight,
    // but they still have newlines. Inline code (single backticks) doesn't have newlines.
    const contentString = String(children);
    const hasNewlines = contentString.includes('\n');

    // It's a code block if it has a language class OR has newlines
    const isCodeBlock = hasLanguageClass || hasNewlines;

    if (isCodeBlock) {
      // For syntax-highlighted blocks, just pass through the className
      // For blocks without language, render plain monospace (pre handles wrapper styling)
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }

    // Inline code styling - match the editor's look with darker bg and red text
    // User messages have gray backgrounds, so use even darker bg for contrast
    const userCodeBg = isDarkMode ? '#111827' : '#e5e7eb';
    const assistantCodeBg = isDarkMode ? '#374151' : '#f1f1ef';
    const codeTextColor = isDarkMode ? '#f87171' : '#eb5757';

    return (
      <code
        style={{
          backgroundColor: isAssistant ? assistantCodeBg : userCodeBg,
          color: codeTextColor,
          padding: '2px 6px',
          borderRadius: '4px',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '0.9em',
        }}
        {...rest}
      >
        {children}
      </code>
    );
  },
  p: ({ children }) => <p style={{ margin: '8px 0', lineHeight: '1.6' }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '4px 0' }}>{children}</li>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  h1: ({ children }) => (
    <h1 style={{ fontSize: '1.5em', fontWeight: 600, margin: '12px 0 8px' }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: '1.3em', fontWeight: 600, margin: '10px 0 6px' }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: '1.1em', fontWeight: 600, margin: '8px 0 4px' }}>{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        borderLeft: isDarkMode ? '3px solid #4b5563' : '3px solid #d9d9d9',
        paddingLeft: '12px',
        margin: '8px 0',
        color: isDarkMode ? '#9ca3af' : '#666',
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: isDarkMode ? '#10b981' : isAssistant ? '#10b981' : '#52c41a',
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  ),
});

// Function to get icon for tool (handles simple names, MCP-prefixed names, and trigger-mode names)
const getToolIcon = toolName => {
  // Normalize: extract simple name from MCP-prefixed names like mcp__secure-tools__secure_read
  const name = toolName?.includes('__') ? toolName.split('__').pop() : toolName;

  // Trigger-mode tool names
  if (name === 'explore_codebase')
    return <RocketOutlined style={{ color: '#3b82f6' }} />;
  if (name === 'github_tree')
    return <BranchesOutlined style={{ color: '#06b6d4' }} />;
  if (name === 'github_read')
    return <GithubOutlined style={{ color: '#10b981' }} />;
  if (name === 'synthesize')
    return <ExperimentOutlined style={{ color: '#8b5cf6' }} />;

  // Local/sandbox-mode tool names
  if (name === 'Read' || name === 'secure_read')
    return <FileTextOutlined style={{ color: '#10b981' }} />;
  if (name === 'Bash')
    return <CodeOutlined style={{ color: '#f59e0b' }} />;
  if (name === 'Grep' || name === 'secure_grep')
    return <SearchOutlined style={{ color: '#f97316' }} />;
  if (name === 'Glob' || name === 'secure_glob')
    return <FolderOpenOutlined style={{ color: '#6366f1' }} />;
  return <CodeOutlined style={{ color: '#8c8c8c' }} />;
};

// Process completion message and extract displayable content
const processCompletionMessage = (messageContent, evaluationData, messageIndex, messages) => {
  const completionData = checkForCompletion(messageContent);

  // If no completion data, show the full message
  if (!completionData) {
    return { shouldHide: false, content: messageContent };
  }

  // Message contains completion data - always extract text before JSON
  // Extract text before the JSON code block (agent's natural response)
  const quizCompleteBlockMatch = messageContent.match(/```(?:[a-z]*\n|\n|)([\s\S]*?)```/gi);
  let textBeforeJson = '';

  if (quizCompleteBlockMatch) {
    // Find the block that contains quiz_complete
    for (const block of quizCompleteBlockMatch) {
      if (block.includes('quiz_complete')) {
        const blockStartIndex = messageContent.indexOf(block);
        if (blockStartIndex > 0) {
          textBeforeJson = messageContent.substring(0, blockStartIndex).trim();
        }
        break;
      }
    }
  }

  // If we couldn't find it in code blocks, try to find raw JSON
  if (!textBeforeJson) {
    const jsonStartMatch = messageContent.match(/\{[^{}]*"quiz_complete"/);
    if (jsonStartMatch) {
      const jsonStartIndex = messageContent.indexOf(jsonStartMatch[0]);
      if (jsonStartIndex > 0) {
        textBeforeJson = messageContent.substring(0, jsonStartIndex).trim();
      }
    }
  }

  // Priority 1: Use extracted text before JSON if it exists
  if (textBeforeJson) {
    // Strip the [QUIZ_EVALUATION] marker - it's for parsing, not display
    const cleanedText = textBeforeJson.replace(/\[QUIZ_EVALUATION\]\s*/g, '').trim();
    if (cleanedText) {
      return { shouldHide: false, content: cleanedText };
    }
    // If only the marker was there (no actual text), fall through to other priorities
  }

  // Priority 2: Use final_acknowledgment from completion data
  if (completionData.final_acknowledgment) {
    return { shouldHide: false, content: completionData.final_acknowledgment };
  }

  // Priority 3: If this is the last message, show a generic completion message
  const isLastMessage = messageIndex === messages.length - 1;
  if (isLastMessage) {
    return { shouldHide: false, content: 'Quiz completed! See your evaluation below.' };
  }

  // Priority 4: Hide the message entirely (JSON only, no displayable text)
  return { shouldHide: true };
};

// Render exploration steps collapse
const renderExplorationSteps = (message, isDarkMode) => {
  if (message.role?.toUpperCase() !== 'ASSISTANT' || !message.metadata?.explorationSteps?.length) {
    return null;
  }

  return (
    <div style={{ marginBottom: 8, maxWidth: '70%', width: '100%' }}>
      <Collapse
        size="small"
        defaultActiveKey={[]}
        items={[
          {
            key: '1',
            label: (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                <RocketOutlined style={{ color: '#3b82f6' }} /> Code Analysis ({message.metadata.explorationSteps.length} steps)
              </Text>
            ),
            children: (
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {message.metadata.explorationSteps.map((step, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '4px 0',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    {getToolIcon(step.toolName || step.tool)}
                    <Text type="secondary" style={{ fontSize: '12px' }}>
                      {step.action}
                    </Text>
                  </div>
                ))}
              </div>
            ),
          },
        ]}
        style={{
          width: '100%',
          backgroundColor: isDarkMode ? '#111827' : '#fafafa',
        }}
      />
    </div>
  );
};

// Render assistant message with markdown and action buttons
const renderAssistantMessage = (
  messageContent,
  isDarkMode,
  loading,
  readOnly,
  onQuickAction,
  hasBeenAnswered
) => {
  // First check for question card
  const { hasQuestionCard, questionData, preamble, remainingContent } =
    parseQuestionCard(messageContent);

  // Parse buttons from remaining content (or full content if no question card)
  const contentForButtons = hasQuestionCard ? remainingContent : messageContent;
  const { cleanContent, buttons } = parseMessageButtons(contentForButtons);

  const canTriggerAction = !loading && !readOnly && typeof onQuickAction === 'function';
  const baseDisabled = loading || readOnly || typeof onQuickAction !== 'function';

  return (
    <>
      {/* Render preamble text before QuestionCard (natural lead-in) */}
      {preamble && (
        <ReactMarkdown
          rehypePlugins={[rehypeHighlight]}
          components={createMarkdownComponents(isDarkMode, true)}
        >
          {preamble}
        </ReactMarkdown>
      )}

      {/* Render QuestionCard if present */}
      {hasQuestionCard && questionData && (
        <QuestionCard questionData={questionData} isDarkMode={isDarkMode} />
      )}

      {/* Render remaining markdown content - but NOT after a QuestionCard (that's just the model restating the question) */}
      {cleanContent && !hasQuestionCard && (
        <ReactMarkdown
          rehypePlugins={[rehypeHighlight]}
          components={createMarkdownComponents(isDarkMode, true)}
        >
          {cleanContent}
        </ReactMarkdown>
      )}

      {/* Render action buttons - only show in feedback messages, not with question cards */}
      {buttons.length > 0 && !hasQuestionCard && (
        <Space style={{ marginTop: 12 }}>
          {buttons.includes('TRY_AGAIN') && (
            <Button
              size="small"
              onClick={
                canTriggerAction
                  ? () => onQuickAction("I'd like to try answering this question again")
                  : undefined
              }
              disabled={hasBeenAnswered || baseDisabled}
            >
              Try Again
            </Button>
          )}
          {buttons.includes('NEXT') && (
            <Button
              type="primary"
              size="small"
              onClick={canTriggerAction ? () => onQuickAction('next') : undefined}
              disabled={hasBeenAnswered || baseDisabled}
            >
              Next →
            </Button>
          )}
        </Space>
      )}
    </>
  );
};

// Render user message with markdown (disable auto-linking)
const renderUserMessage = (messageContent, isDarkMode) => {
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeHighlight]}
      components={createMarkdownComponents(isDarkMode, false)}
      disallowedElements={['a']}
      unwrapDisallowed={true}
    >
      {messageContent}
    </ReactMarkdown>
  );
};

const QuizMessageList = ({
  messages = [],
  loading = false,
  isDarkMode = false,
  userLogin = null,
  onQuickAction = null,
  readOnly = false,
  showTimestamps = false,
  explorationSteps = [],
  isQuizComplete: propIsQuizComplete = false,
  evaluationData: propEvaluationData = null,
  focusMetrics = null,
}) => {
  const messagesEndRef = useRef(null);
  const evaluationRef = useRef(null);

  // Extract evaluation data from messages if not provided as prop
  const [extractedEvaluationData, setExtractedEvaluationData] = useState(null);

  useEffect(() => {
    // In read-only mode, extract evaluation data from messages
    if (readOnly && messages.length > 0 && !propEvaluationData) {
      for (const msg of messages) {
        if (msg.role?.toUpperCase() === 'ASSISTANT') {
          const completion = checkForCompletion(msg.content);
          if (completion) {
            setExtractedEvaluationData(completion);
            break;
          }
        }
      }
    }
  }, [messages, readOnly, propEvaluationData]);

  // Use prop evaluation data if provided, otherwise use extracted
  const evaluationData = propEvaluationData || extractedEvaluationData;
  const isQuizComplete = propIsQuizComplete || Boolean(evaluationData);

  // Function to scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll to bottom when messages change, loading state changes, or new exploration steps stream in
  // But stop auto-scrolling once quiz is complete to allow free scrolling
  useEffect(() => {
    if (!isQuizComplete) {
      scrollToBottom();
    }
  }, [messages, loading, isQuizComplete, explorationSteps.length]);

  // In read-only mode, scroll to show evaluation at the top
  useEffect(() => {
    if (readOnly && isQuizComplete && evaluationRef.current) {
      // Use a small delay to ensure DOM is fully rendered
      const timer = setTimeout(() => {
        evaluationRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [readOnly, isQuizComplete]);

  const renderMessage = (message, messageIndex) => {
    // Normalize role to uppercase for comparison (handles both DB enum 'ASSISTANT' and AI API format 'assistant')
    const role = message.role?.toUpperCase();

    // Process completion messages for assistant messages
    let messageContent = message.content || '';
    let questionCompleteData = null;

    if (role === 'ASSISTANT' && messageContent) {
      // Check for [QUESTION_COMPLETE] marker (progressive grading feedback)
      questionCompleteData = parseQuestionComplete(messageContent);
      if (questionCompleteData) {
        // Strip the [QUESTION_COMPLETE] marker and JSON from display
        messageContent = messageContent
          .replace(/\[QUESTION_COMPLETE\]\s*```(?:json)?\s*[\s\S]*?```/g, '')
          .replace(/\[QUESTION_COMPLETE\]\s*\{[\s\S]*?\}\s*(?:\n\n|$)/g, '')
          .trim();
      }

      const processed = processCompletionMessage(
        messageContent,
        evaluationData,
        messageIndex,
        messages
      );
      if (processed.shouldHide) {
        return null;
      }
      if (processed.content) {
        messageContent = processed.content;
      }
    }

    // Check if this question has already been answered (for interactive mode)
    const hasBeenAnswered =
      !readOnly &&
      role === 'ASSISTANT' &&
      messages.slice(messageIndex + 1).some(msg => msg.role?.toUpperCase() === 'USER');

    // Create ProgressDivider element if we have question complete data
    const progressDividerElement = questionCompleteData ? (
      <ProgressDivider
        emoji={questionCompleteData.emoji}
        briefFeedback={questionCompleteData.brief_feedback}
        questionNum={questionCompleteData.question_num}
        isDarkMode={isDarkMode}
      />
    ) : null;

    return (
      <div
        key={message.id}
        style={{
          marginBottom: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: role === 'USER' ? 'flex-end' : 'flex-start',
        }}
      >
        {/* Show progress divider as a regular assistant message */}
        {progressDividerElement && (
          <div style={{ marginBottom: 8 }}>
            <Space align="start">
              <Avatar
                style={{
                  backgroundColor: '#fffdf5',
                  fontSize: '20px',
                  border: '1px solid #ffd66b',
                }}
              >
                📝
              </Avatar>
              <div
                style={{
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  padding: '12px 16px',
                  borderRadius: '8px',
                  border: isDarkMode ? '1px solid #4b5563' : '1px solid #d9d9d9',
                }}
              >
                {progressDividerElement}
              </div>
            </Space>
          </div>
        )}

        {/* Show exploration steps if this is an assistant message with metadata */}
        {renderExplorationSteps(message, isDarkMode)}

        <Space align="start">
          {role === 'ASSISTANT' && (
            <Avatar
              style={{ backgroundColor: '#fffdf5', fontSize: '20px', border: '1px solid #ffd66b' }}
            >
              📝
            </Avatar>
          )}
          <div
            style={{
              maxWidth: '70%',
              minWidth: 'fit-content',
              backgroundColor:
                role === 'USER'
                  ? isDarkMode
                    ? '#374151'
                    : '#f0f2f5'
                  : isDarkMode
                    ? '#1f2937'
                    : '#fff',
              padding: '12px 16px',
              borderRadius: '8px',
              border:
                role === 'ASSISTANT'
                  ? isDarkMode
                    ? '1px solid #4b5563'
                    : '1px solid #d9d9d9'
                  : 'none',
              wordBreak: 'break-word',
            }}
          >
            {role === 'ASSISTANT'
              ? renderAssistantMessage(
                  messageContent,
                  isDarkMode,
                  loading,
                  readOnly,
                  onQuickAction,
                  hasBeenAnswered
                )
              : renderUserMessage(message.content, isDarkMode)}
          </div>
          {role === 'USER' &&
            (userLogin ? (
              <Avatar
                src={`https://github.com/${userLogin}.png?size=40`}
                style={{ backgroundColor: '#52c41a' }}
              >
                {userLogin[0]?.toUpperCase()}
              </Avatar>
            ) : (
              <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#52c41a' }} />
            ))}
        </Space>
      </div>
    );
  };

  return (
    <>
    <style>{`
      @keyframes exploration-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.15); }
      }
      .exploration-step-active .anticon {
        animation: exploration-pulse 1.5s ease-in-out infinite;
        display: inline-block;
      }
    `}</style>
    <div
      tabIndex={0} // eslint-disable-line -- Keyboard accessibility: allows scrolling with arrow keys
      role="log"
      aria-live="polite"
      aria-label="Quiz conversation"
      style={{
        flex: 1,
        overflowY: 'auto',
        marginBottom: 16,
        padding: '0 16px',
        outline: 'none',
      }}
    >
      {messages.map(renderMessage)}

      {/* Loading indicator */}
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%', maxWidth: '70%' }}>
            <Space>
              <Avatar
                style={{
                  backgroundColor: '#fffdf5',
                  fontSize: '20px',
                  border: '1px solid #ffd66b',
                }}
              >
                📝
              </Avatar>
              <div
                style={{
                  padding: '12px 16px',
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  borderRadius: '8px',
                  border: isDarkMode ? '1px solid #4b5563' : '1px solid #d9d9d9',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <TypingIndicator color="#10b981" />
                <Text type="secondary" style={{ marginLeft: 4 }}>
                  {explorationSteps.length > 0 ? 'Exploring code...' : 'Thinking...'}
                </Text>
              </div>
            </Space>

            {/* Show real-time exploration steps */}
            {explorationSteps.length > 0 && (
              <div
                style={{
                  marginLeft: 48,
                  padding: '8px 12px',
                  backgroundColor: isDarkMode ? '#111827' : '#f9fafb',
                  borderRadius: '6px',
                  border: isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb',
                  fontSize: '12px',
                }}
              >
                <Text
                  type="secondary"
                  style={{ fontSize: '11px', fontWeight: 500, display: 'block', marginBottom: 4 }}
                >
                  <RocketOutlined style={{ color: '#3b82f6' }} /> Analyzing your code...
                </Text>
                {explorationSteps.map((step, idx) => {
                  const isLastStep = idx === explorationSteps.length - 1;
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '2px 0',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <span className={isLastStep ? 'exploration-step-active' : ''}>
                        {getToolIcon(step.toolName || step.tool)}
                      </span>
                      <Text type="secondary" style={{ fontSize: '11px' }}>
                        {step.action}
                      </Text>
                    </div>
                  );
                })}
              </div>
            )}
          </Space>
        </div>
      )}

      {/* Quiz evaluation - rendered in same scroll area as messages */}
      {isQuizComplete && evaluationData && (
        <div ref={evaluationRef}>
          <QuizEvaluation
            evaluationData={evaluationData}
            focusMetrics={focusMetrics}
            isDarkMode={isDarkMode}
          />
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
    </>
  );
};

export default QuizMessageList;
