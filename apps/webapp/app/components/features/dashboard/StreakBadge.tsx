import { Card } from 'antd';
import dayjs from 'dayjs';
import { CardHeader } from '~/components';

interface StreakBadgeProps {
  days: number;
  lastGradedAt: string | null;
}

const StreakBadge = ({ days, lastGradedAt }: StreakBadgeProps) => {
  const hasStreak = days > 0;
  return (
    <Card className="h-full !rounded-2xl" data-testid="streak-badge">
      <CardHeader>Grading Streak</CardHeader>
      {hasStreak ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-ink-0">
              {days}
            </span>
            <span className="text-sm text-ink-3">
              day{days === 1 ? '' : 's'}
            </span>
            <span aria-hidden className="text-xl">
              🔥
            </span>
          </div>
          {lastGradedAt && (
            <div className="text-xs text-ink-3">
              Last graded {dayjs(lastGradedAt).fromNow()}
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-ink-2 leading-snug">
          Start a streak — grade 1 assignment today
        </div>
      )}
    </Card>
  );
};

export default StreakBadge;
