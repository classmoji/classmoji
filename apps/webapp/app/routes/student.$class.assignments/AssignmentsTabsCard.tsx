import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { motion, useReducedMotion } from 'framer-motion';
import { IconExternalLink } from '@tabler/icons-react';
import type { StudentCourseworkRow } from '@classmoji/services';
import Emoji from '~/components/ui/display/Emoji';
import TokenExtensionPopover from '~/components/features/TokenExtensionPopover';
import { CommitCount } from '~/components/features/analytics';
import {
  CourseworkStatusPill,
  CourseworkTypeTag,
} from '~/components/features/assignments/CourseworkTags';
import { POP_SPRING } from '~/utils/motion';
import { formatDeadline } from './formatDeadline';
import { useGitWeb } from '~/hooks/useGitWeb';

/** The Current / Completed split: a done row is submitted, completed or closed. */
export type AssignmentStatus = 'current' | 'completed';

type TabKey = 'current' | 'completed' | 'all';

interface AssignmentsTabsCardProps {
  rows: StudentCourseworkRow[];
  balance: number;
  /** The tab shown first; Current unless said otherwise. */
  initialTab?: TabKey;
}

const TAB_ORDER: { key: TabKey; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

const moduleTypeLabel: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  GROUP: 'Group',
};

const emptyCopy: Record<TabKey, string> = {
  current: 'No current assignments. You’re all caught up.',
  completed: 'Nothing completed yet.',
  all: 'No assignments yet.',
};

const Dash = () => <span className="text-gray-400 dark:text-gray-600">—</span>;

const attemptsLine = (row: StudentCourseworkRow) => {
  if (row.attemptsUsed === null) return null;
  const used = row.attemptsUsed;
  if (!row.maxAttempts) return `${used} ${used === 1 ? 'attempt' : 'attempts'} used`;
  return `${used} of ${row.maxAttempts} ${row.maxAttempts === 1 ? 'attempt' : 'attempts'} used`;
};

/** The row's title, linked to where the student does the work. */
const TitleLink = ({ row }: { row: StudentCourseworkRow }) => {
  const web = useGitWeb();
  const className =
    'inline-flex items-center gap-1.5 font-medium text-ink-0! hover:underline underline-offset-2';
  if (!row.href) return <span className="font-medium text-ink-0">{row.title}</span>;
  if (!row.external) {
    return (
      <Link to={row.href} className={className}>
        {row.title}
      </Link>
    );
  }
  const title =
    row.type === 'FORM'
      ? 'Open the form'
      : row.repo?.issueUrl
        ? `Open the ${web.label} issue for this assignment`
        : 'Open the repository you submit this in';
  return (
    <a href={row.href} target="_blank" rel="noreferrer" title={title} className={className}>
      <span>{row.title}</span>
      <IconExternalLink size={13} className="shrink-0 text-gray-400 dark:text-gray-500" />
    </a>
  );
};

