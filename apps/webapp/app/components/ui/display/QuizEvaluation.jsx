import { Alert, Card, Progress, Space, Typography, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  BulbOutlined,
  TrophyOutlined,
  RocketOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { formatDuration } from '~/utils/quizUtils';
import { gradeToEmoji, DEFAULT_EMOJI_GRADE_MAPPINGS, getEmojiSymbol } from '@classmoji/utils';

const { Title, Text } = Typography;

const QuizEvaluation = ({ evaluationData, focusMetrics, isDarkMode = false }) => {
  if (!evaluationData) return null;

  // Always show formative score (partial_credit_percentage) - same for everyone
  const displayScore =
    evaluationData.partial_credit_percentage || evaluationData.raw_percentage || 0; // fallback for old data

  // Unified 5-tier color scheme for scores/percentages
  // Works for both borders and Ant Design Tag color prop
  const getScoreColor = percentage => {
    if (percentage >= 90) return '#52c41a'; // green - Excellent
    if (percentage >= 70) return '#1890ff'; // blue - Good
    if (percentage >= 50) return '#faad14'; // gold - Fair
    if (percentage >= 30) return '#fa8c16'; // orange - Needs work
    return '#f5222d'; // red - Poor
  };

  const getGradeIcon = score => {
    if (score >= 3) return <TrophyOutlined style={{ fontSize: 24, color: '#52c41a' }} />;
    if (score >= 2) return <BulbOutlined style={{ fontSize: 24, color: '#1890ff' }} />;
    return <RocketOutlined style={{ fontSize: 24, color: '#faad14' }} />;
  };

  return (
    <div style={{ marginTop: 20 }}>
      <Alert
        message="Quiz Complete!"
        description="Your responses have been evaluated. Here are your results:"
        type="success"
        showIcon
        style={{ marginBottom: 20 }}
      />

      <Card
        title={
          <Space>
            {getGradeIcon(evaluationData.numeric_score)}
            <span>Quiz Evaluation: {evaluationData.evaluation}</span>
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Progress
            type="circle"
            percent={displayScore}
            strokeColor={getScoreColor(displayScore)}
            format={percent => (
              <div>
                <div style={{ fontSize: 24, fontWeight: 'bold' }}>{percent}%</div>
                <div style={{ fontSize: 14, color: '#666' }}>Score</div>
              </div>
            )}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <Title level={5}>Summary</Title>
          <Text>{evaluationData.feedback_summary}</Text>
        </div>

        {evaluationData.feedback_strengths && evaluationData.feedback_strengths.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <Title level={5}>
              <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 8 }} />
              Strengths
            </Title>
            <ul>
              {evaluationData.feedback_strengths.map((strength, index) => (
                <li key={index}>
                  <Text>{strength}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}

        {evaluationData.feedback_improvements &&
          evaluationData.feedback_improvements.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <Title level={5}>
                <BulbOutlined style={{ color: '#faad14', marginRight: 8 }} />
                Areas for Improvement
              </Title>
              <ul>
                {evaluationData.feedback_improvements.map((improvement, index) => (
                  <li key={index}>
                    <Text>{improvement}</Text>
                  </li>
                ))}
              </ul>
            </div>
          )}

        {evaluationData.feedback_recommendation && (
          <div style={{ marginBottom: 20 }}>
            <Title level={5}>
              <RocketOutlined style={{ color: '#1890ff', marginRight: 8 }} />
              Next Steps
            </Title>
            <Text>{evaluationData.feedback_recommendation}</Text>
          </div>
        )}

        {evaluationData.feedback_effort_note && (
          <Alert
            message="Learning Journey"
            description={evaluationData.feedback_effort_note}
            type="info"
            showIcon={false}
            style={{ marginTop: 16 }}
          />
        )}

        {focusMetrics && (
          <div style={{ marginTop: 16, marginBottom: 12 }}>
            <Tooltip
              title="We track how much time you spent actively engaged with the quiz (tab visible and focused) versus time spent away. This helps measure your focus and demonstrates you completed the quiz independently without external resources."
              placement="top"
            >
              <Space
                size="small"
                wrap
                style={{
                  padding: '8px 12px',
                  backgroundColor: isDarkMode ? '#1f2937' : '#fafafa',
                  borderRadius: 6,
                  border: isDarkMode ? '1px solid #374151' : '1px solid #f0f0f0',
                  cursor: 'help',
                }}
              >
                <Text type="secondary" style={{ fontSize: 13, marginRight: 4 }}>
                  <ClockCircleOutlined style={{ marginRight: 4 }} />
                  Time:
                </Text>
                <Tag style={{ fontSize: 12, margin: 0 }}>
                  Total: {formatDuration(focusMetrics.totalMs)}
                </Tag>
                <Tag color="green" style={{ fontSize: 12, margin: 0 }}>
                  Focused: {formatDuration(focusMetrics.focusedMs)}
                </Tag>
                <Tag
                  color={
                    focusMetrics.percentage > 98
                      ? 'green'
                      : focusMetrics.percentage >= 90
                        ? 'orange'
                        : 'red'
                  }
                  style={{ fontSize: 12, margin: 0 }}
                >
                  {focusMetrics.percentage}% Time on Page
                </Tag>
              </Space>
            </Tooltip>
          </div>
        )}

        {evaluationData.question_results && evaluationData.question_results.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <Title level={5}>Question Performance</Title>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 8,
              }}
            >
              {evaluationData.question_results.map(result => {
                const creditPct = result.credit_earned ?? 0;
                const emojiShortcode = gradeToEmoji(creditPct, DEFAULT_EMOJI_GRADE_MAPPINGS);
                const emoji = getEmojiSymbol(emojiShortcode);
                return (
                  <Card
                    key={result.question_num}
                    size="small"
                    style={{
                      textAlign: 'center',
                      borderColor: getScoreColor(creditPct),
                    }}
                  >
                    <div style={{ fontWeight: 'bold' }}>Q{result.question_num}</div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {result.attempts} attempt{result.attempts !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 20 }}>{emoji}</div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default QuizEvaluation;
