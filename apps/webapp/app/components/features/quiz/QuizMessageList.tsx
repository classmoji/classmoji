import { useRef, useEffect } from 'react';
import { Space, Avatar, Collapse, Typography } from 'antd';
import {
  UserOutlined,
  BookOutlined,
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
import {
  completionMessageDisplay,
  parseMessageButtons,
  parseQuestionCard,
  parseQuestionComplete,
  stripQuestionComplete,
} from '~/utils/quizUtils';
import QuizEvaluation, {
  type EvaluationData,
  type FocusMetrics,
} from '~/components/ui/display/QuizEvaluation';
import QuestionCard from './QuestionCard';
import ProgressDivider from './ProgressDivider';
import { QuizResultSlotsFallback } from './QuizResultContext';
import { useGitWeb } from '~/hooks/useGitWeb';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';

const { Text } = Typography;

interface ExplorationStep {
  toolName?: string;
  tool?: string;
  action: string;
  /**
   * The document a course-material step opened (content_get only), from the
   * quiz's loaded material list, never from the call. Absent on code steps.
   */
  title?: string;
}

/** A tool's name without its MCP server prefix (mcp__classmoji__content_get → content_get). */
const shortToolName = (toolName: string | undefined) =>
  toolName?.includes('__') ? toolName.split('__').pop() : toolName;

/** The course-content tools on the classmoji MCP server. */
const CONTENT_TOOLS = new Set(['content_get', 'content_search', 'content_list']);

const isContentStep = (step: ExplorationStep) =>
  CONTENT_TOOLS.has(shortToolName(step.toolName || step.tool) ?? '');

/**
 * Steps that only looked at course material (a standard quiz's are always
 * that) get neutral headers; the code-analysis ones stay for any run that
 * explored code.
 */
const onlyContentSteps = (steps: ExplorationStep[]) =>
  steps.length > 0 && steps.every(isContentStep);

/** A step's line: its label, and the document it opened when there is one. */
const stepLabel = (step: ExplorationStep) =>
  step.title ? `${step.action} · ${step.title}` : step.action;

interface ChatMessage {
  id: string | number;
  role: string;
  content: string;
  metadata?: {
    explorationSteps?: ExplorationStep[];
    [key: string]: unknown;
  };
  timestamp?: string | Date;
}

// FocusMetrics imported from QuizEvaluation

// Shared markdown component configurations
interface MarkdownElementProps {
  children?: React.ReactNode;
  [key: string]: unknown;
}

const createMarkdownComponents = (
  isDarkMode: boolean,
  isAssistant = true
): Record<string, React.ComponentType<any>> => ({
  pre: ({ children, ...props }: MarkdownElementProps) => (
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
  code: ({
    className,
    children,
    _node,
    ...rest
  }: MarkdownElementProps & { className?: string; _node?: unknown }) => {
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
          fontFamily: '"Mona Sans Variable", "Mona Sans", sans-serif',
          fontSize: '0.9em',
        }}
        {...rest}
      >
        {children}
      </code>
    );
  },
  p: ({ children }: MarkdownElementProps) => (
    <p style={{ margin: '8px 0', lineHeight: '1.6' }}>{children}</p>
  ),
  ul: ({ children }: MarkdownElementProps) => (
    <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ul>
  ),
  ol: ({ children }: MarkdownElementProps) => (
    <ol style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ol>
  ),
  li: ({ children }: MarkdownElementProps) => <li style={{ margin: '4px 0' }}>{children}</li>,
  strong: ({ children }: MarkdownElementProps) => (
    <strong style={{ fontWeight: 600 }}>{children}</strong>
  ),
  em: ({ children }: MarkdownElementProps) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  h1: ({ children }: MarkdownElementProps) => (
    <h1 style={{ fontSize: '1.5em', fontWeight: 600, margin: '12px 0 8px' }}>{children}</h1>
  ),
  h2: ({ children }: MarkdownElementProps) => (
    <h2 style={{ fontSize: '1.3em', fontWeight: 600, margin: '10px 0 6px' }}>{children}</h2>
  ),
  h3: ({ children }: MarkdownElementProps) => (
    <h3 style={{ fontSize: '1.1em', fontWeight: 600, margin: '8px 0 4px' }}>{children}</h3>
  ),
  blockquote: ({ children }: MarkdownElementProps) => (
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
  a: ({ children, href }: MarkdownElementProps & { href?: string }) => (
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
const getToolIcon = (toolName: string | undefined, isGitLab = false) => {
  // Normalize: extract simple name from MCP-prefixed names like mcp__secure-tools__secure_read
  const name = shortToolName(toolName);

  // Course material (classmoji MCP content tools)
  if (name && CONTENT_TOOLS.has(name)) return <BookOutlined style={{ color: '#0d9488' }} />;

  // Trigger-mode tool names
  if (name === 'explore_codebase') return <RocketOutlined style={{ color: '#3b82f6' }} />;
  if (name === 'github_tree') return <BranchesOutlined style={{ color: '#06b6d4' }} />;
  if (name === 'github_read')
    return isGitLab ? (
      <GitlabLogo size={14} />
    ) : (
      <GithubOutlined className="text-gray-900 dark:text-gray-100" />
    );
  if (name === 'synthesize') return <ExperimentOutlined style={{ color: '#8b5cf6' }} />;

  // Local/sandbox-mode tool names
  if (name === 'Read' || name === 'secure_read')
    return <FileTextOutlined style={{ color: '#10b981' }} />;
  if (name === 'Bash') return <CodeOutlined style={{ color: '#f59e0b' }} />;
  if (name === 'Grep' || name === 'secure_grep')
    return <SearchOutlined style={{ color: '#f97316' }} />;
  if (name === 'Glob' || name === 'secure_glob')
    return <FolderOpenOutlined style={{ color: '#6366f1' }} />;
  return <CodeOutlined style={{ color: '#8c8c8c' }} />;
};

// Render exploration steps collapse
const renderExplorationSteps = (message: ChatMessage, isDarkMode: boolean, isGitLab: boolean) => {
  if (message.role?.toUpperCase() !== 'ASSISTANT' || !message.metadata?.explorationSteps?.length) {
    return null;
  }
  const steps = message.metadata.explorationSteps;

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
                {onlyContentSteps(steps) ? (
                  <>
                    <BookOutlined style={{ color: '#0d9488' }} /> Checked course material (
                    {steps.length} {steps.length === 1 ? 'step' : 'steps'})
                  </>
                ) : (
                  <>
                    <RocketOutlined style={{ color: '#3b82f6' }} /> Code Analysis ({steps.length}{' '}
                    steps)
                  </>
                )}
              </Text>
            ),
            children: (
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {steps.map((step: ExplorationStep, idx: number) => (
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
                    {getToolIcon(step.toolName || step.tool, isGitLab)}
                    <Text type="secondary" style={{ fontSize: '12px' }}>
                      {stepLabel(step)}
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

// Render an assistant message with markdown. The quick-action markers
// ([BUTTONS: …]) are stripped: this transcript is read-only, so nothing is
// offered to press.
const renderAssistantMessage = (messageContent: string, isDarkMode: boolean) => {
  // First check for question card
  const { hasQuestionCard, questionData, preamble, remainingContent } =
    parseQuestionCard(messageContent);

  // Strip the button markers from the remaining content (or the full content
  // if there is no question card)
  const contentForButtons = hasQuestionCard ? remainingContent : messageContent;
  const { cleanContent } = parseMessageButtons(contentForButtons);

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
    </>
  );
};

// Render user message with markdown (disable auto-linking)
const renderUserMessage = (messageContent: string, isDarkMode: boolean) => {
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

interface QuizMessageListProps {
  messages?: ChatMessage[];
  isDarkMode?: boolean;
  userLogin?: string | null;
  userImage?: string | null;
  evaluationData?: EvaluationData | null;
  focusMetrics?: FocusMetrics | null;
}

/**
 * A saved transcript from the retired ai-agent quiz runtime, read-only (see
 * LegacyQuizTranscript): the messages, each assistant message's collapsed
 * exploration steps, and the evaluation card when there is one.
 */
const QuizMessageList = ({
  messages = [],
  isDarkMode = false,
  userLogin = null,
  userImage = null,
  evaluationData = null,
  focusMetrics = null,
}: QuizMessageListProps) => {
  const { isGitLab } = useGitWeb();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const evaluationRef = useRef<HTMLDivElement>(null);

  // The evaluation card's data comes from the attempt (LegacyQuizTranscript
  // passes it for a completed attempt only), never from a message.
  const hasEvaluation = Boolean(evaluationData);

  // Open on the evaluation when there is one, else on the end of the transcript.
  useEffect(() => {
    // Use a small delay to ensure DOM is fully rendered
    const timer = setTimeout(() => {
      if (hasEvaluation && evaluationRef.current) {
        evaluationRef.current.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        messagesEndRef.current?.scrollIntoView?.({ behavior: 'auto' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [hasEvaluation]);

  const renderMessage = (message: ChatMessage, messageIndex: number) => {
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
        messageContent = stripQuestionComplete(messageContent);
      }

      const processed = completionMessageDisplay(
        messageContent,
        messageIndex === messages.length - 1
      );
      if (processed.shouldHide) {
        return null;
      }
      if (processed.content !== undefined) {
        messageContent = processed.content as string;
      }
    }

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
        {renderExplorationSteps(message, isDarkMode, isGitLab)}

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
              ? renderAssistantMessage(messageContent, isDarkMode)
              : renderUserMessage(message.content, isDarkMode)}
          </div>
          {role === 'USER' &&
            (userLogin ? (
              <Avatar src={userImage ?? undefined} style={{ backgroundColor: '#52c41a' }}>
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
    <div
      tabIndex={0} // eslint-disable-line -- Keyboard accessibility: allows scrolling with arrow keys
      role="log"
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

      {/* Quiz evaluation - rendered in same scroll area as messages */}
      {evaluationData ? (
        <div ref={evaluationRef}>
          <QuizEvaluation
            evaluationData={evaluationData}
            focusMetrics={focusMetrics}
            isDarkMode={isDarkMode}
          />
        </div>
      ) : (
        // No evaluation record: the drawer's blocks (the staff adjust panel)
        // still show.
        <QuizResultSlotsFallback />
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};

export default QuizMessageList;