const AssignmentsTabsCard = ({
  rows,
  balance,
  initialTab = 'current',
}: AssignmentsTabsCardProps) => {
  const web = useGitWeb();
  const [active, setActive] = useState<TabKey>(initialTab);
  const reducedMotion = useReducedMotion();
  const { class: classSlug } = useParams();

  // An untracked row (a PUBLIC form, open or closed) is neither still to do
  // nor done for this student: it is listed under All only.
  const tabOf = (row: StudentCourseworkRow): AssignmentStatus | null =>
    !row.tracked ? null : row.done ? 'completed' : 'current';

  const counts: Record<TabKey, number> = {
    current: rows.filter(r => tabOf(r) === 'current').length,
    completed: rows.filter(r => tabOf(r) === 'completed').length,
    all: rows.length,
  };

  const filtered = active === 'all' ? rows : rows.filter(r => tabOf(r) === active);

  return (
    <div className="h-full flex flex-col">
      <div data-tour="assignments-tabs" className="flex -mb-px relative">
        {TAB_ORDER.map(({ key, label }, idx) => {
          const isActive = key === active;
          const baseZ = TAB_ORDER.length - idx;
          const zStyle = { zIndex: isActive ? 10 : baseZ };
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
                  ? 'bg-panel border-line border-b-transparent'
                  : 'bg-nav-hover text-ink-3 border-line hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {label}
              <span
                className={`ml-2 text-xs tabular-nums ${isActive ? 'text-ink-3' : 'text-ink-4'}`}
              >
                {counts[key]}
              </span>
            </button>
          );
        })}
      </div>

      <section className="flex-1 rounded-2xl rounded-tl-none bg-panel border border-line min-h-[calc(100vh-10rem)] flex flex-col">
        {filtered.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-ink-3">
            {emptyCopy[active]}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs font-semibold tracking-[0.08em] uppercase text-ink-3">
                <tr className="border-b border-line">
                  <th className="text-left px-4 py-3 font-semibold w-[1%]">Type</th>
                  <th className="text-left px-4 py-3 font-semibold">Assignment</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-left px-4 py-3 font-semibold hidden lg:table-cell">Grade</th>
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
                  // Only a row still to do counts down to (or past) its date.
                  const tab = tabOf(row) ?? 'completed';
                  const repo = row.repo;
                  const canRequestRegrade =
                    !!repo && row.done && repo.gradesReleased && !!classSlug;
                  const isLate =
                    !!repo && !row.done && repo.numLateHours > 0 && !repo.isLateOverride;
                  const meta = [
                    row.module.title,
                    row.isExtraCredit ? 'Extra credit' : null,
                    attemptsLine(row),
                  ].filter(Boolean);

                  return (
                    <tr
                      key={row.assignmentId}
                      className="border-b last:border-b-0 border-stone-100 dark:border-neutral-800/70 hover:bg-stone-50/70 dark:hover:bg-neutral-800/40 transition-colors align-top"
                    >
                      <td className="px-4 py-3">
                        <CourseworkTypeTag type={row.type} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <TitleLink row={row} />
                          <span className="text-xs text-ink-3">{meta.join(' · ')}</span>
                          {repo && (
                            // The student's own repository: the only place they
                            // reach it, with its commits and the kind of repo.
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-600 dark:text-gray-300">
                              {repo.repoUrl ? (
                                <a
                                  href={repo.repoUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={`Open your repository on ${web.label}`}
                                  className="inline-flex items-center gap-1 max-w-[14rem] text-gray-700! dark:text-gray-200! hover:text-ink-0! hover:underline underline-offset-2 transition-colors"
                                >
                                  <span className="truncate">
                                    {repo.repositoryTitle || 'Repository'}
                                  </span>
                                  <IconExternalLink
                                    size={12}
                                    className="shrink-0 text-gray-400 dark:text-gray-500"
                                  />
                                </a>
                              ) : (
                                <span className="truncate max-w-[14rem]">
                                  {repo.repositoryTitle || '—'}
                                </span>
                              )}
                              {repo.commitCount !== null && (
                                <CommitCount snapshot={{ total_commits: repo.commitCount }} />
                              )}
                              {repo.moduleType && (
                                <span className="text-ink-3">
                                  {moduleTypeLabel[repo.moduleType] ??
                                    repo.moduleType.charAt(0) +
                                      repo.moduleType.slice(1).toLowerCase()}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {row.status === null ? (
                          <Dash />
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {row.status === 'SUBMITTED' || row.status === 'COMPLETED' ? (
                              <motion.span
                                initial={reducedMotion ? false : { scale: 0.6, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={POP_SPRING}
                                className="inline-flex"
                              >
                                <CourseworkStatusPill status={row.status} />
                              </motion.span>
                            ) : (
                              <CourseworkStatusPill status={row.status} />
                            )}
                            {isLate && (
                              <span className="inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-300">
                                {repo!.numLateHours}h late
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {repo ? (
                          // A released grade shows whether or not the student
                          // has submitted: staff can grade an open assignment
                          // (a zero, an extension), and hiding it read as "no
                          // grade".
                          repo.gradesReleased && repo.grades.length > 0 ? (
                            <div className="flex items-center gap-1">
                              {repo.grades.slice(0, 4).map((g, idx) => (
                                <Emoji key={g.id ?? idx} emoji={g.emoji} fontSize={18} />
                              ))}
                            </div>
                          ) : row.done ? (
                            <span className="text-xs text-ink-3">Pending</span>
                          ) : (
                            <Dash />
                          )
                        ) : row.score !== null ? (
                          <span className="font-semibold tabular-nums text-ink-1">
                            {Math.round(row.score * 10) / 10}%
                          </span>
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-gray-600 dark:text-gray-300">
                        {repo?.gradersSummary ? (
                          <span className="block truncate max-w-[10rem]">
                            {repo.gradersSummary}
                          </span>
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap text-gray-600 dark:text-gray-300">
                        {row.deadline ? formatDeadline(row.deadline, tab) : <Dash />}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {canRequestRegrade ? (
                          <Link
                            to={`/student/${classSlug}/regrade-requests/new`}
                            state={{
                              assignment: { id: repo!.gitRepoAssignmentId, title: row.title },
                            }}
                            className="inline-flex items-center text-xs font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-line bg-panel hover:bg-nav-hover transition-colors"
                          >
                            Request regrade
                          </Link>
                        ) : isLate ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200">
                            Extend
                            <TokenExtensionPopover
                              repositoryAssignment={{
                                id: repo!.gitRepoAssignmentId,
                                num_late_hours: repo!.numLateHours,
                                is_late_override: repo!.isLateOverride,
                                assignment: {
                                  student_deadline: row.deadline ?? '',
                                  tokens_per_hour: repo!.tokensPerHour,
                                },
                              }}
                              balance={balance}
                            />
                          </span>
                        ) : (
                          <Dash />
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
