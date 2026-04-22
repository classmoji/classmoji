import { Card, Empty, Tag } from 'antd';
import { CardHeader } from '~/components';
import UserAvatar from '~/components/shared/UserAvatar';

export interface MyDayQueueRow {
  repositoryAssignmentId: string;
  studentName: string | null;
  studentLogin: string | null;
  assignmentTitle: string;
  ageDays: number;
}

interface MyDayQueueProps {
  queue: MyDayQueueRow[];
}

function slaColor(ageDays: number): { color: string; label: string } {
  if (ageDays > 7) return { color: 'red', label: `${ageDays}d` };
  if (ageDays > 3) return { color: 'orange', label: `${ageDays}d` };
  return { color: 'default', label: `${ageDays}d` };
}

const MyDayQueue = ({ queue }: MyDayQueueProps) => {
  return (
    <Card className="h-full" data-testid="my-day-queue">
      <CardHeader>My Day</CardHeader>
      {queue.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-gray-500 dark:text-gray-400">Inbox zero — nice.</span>
          }
        />
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {queue.map((row) => {
            const sla = slaColor(row.ageDays);
            const displayName = row.studentName || row.studentLogin || 'Unknown';
            return (
              <li
                key={row.repositoryAssignmentId}
                className="flex items-center gap-3 py-2 min-w-0"
                data-testid="my-day-row"
              >
                <UserAvatar
                  login={row.studentLogin}
                  name={row.studentName}
                  seed={row.repositoryAssignmentId}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {displayName}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {row.assignmentTitle}
                  </div>
                </div>
                <Tag color={sla.color} className="flex-shrink-0 tabular-nums">
                  {sla.label}
                </Tag>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
};

export default MyDayQueue;
