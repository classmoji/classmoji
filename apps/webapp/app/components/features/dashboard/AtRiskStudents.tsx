import { Card, Tag } from 'antd';
import { CardHeader } from '~/components';

export interface AtRiskStudent {
  userId: string;
  name: string | null;
  login: string;
  missedDeadlines: number;
}

interface AtRiskStudentsProps {
  atRiskCount: number;
  students: AtRiskStudent[];
}

const AtRiskStudents = ({ atRiskCount, students }: AtRiskStudentsProps) => {
  return (
    <Card className="h-full" data-testid="at-risk-students">
      <div className="flex items-center justify-between">
        <CardHeader>At-Risk Students</CardHeader>
        <Tag
          className="border-0 bg-rose-bg dark:bg-red-900/30 text-rose-ink dark:text-red-300 font-semibold"
          data-testid="at-risk-count"
        >
          {atRiskCount} total
        </Tag>
      </div>
      {students.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
          No at-risk students. Nice work!
        </div>
      ) : (
        <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto">
          {students.map((s) => {
            const initials = (s.name || s.login || '?')
              .split(' ')
              .map((p) => p[0])
              .filter(Boolean)
              .slice(0, 2)
              .join('')
              .toUpperCase();
            return (
              <div
                key={s.userId}
                className="flex items-center justify-between p-2 rounded-lg hover:bg-paper dark:hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {s.login ? (
                    <img
                      src={`https://github.com/${s.login}.png`}
                      alt={s.name || s.login}
                      className="w-8 h-8 rounded-full ring-1 ring-gray-200 dark:ring-gray-700 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {initials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                      {s.name || s.login || 'Unknown'}
                    </div>
                    {s.login && (
                      <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                        @{s.login}
                      </div>
                    )}
                  </div>
                </div>
                <Tag className="border-0 bg-amber-bg dark:bg-yellow-900/30 text-amber-ink dark:text-yellow-300 font-medium">
                  {s.missedDeadlines} missed
                </Tag>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default AtRiskStudents;
