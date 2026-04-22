import { Link } from 'react-router';
import { Card, Empty, Tag } from 'antd';
import dayjs from 'dayjs';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'ASSIGNMENTS',
    action: 'view_assignments_index',
  });

  const rows = await ClassmojiService.dashboard.assignmentHealthWithCounts(
    classroom.id,
  );

  return { classSlug, rows };
};

function ProgressBar({
  value,
  total,
  tone,
}: {
  value: number;
  total: number;
  tone: 'accent' | 'green';
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  // `accent` tone follows the classroom accent CSS variable; `green` stays
  // semantic (completion) so it reads distinctly against the in-progress bar.
  const fillStyle: React.CSSProperties =
    tone === 'accent'
      ? { width: `${pct}%`, backgroundColor: 'var(--accent)' }
      : { width: `${pct}%` };
  const fillClass =
    tone === 'accent' ? 'h-full' : 'h-full bg-emerald-500 dark:bg-emerald-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div className={fillClass} style={fillStyle} />
      </div>
      <span className="tabular-nums text-xs text-gray-700 dark:text-gray-200">
        {value}/{total}
      </span>
    </div>
  );
}

const AssignmentsIndex = ({ loaderData }: Route.ComponentProps) => {
  const { classSlug, rows } = loaderData;

  return (
    <div className="flex flex-col gap-4" data-testid="assignments-index">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Assignments
        </h1>
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty
            description={
              <span className="text-gray-500 dark:text-gray-400">
                No assignments yet.
              </span>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                  <th className="py-2 pr-4 font-semibold">Assignment</th>
                  <th className="py-2 pr-4 font-semibold">Module</th>
                  <th className="py-2 pr-4 font-semibold">Due</th>
                  <th className="py-2 pr-4 font-semibold">Submitted</th>
                  <th className="py-2 pr-4 font-semibold">Graded</th>
                  <th className="py-2 pr-4 font-semibold text-right">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.assignmentId}
                    className="border-b border-gray-50 dark:border-gray-800 last:border-0"
                    data-testid={`assignment-row-${r.assignmentId}`}
                  >
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {r.title}
                        </span>
                        {r.kind && (
                          <Tag className="text-[10px] dark:border-gray-700">
                            {r.kind}
                          </Tag>
                        )}
                        {r.lateCount > 0 && (
                          <Tag
                            color="warning"
                            className="text-[10px] dark:border-amber-800"
                          >
                            {r.lateCount} late
                          </Tag>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-gray-600 dark:text-gray-300">
                      {r.moduleTitle}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 dark:text-gray-300">
                      {r.deadline ? (
                        <span
                          className="tabular-nums"
                          title={new Date(r.deadline).toLocaleString()}
                        >
                          {dayjs(r.deadline).format('MMM D, YYYY')}
                        </span>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <ProgressBar
                        value={r.submitted}
                        total={r.total}
                        tone="accent"
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <ProgressBar
                        value={r.graded}
                        total={r.total}
                        tone="green"
                      />
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <Link
                        to={`/admin/${classSlug}/grades?assignmentId=${r.assignmentId}`}
                        className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                        data-testid={`assignment-open-${r.assignmentId}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default AssignmentsIndex;
