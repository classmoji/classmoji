import { Alert, Card, Space, Typography, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  BulbOutlined,
  TrophyOutlined,
  RocketOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { formatDuration } from '~/utils/quizUtils';
import Emoji from '~/components/ui/display/Emoji';
import {
  QuizGradeHero,
  effectiveBand,
  useQuizResultSlots,
} from '~/components/features/quiz/QuizResultContext';

const { Title, Text } = Typography;

export interface QuestionResult {
  question_num: number;
  /** Staff views only: a student's results carry no credit (E1). */
  credit_earned?: number;
  attempts: number;
  /** The emoji stored with the result, from the classroom's scale (attemptDrawerView). */
  emoji?: string | null;
}

export interface EvaluationData {
  partial_credit_percentage?: number;
  raw_percentage?: number;
  numeric_score?: number;
  evaluation?: string;
  feedback_summary?: string;
  feedback_strengths?: string[];
  feedback_improvements?: string[];
  feedback_recommendation?: string;
  feedback_effort_note?: string;
  question_results?: QuestionResult[];
  [key: string]: unknown;
}

export interface FocusMetrics {
  totalMs: number | null;
  focusedMs: number;
  percentage: number;
}

interface QuizEvaluationProps {
  evaluationData: EvaluationData | null;
  focusMetrics?: FocusMetrics | null;
  isDarkMode?: boolean;
}

const QuizEvaluation = ({
  evaluationData,
  focusMetrics,
  isDarkMode = false,
}: QuizEvaluationProps) => {
  const slots = useQuizResultSlots();
  if (!evaluationData) return null;

  // The grade shows as the classroom's emoji with its band (E3), never as a
  // number; the band follows the effective grade when the drawer has it (D9).
  const { evaluation: band, numeric_score: bandScore } = effectiveBand(slots, {
    evaluation: evaluationData.evaluation ?? null,
    numeric_score: evaluationData.numeric_score ?? null,
  });

  // Unified 5-tier color scheme for scores/percentages
  // Works for both borders and Ant Design Tag color prop
  const getScoreColor = (percentage: number) => {
    if (percentage >= 90) return '#52c41a'; // green - Excellent
    if (percentage >= 70) return '#1890ff'; // blue - Good
    if (percentage >= 50) return '#faad14'; // gold - Fair
    if (percentage >= 30) return '#fa8c16'; // orange - Needs work
    return '#f5222d'; // red - Poor
  };

  const getGradeIcon = (score: number) => {
    if (score >= 3) return <TrophyOutlined style={{ fontSize: 24, color: '#52c41a' }} />;
    if (score >= 2) return <BulbOutlined style={{ fontSize: 24, color: '#1890ff' }} />;
    return <RocketOutlined style={{ fontSize: 24, color: '#faad14' }} />;
  };

  return (
    <div style={{ marginTop: 20 }}>
      {slots?.beforeResults}
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
            {getGradeIcon(bandScore ?? 0)}
            <span>Quiz Evaluation: {band}</span>
          </Space>
        }
        extra={slots?.headerExtra}
        style={{ marginBottom: 16 }}
      >
        <QuizGradeHero band={band} />

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
              {evaluationData.feedback_strengths.map((strength: string, index: number) => (
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
                {evaluationData.feedback_improvements.map((improvement: string, index: number) => (
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
              {evaluationData.question_results.map((result: QuestionResult) => {
                // Coloured by the question's credit where the viewer has it
                // (staff); a student's results carry none (E1).
                const creditPct = result.credit_earned;
                return (
                  <Card
                    key={result.question_num}
                    size="small"
                    style={{
                      textAlign: 'center',
                      ...(typeof creditPct === 'number'
                        ? { borderColor: getScoreColor(creditPct) }
                        : {}),
                    }}
                  >
                    <div style={{ fontWeight: 'bold' }}>Q{result.question_num}</div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {result.attempts} attempt{result.attempts !== 1 ? 's' : ''}
                    </div>
                    {/* The emoji stored with the result (the classroom's scale), never recomputed. */}
                    <div style={{ fontSize: 20 }}>
                      {result.emoji ? <Emoji emoji={result.emoji} fontSize={20} /> : null}
                    </div>
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
