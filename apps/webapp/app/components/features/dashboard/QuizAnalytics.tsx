import { Card } from 'antd';
import { CardHeader } from '~/components';

export interface QuizAnalyticsData {
  hardestQuestions: Array<{ questionId: string; prompt: string; correctRate: number }>;
  avgFocusPct: number | null;
}

interface QuizAnalyticsProps {
  data: QuizAnalyticsData;
}

const QuizAnalytics = ({ data }: QuizAnalyticsProps) => {
  const pct = data.avgFocusPct;
  const display = pct === null ? '—' : `${Math.round(pct * 100)}%`;

  return (
    <Card className="h-full !rounded-2xl" data-testid="quiz-analytics">
      <CardHeader>Quiz Analytics</CardHeader>
      <div className="flex flex-col items-center justify-center py-8">
        <div className="text-xs uppercase tracking-wide text-ink-3 font-semibold mb-2">
          Avg Focus
        </div>
        <div
          className="text-6xl font-bold text-primary-600 dark:text-primary-400 tabular-nums"
          data-testid="avg-focus-pct"
        >
          {display}
        </div>
        <div className="text-xs text-ink-3 mt-2">
          Across all quiz attempts in this class
        </div>
      </div>

      <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
        <div className="text-xs uppercase tracking-wide text-ink-3 font-semibold mb-2">
          Hardest Questions
        </div>
        {data.hardestQuestions.length === 0 ? (
          <div className="text-sm text-ink-3 italic">
            Hardest questions analytics coming soon
          </div>
        ) : (
          <ul className="space-y-2">
            {data.hardestQuestions.map(q => (
              <li key={q.questionId} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-ink-1 flex-1 truncate">{q.prompt}</span>
                <span className="text-rose-ink dark:text-red-300 font-semibold tabular-nums">
                  {Math.round(q.correctRate * 100)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
};

export default QuizAnalytics;
