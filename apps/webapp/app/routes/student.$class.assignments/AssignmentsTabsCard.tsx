import { useState } from 'react';
import { Link, useParams } from 'react-router';
import dayjs from 'dayjs';
import { IconBrandGithub } from '@tabler/icons-react';
import Emoji from '~/components/ui/display/Emoji';

export type AssignmentStatus = 'current' | 'completed';

export interface AssignmentRow {
  id: string;
  assignmentTitle: string;
  moduleTitle: string;
  moduleType: string | null;
  status: AssignmentStatus;
  gradesReleased: boolean;
  studentDeadline: string | null;
  issueUrl: string | null;
  grades: { id: string; emoji: string }[];
  gradersSummary: string;
}

interface AssignmentsTabsCardProps {
  rows: AssignmentRow[];
}

type TabKey = 'current' | 'completed' | 'all';

const TAB_ORDER: { key: TabKey; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

const moduleTypeLabel: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  GROUP: 'Group',
};

const statusPillStyle: Record<AssignmentStatus, string> = {
  current: 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]',
  completed: 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]',
};

const statusPillLabel: Record<AssignmentStatus, string> = {
  current: 'Not submitted',
  completed: 'Submitted',
};

const emptyCopy: Record<TabKey, string> = {
  current: 'No current assignments. You’re all caught up.',
  completed: 'Nothing submitted yet.',
  all: 'No assignments yet.',
};

const formatDeadline = (deadline: string) => {
  const target = dayjs(deadline);
  const today = dayjs().startOf('day');
  const days = target.startOf('day').diff(today, 'day');
  if (days < 0) return `overdue · ${target.format('MMM D')}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return target.format('MMM D');
};

const AssignmentsTabsCard = ({ rows }: AssignmentsTabsCardProps) => {
  const [active, setActive] = useState<TabKey>('current');
  const { class: classSlug } = useParams();

  const counts: Record<TabKey, number> = {
    current: rows.filter(r => r.status === 'current').length,
    completed: rows.filter(r => r.status === 'completed').length,
    all: rows.length,
  };

  const filtered =
    active === 'all' ? rows : rows.filter(r => r.status === active);

  return (
    <div className="h-full flex flex-col">
      <div className="flex -mb-px relative">
        {TAB_ORDER.map(({ key, label }, idx) => {
          const isActive = key === active;
          const baseZ = TAB_ORDER.length - idx;
          const zStyle = { zIndex: isActive ? 40 : baseZ };
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              style={
                isActive
                  ? { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                  : zStyle
              }
              className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-white dark:bg-neutral-900 border-stone-200 dark:border-neutral-800 border-b-transparent'
                  : 'bg-stone-100 dark:bg-neutral-800 text-gray-500 dark:text-gray-400 border-stone-200 dark:border-neutral-700 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {label}
              <span
                className={`ml-2 text-[11px] tabular-nums ${
                  isActive ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {counts[key]}
              </span>
            </button>
          );
        })}
      </div>

      <section className="flex-1 rounded-2xl rounded-tl-none bg-white dark:bg-neutral-900 border border-stone-200 dark:border-neutral-800 min-h-[calc(100vh-10rem)] flex flex-col">
        {filtered.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-gray-500 dark:text-gray-400">
            {emptyCopy[active]}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] font-semibold tracking-[0.08em] uppercase text-gray-500 dark:text-gray-400">
                <tr className="border-b border-stone-200 dark:border-neutral-800">
                  <th className="text-left px-4 py-3 font-semibold">Module</th>
                  <th className="text-left px-4 py-3 font-semibold">Assignment</th>
                  <th className="text-left px-4 py-3 font-semibold hidden md:table-cell">Type</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-left px-4 py-3 font-semibold hidden lg:table-cell">
                    Grading
                  </th>
                  <th className="text-left px-4 py-3 font-semibold hidden lg:table-cell">
                    Graders
                  </th>
                  <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell">
                    Deadline
                  </th>
                  <th className="px-4 py-3" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const canRequestRegrade =
                    row.status === 'completed' && row.gradesReleased && !!classSlug;
                  return (
                    <tr
                      key={row.id}
                      className="border-b last:border-b-0 border-stone-100 dark:border-neutral-800/70 hover:bg-stone-50/70 dark:hover:bg-neutral-800/40 transition-colors align-top"
                    >
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        <span className="block truncate max-w-[12rem]">
                          {row.moduleTitle || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-gray-100">
                            {row.assignmentTitle}
                          </span>
                          {row.moduleType === 'INDIVIDUAL' && row.issueUrl && (
                            <a
                              href={row.issueUrl}
                              target="_blank"
                              rel="noreferrer"
                              title="View GitHub issue"
                              aria-label="View GitHub issue"
                              className="inline-flex items-center justify-center w-6 h-6 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-stone-100 dark:hover:bg-neutral-800 transition-colors"
                            >
                              <IconBrandGithub size={14} />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell text-gray-600 dark:text-gray-300">
                        {row.moduleType ? (
                          moduleTypeLabel[row.moduleType] ??
                          row.moduleType.charAt(0) + row.moduleType.slice(1).toLowerCase()
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusPillStyle[row.status]}`}
                        >
                          {statusPillLabel[row.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {row.status === 'completed' && row.gradesReleased && row.grades.length > 0 ? (
                          <div className="flex items-center gap-1">
                            {row.grades.slice(0, 4).map((g, idx) => (
                              <Emoji key={g.id ?? idx} emoji={g.emoji} fontSize={18} />
                            ))}
                          </div>
                        ) : row.status === 'completed' ? (
                          <span className="text-xs text-gray-500 dark:text-gray-400">Pending</span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-gray-600 dark:text-gray-300">
                        {row.gradersSummary ? (
                          <span className="block truncate max-w-[10rem]">
                            {row.gradersSummary}
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap text-gray-600 dark:text-gray-300">
                        {row.studentDeadline ? (
                          formatDeadline(row.studentDeadline)
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canRequestRegrade ? (
                          <Link
                            to={`/student/${classSlug}/regrade-requests/new`}
                            state={{ assignment: { id: row.id, title: row.assignmentTitle } }}
                            className="inline-flex items-center text-xs font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 bg-white dark:bg-neutral-900 hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
                          >
                            Request regrade
                          </Link>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default AssignmentsTabsCard;
