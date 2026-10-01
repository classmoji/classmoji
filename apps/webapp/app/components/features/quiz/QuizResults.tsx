import { Alert, Card, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import {
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  RocketOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import type { QuizEvaluationRecordV2 } from '@classmoji/utils/quiz-agent';
import Emoji from '~/components/ui/display/Emoji';
import { formatDuration } from '~/utils/quizUtils';

const { Title, Text } = Typography;

/**
 * The results panel of a chat-runtime attempt, rendered from its stored
 * evaluation record (`evaluation_json`, or the same record carried by the
 * evaluation tool part / `data-evaluation`). Scores and each question's emoji
 * are the stored values; nothing is recomputed here. A record the server
 * completed from the recorded results (`source: 'server'`) has no feedback
 * text, and the panel simply shows its band, the scores and per-question
 * results.
 */
export interface ResultsFocusMetrics {
  totalMs: number | null;
  focusedMs: number;
  percentage: number;
}

interface QuizResultsProps {
  evaluation: QuizEvaluationRecordV2;
  focusMetrics?: ResultsFocusMetrics | null;
}

/** The same five bands the legacy evaluation card uses. */
const scoreColor = (percentage: number) => {
  if (percentage >= 90) return '#52c41a';
  if (percentage >= 70) return '#1890ff';
  if (percentage >= 50) return '#faad14';
  if (percentage >= 30) return '#fa8c16';
  return '#f5222d';
};

const gradeIcon = (score: number | undefined) => {
  if ((score ?? 0) >= 3) return <TrophyOutlined style={{ fontSize: 24, color: '#52c41a' }} />;
  if ((score ?? 0) >= 2) return <BulbOutlined style={{ fontSize: 24, color: '#1890ff' }} />;
  return <RocketOutlined style={{ fontSize: 24, color: '#faad14' }} />;
};

const roundScore = (value: number) => Math.round(Number(value || 0) * 10) / 10;

function QuizResults({ evaluation, focusMetrics = null }: QuizResultsProps) {
  const feedback = evaluation.feedback;
  // The band the server stores on every completion, its own included; a
  // record stored before it was added has it in the model's feedback only.
  const band = evaluation.evaluation ?? feedback?.evaluation ?? null;
  const bandScore = evaluation.numeric_score ?? feedback?.numeric_score;
  const score = roundScore(evaluation.partial_credit_percentage);
  const results = [...(evaluation.question_results ?? [])].sort(
    (a, b) => a.question_num - b.question_num
  );

  return (
    <div className="mt-5" data-testid="quiz-results">
      <Alert
        message="Quiz Complete!"
        description="Your responses have been evaluated. Here are your results:"
        type="success"
        showIcon
        style={{ marginBottom: 20 }}
      />

      <Card
        title={
          band ? (
            <Space>
              {gradeIcon(bandScore)}
              <span>Quiz Evaluation: {band}</span>
            </Space>
          ) : (
            <span>Quiz Results</span>
          )
        }
        style={{ marginBottom: 16 }}
      >
        <div className="mb-5 text-center">
          <Progress
            type="circle"
            percent={score}
            strokeColor={scoreColor(score)}
            format={percent => (
              <div>
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {percent}%
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">Score</div>
              </div>
            )}
          />
        </div>

        {feedback?.feedback_summary && (
          <div className="mb-5">
            <Title level={5}>Summary</Title>
            <Text>{feedback.feedback_summary}</Text>
          </div>
        )}

        {feedback && feedback.feedback_strengths.length > 0 && (
          <div className="mb-5">
            <Title level={5}>
              <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 8 }} />
              Strengths
            </Title>
            <ul className="list-disc pl-5">
              {feedback.feedback_strengths.map((strength, i) => (
                <li key={i}>
                  <Text>{strength}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}

        {feedback && feedback.feedback_improvements.length > 0 && (
          <div className="mb-5">
            <Title level={5}>
              <BulbOutlined style={{ color: '#faad14', marginRight: 8 }} />
              Areas for Improvement
            </Title>
            <ul className="list-disc pl-5">
              {feedback.feedback_improvements.map((improvement, i) => (
                <li key={i}>
                  <Text>{improvement}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}

        {feedback?.feedback_recommendation && (
          <div className="mb-5">
            <Title level={5}>
              <RocketOutlined style={{ color: '#1890ff', marginRight: 8 }} />
              Next Steps
            </Title>
            <Text>{feedback.feedback_recommendation}</Text>
          </div>
        )}

        {feedback?.feedback_effort_note && (
          <Alert
            message="Learning Journey"
            description={feedback.feedback_effort_note}
            type="info"
            showIcon={false}
            style={{ marginTop: 16 }}
          />
        )}

        {focusMetrics && (
          <div className="mt-4 mb-3">
            <Tooltip
              title="We track how much time you spent actively engaged with the quiz (tab visible and focused) versus time spent away. This helps measure your focus and demonstrates you completed the quiz independently without external resources."
              placement="top"
            >
              <Space
                size="small"
                wrap
                className="cursor-help rounded-md border border-stone-100 bg-stone-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800"
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

        {results.length > 0 && (
          <div className="mt-5">
            <Title level={5}>Question Performance</Title>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
              {results.map(result => (
                <div
                  key={result.question_num}
                  data-testid="quiz-result-question"
                  className="rounded-lg border-2 bg-white p-2 text-center dark:bg-neutral-900"
                  style={{ borderColor: scoreColor(result.credit_earned) }}
                >
                  <div className="font-bold text-gray-900 dark:text-gray-100">
                    Q{result.question_num}
                    {result.revised ? (
                      <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                        (revised)
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {result.attempts} attempt{result.attempts !== 1 ? 's' : ''}
                  </div>
                  <div className="my-1">
                    <Emoji emoji={result.emoji} fontSize={20} />
                  </div>
                  {result.brief_feedback && (
                    <div className="text-xs text-gray-600 dark:text-gray-400">
                      {result.brief_feedback}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default QuizResults;
