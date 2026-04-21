import { Card, Tag } from 'antd';
import { CardHeader } from '~/components';
import UserAvatar from '~/components/shared/UserAvatar';

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
          {students.map((s) => (
            <div
              key={s.userId}
              className="flex items-center justify-between p-2 rounded-lg hover:bg-paper dark:hover:bg-gray-800 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <UserAvatar login={s.login} name={s.name} seed={s.userId} size={32} />
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
          ))}
        </div>
      )}
    </Card>
  );
};

export default AtRiskStudents;
