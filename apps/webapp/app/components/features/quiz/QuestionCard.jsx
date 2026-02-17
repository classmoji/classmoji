import { Card, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

const { Text, Title } = Typography;

/**
 * QuestionCard - Renders a structured quiz question with consistent styling
 *
 * This component is used when the LLM calls the present_question tool,
 * ensuring every question has the same clear, recognizable format.
 */
const QuestionCard = ({ questionData, isDarkMode = false }) => {
  const {
    question_number,
    total_questions,
    question_text,
    code_snippet,
    code_language,
    context,
  } = questionData;

  return (
    <Card
      size="small"
      style={{
        backgroundColor: isDarkMode ? '#1e3a5f' : '#e6f4ff',
        border: isDarkMode ? '1px solid #2d4a6f' : '1px solid #91caff',
        borderRadius: '8px',
        marginBottom: '8px',
      }}
      styles={{
        body: { padding: '12px 16px' },
      }}
    >
      {/* Question Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '8px',
          borderBottom: isDarkMode ? '1px solid #2d4a6f' : '1px solid #91caff',
        }}
      >
        <QuestionCircleOutlined
          style={{
            fontSize: '20px',
            color: isDarkMode ? '#69b1ff' : '#1890ff',
          }}
        />
        <Title
          level={5}
          style={{
            margin: 0,
            color: isDarkMode ? '#69b1ff' : '#0958d9',
            fontWeight: 600,
          }}
        >
          Question {question_number} of {total_questions}
        </Title>
      </div>

      {/* Context (optional) */}
      {context && (
        <Text
          type="secondary"
          style={{
            display: 'block',
            marginBottom: '8px',
            fontSize: '13px',
            color: isDarkMode ? '#9ca3af' : '#666',
            fontStyle: 'italic',
          }}
        >
          {context}
        </Text>
      )}

      {/* Code Snippet (optional) - rendered via ReactMarkdown for syntax highlighting */}
      {code_snippet && (
        <div style={{ marginBottom: '12px' }}>
          <ReactMarkdown
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre: ({ children, ...props }) => (
                <pre
                  style={{
                    backgroundColor: isDarkMode ? '#0d1117' : '#f6f8fa',
                    color: isDarkMode ? '#e5e7eb' : 'inherit',
                    padding: '12px',
                    borderRadius: '6px',
                    overflow: 'auto',
                    margin: 0,
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    border: isDarkMode ? '1px solid #30363d' : '1px solid #d0d7de',
                  }}
                  {...props}
                >
                  {children}
                </pre>
              ),
              code: ({ children, className, ...props }) => (
                <code className={className} {...props}>
                  {children}
                </code>
              ),
            }}
          >
            {`\`\`\`${code_language || ''}\n${code_snippet}\n\`\`\``}
          </ReactMarkdown>
        </div>
      )}

      {/* Question Text */}
      <div
        style={{
          fontSize: '15px',
          lineHeight: '1.6',
          color: isDarkMode ? '#e5e7eb' : '#1f2937',
        }}
      >
        <ReactMarkdown
          rehypePlugins={[rehypeHighlight]}
          components={{
            p: ({ children }) => (
              <p style={{ margin: 0, lineHeight: '1.6' }}>{children}</p>
            ),
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
            strong: ({ children }) => (
              <strong style={{ fontWeight: 600 }}>{children}</strong>
            ),
          }}
        >
          {question_text}
        </ReactMarkdown>
      </div>
    </Card>
  );
};

export default QuestionCard;
