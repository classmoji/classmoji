import { Switch, Table, Tooltip, Skeleton, Alert } from 'antd';
import { useParams } from 'react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconCircleCheck,
  IconFileCheck,
  IconFileDescription,
  IconPencilCheck,
  IconClipboardList,
  IconClockExclamation,
  IconListDetails,
  IconChartBar,
  IconChevronDown,
} from '@tabler/icons-react';
import {
  GitHubStatsPanel,
  type GitHubStatsSnapshot,
  type EligibleStudent,
} from '~/components/features/analytics';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import { emojis } from '@classmoji/utils';
import dayjs from 'dayjs';
import useStore from '~/store';
import {
  EmojiGrader,
  UserThumbnailView,
  SearchInput,
  Countdown,
  TableActionButtons,
  EmojisDisplay,
} from '~/components';

interface GradeEntry {
  id: string;
  emoji: string;
  grader?: { name: string | null } | null;
  token_transaction?: { amount: number } | null;
}

interface AssignmentInfo {
  title: string;
  grader_deadline: string | Date | null;
}

interface StudentOrTeam {
  name?: string | null;
  login?: string | null;
  slug?: string | null;
  avatar_url?: string | null;
}

interface RepositoryInfo {
  name: string;
  student?: StudentOrTeam | null;
  team?: StudentOrTeam | null;
  student_id?: string | null;
  module: { title: string };
}

interface RepoAssignment {
  id: string;
  status: string;
  assignment_id: string;
  assignment: AssignmentInfo;
  grades: GradeEntry[];
  repository: RepositoryInfo;
  provider_issue_number?: number;
}

interface ModuleItem {
  title: string;
}

interface RepositoryAssignmentsTableProps {
  allRepositoryAssignments: RepoAssignment[];
  repositoryAssignments: RepoAssignment[];
  modules: ModuleItem[];
  emojiMappings:
    | Record<string, number>
    | { emoji: string; grade: number; [key: string]: unknown }[];
}

type TabKey = 'overview' | 'submitted' | 'unsubmitted' | 'ungraded' | 'graded' | 'overdue' | 'all';

const TAB_ORDER: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'unsubmitted', label: 'Unsubmitted' },
  { key: 'ungraded', label: 'Needs grading' },
  { key: 'graded', label: 'Graded' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'All' },
];

interface EmptyState {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  title: string;
  subtitle?: string;
}

const emptyStates: Record<TabKey, EmptyState> = {
  overview: {
    icon: IconCircleCheck,
    title: 'All caught up!',
    subtitle: 'No urgent grading tasks.',
  },
  submitted: {
    icon: IconFileCheck,
    title: 'Nothing submitted yet',
    subtitle: 'Submitted assignments will appear here.',
  },
  unsubmitted: {
    icon: IconFileDescription,
    title: 'All assignments submitted',
    subtitle: 'No outstanding work from students.',
  },
  ungraded: {
    icon: IconPencilCheck,
    title: 'Nothing waiting to be graded',
    subtitle: 'Great job staying on top of grading.',
  },
  graded: {
    icon: IconClipboardList,
    title: 'No graded assignments yet',
    subtitle: 'Graded work will show up here.',
  },
  overdue: {
    icon: IconClockExclamation,
    title: 'No overdue grading',
    subtitle: "You're on time with every deadline.",
  },
  all: {
    icon: IconListDetails,
    title: 'No assignments yet',
    subtitle: 'Nothing to show for this classroom.',
  },
};

const RepositoryAssignmentsTable = ({
  allRepositoryAssignments,
  repositoryAssignments,
  modules,
  emojiMappings,
}: RepositoryAssignmentsTableProps) => {
  const [userQuery, setUserQuery] = useState('');
  const [showMyAssignments, setShowMyAssignments] = useState(true);
  const [active, setActive] = useState<TabKey>('overview');
  const { classroom } = useStore();
  const params = useParams();
  const classSlug = params.class as string | undefined;

  // Inline GitHub-analytics drawer — row-level lazy load + cache.
  type AnalyticsData = {
    snapshot: GitHubStatsSnapshot | null;
    deadline: string | null;
    repositoryId: string;
    students: EligibleStudent[];
  };
  type CacheEntry =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: AnalyticsData; refreshing?: boolean };

  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [analyticsCache, setAnalyticsCache] = useState<Record<string, CacheEntry>>({});

  const loadAnalytics = useCallback(async (repoAssignmentId: string) => {
    setAnalyticsCache(prev => {
      if (prev[repoAssignmentId]?.status === 'ready') return prev;
      return { ...prev, [repoAssignmentId]: { status: 'loading' } };
    });
    try {
      const res = await fetch(`/api/repos/${repoAssignmentId}/analytics`);
      if (!res.ok) {
        throw new Error((await res.text()) || `Failed (${res.status})`);
      }
      const data = (await res.json()) as AnalyticsData;
      setAnalyticsCache(prev => ({
        ...prev,
        [repoAssignmentId]: { status: 'ready', data },
      }));
    } catch (err) {
      setAnalyticsCache(prev => ({
        ...prev,
        [repoAssignmentId]: {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  const refreshAnalytics = useCallback(
    async (repoAssignmentId: string) => {
      setAnalyticsCache(prev => {
        const entry = prev[repoAssignmentId];
        if (!entry || entry.status !== 'ready') return prev;
        return {
          ...prev,
          [repoAssignmentId]: { ...entry, refreshing: true },
        };
      });
      try {
        const res = await fetch(`/api/repos/${repoAssignmentId}/refresh`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error((await res.text()) || `Failed (${res.status})`);
        // Give the trigger workflow a moment, then re-read the snapshot.
        setTimeout(() => {
          void loadAnalytics(repoAssignmentId);
        }, 1200);
      } catch (err) {
        setAnalyticsCache(prev => ({
          ...prev,
          [repoAssignmentId]: {
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [loadAnalytics]
  );

  const toggleAnalytics = useCallback(
    (repoAssignmentId: string) => {
      setExpandedKeys(prev => {
        const isOpen = prev.includes(repoAssignmentId);
        if (!isOpen) void loadAnalytics(repoAssignmentId);
        return isOpen ? prev.filter(k => k !== repoAssignmentId) : [...prev, repoAssignmentId];
      });
    },
    [loadAnalytics]
  );

  const base = showMyAssignments ? repositoryAssignments : allRepositoryAssignments;
  const searched = useMemo(() => {
    if (!userQuery.trim()) return base;
    const q = userQuery.toLowerCase();
    return base.filter(a => {
      const student = a.repository?.student;
      const team = a.repository?.team;
      return (
        student?.name?.toLowerCase().includes(q) ||
        student?.login?.toLowerCase().includes(q) ||
        team?.name?.toLowerCase().includes(q) ||
        team?.slug?.toLowerCase().includes(q)
      );
    });
  }, [base, userQuery]);

  const counts = useMemo(() => {
    const submitted = searched.filter(a => a.status === 'CLOSED');
    const unsubmitted = searched.filter(a => a.status === 'OPEN');
    const graded = searched.filter(a => a.grades?.length > 0);
    const ungraded = searched.filter(a => !a.grades || a.grades.length === 0);
    const overdue = searched.filter(
      a =>
        dayjs().isAfter(dayjs(a.assignment.grader_deadline)) && (!a.grades || a.grades.length === 0)
    );
    const overview = searched
      .filter(
        a =>
          (a.status === 'CLOSED' && (!a.grades || a.grades.length === 0)) ||
          (dayjs().isAfter(dayjs(a.assignment.grader_deadline)) &&
            (!a.grades || a.grades.length === 0))
      )
      .slice(0, 10);
    return {
      overview: overview.length,
      submitted: submitted.length,
      unsubmitted: unsubmitted.length,
      ungraded: ungraded.length,
      graded: graded.length,
      overdue: overdue.length,
      all: searched.length,
    };
  }, [searched]);

  const filtered = useMemo(() => {
    switch (active) {
      case 'submitted':
        return searched.filter(a => a.status === 'CLOSED');
      case 'unsubmitted':
        return searched.filter(a => a.status === 'OPEN');
      case 'graded':
        return searched.filter(a => a.grades?.length > 0);
      case 'ungraded':
        return searched.filter(a => !a.grades || a.grades.length === 0);
      case 'overdue':
        return searched.filter(
          a =>
            dayjs().isAfter(dayjs(a.assignment.grader_deadline)) &&
            (!a.grades || a.grades.length === 0)
        );
      case 'all':
        return searched;
      case 'overview':
      default:
        return searched
          .filter(
            a =>
              (a.status === 'CLOSED' && (!a.grades || a.grades.length === 0)) ||
              (dayjs().isAfter(dayjs(a.assignment.grader_deadline)) &&
                (!a.grades || a.grades.length === 0))
          )
          .slice(0, 10);
    }
  }, [active, searched]);

  useEffect(() => {
    // When switching data sources, reset page implicitly via key (Table handles this)
  }, [showMyAssignments]);

  const columns = [
    {
      title: 'Owner',
      dataIndex: ['repository'],
      key: 'student',
      render: (repo: RepositoryInfo) => {
        const user = repo.student ?? repo.team ?? undefined;
        return <UserThumbnailView user={user} />;
      },
    },
    {
      title: 'Module',
      dataIndex: ['repository', 'module', 'title'],
      key: 'module',
      filters:
        active === 'all'
          ? modules.map(({ title }: ModuleItem) => ({ text: title, value: title }))
          : undefined,
      onFilter: (value: React.Key | boolean, record: RepoAssignment) =>
        record.repository.module.title === value,
    },
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
    },
    {
      title: 'Grade',
      key: 'grades',
      dataIndex: ['grades'],
      filters:
        active === 'all'
          ? [
              ...Object.keys(emojis).map(key => ({
                text: emojis[key].emoji,
                value: key,
              })),
              { text: 'No Grade', value: 'NO_GRADE' },
            ]
          : undefined,
      onFilter: (value: React.Key | boolean, record: RepoAssignment) => {
        if (value === 'NO_GRADE') return !record.grades.length;
        return record.grades.some((grade: GradeEntry) => grade.emoji === value);
      },
      render: (grades: GradeEntry[]) => <EmojisDisplay grades={grades} />,
    },
    {
      title: 'Status',
      dataIndex: ['status'],
      key: 'status',
      filters:
        active === 'all'
          ? [
              { text: 'Not submitted', value: 'OPEN' },
              { text: 'Submitted', value: 'CLOSED' },
            ]
          : undefined,
      onFilter: (value: React.Key | boolean, record: RepoAssignment) => record.status === value,
      render: (status: string) => {
        const isClosed = status === 'CLOSED';
        const className = isClosed
          ? 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]'
          : 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]';
        return (
          <span
            className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${className}`}
          >
            {isClosed ? 'Submitted' : 'Not submitted'}
          </span>
        );
      },
    },
    {
      title: 'Grading Deadline',
      dataIndex: ['assignment', 'grader_deadline'],
      key: 'deadline',
      render: (deadline: string, record: RepoAssignment) => {
        const isOverdue = dayjs().isAfter(dayjs(deadline));
        return (
          <div>
            <Countdown deadline={deadline} />
            {isOverdue && (!record.grades || record.grades.length === 0) && (
              <p className="pt-2 text-xs font-semibold text-red-600">Grading overdue</p>
            )}
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, repoAssignment: RepoAssignment) => (
        <TableActionButtons
          onView={
            classroom?.git_organization?.login
              ? () =>
                  openRepositoryAssignmentInGithub(classroom.git_organization.login, repoAssignment)
              : undefined
          }
        >
          <EmojiGrader
            repositoryAssignment={{
              id: repoAssignment.id,
              assignment_id: repoAssignment.assignment_id,
              studentId: repoAssignment.repository.student_id ?? undefined,
              grades: repoAssignment.grades,
              repository: repoAssignment.repository,
            }}
            emojiMappings={emojiMappings as Record<string, unknown>}
          />
          {classSlug
            ? (() => {
                const isOpen = expandedKeys.includes(repoAssignment.id);
                return (
                  <Tooltip title={isOpen ? 'Hide analytics' : 'Show analytics'}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={event => {
                        event.stopPropagation();
                        toggleAnalytics(repoAssignment.id);
                      }}
                      className={`inline-flex items-center justify-center h-7 w-7 rounded-md transition-all duration-200 ease-out ${
                        isOpen
                          ? 'bg-primary-50 text-primary-600 ring-1 ring-primary-200 dark:bg-primary-900/30 dark:text-primary-300 dark:ring-primary-800/60'
                          : 'text-gray-500 hover:text-primary-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-primary-300 dark:hover:bg-neutral-800'
                      }`}
                    >
                      <span className="relative inline-block w-4 h-4">
                        <IconChartBar
                          size={16}
                          className={`absolute inset-0 transition-all duration-200 ease-out ${
                            isOpen
                              ? 'opacity-0 -rotate-90 scale-75'
                              : 'opacity-100 rotate-0 scale-100'
                          }`}
                        />
                        <IconChevronDown
                          size={16}
                          className={`absolute inset-0 transition-all duration-200 ease-out ${
                            isOpen
                              ? 'opacity-100 rotate-0 scale-100'
                              : 'opacity-0 rotate-90 scale-75'
                          }`}
                        />
                      </span>
                    </button>
                  </Tooltip>
                );
              })()
            : null}
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-2 mb-4 sm:min-h-8">
        <h1 className="text-base font-semibold leading-8 text-gray-600 dark:text-gray-400">
          Grading
        </h1>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap">
            <span className="font-medium">My assigned only</span>
            <Switch
              size="small"
              onChange={value => setShowMyAssignments(value)}
              checked={showMyAssignments}
            />
          </label>
          <SearchInput
            query={userQuery}
            setQuery={setUserQuery}
            placeholder="Search by name or login..."
            className="flex-1 min-w-0 sm:flex-none sm:w-64"
          />
        </div>
      </div>

      <div className="flex -mb-px relative overflow-x-auto">
        {TAB_ORDER.map((tab, idx) => {
          const isActive = tab.key === active;
          const baseZ = TAB_ORDER.length - idx;
          const zStyle = { zIndex: isActive ? 10 : baseZ };
          const count = counts[tab.key];
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              style={
                isActive
                  ? { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                  : zStyle
              }
              className={`relative px-3 py-1.5 text-xs sm:px-4 sm:py-2 sm:text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-panel border-stone-200 dark:border-neutral-800 border-b-transparent'
                  : 'bg-stone-100 dark:bg-neutral-800 text-gray-500 dark:text-gray-400 border-stone-200 dark:border-neutral-700 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
              <span
                className={`ml-2 text-[11px] tabular-nums ${
                  isActive ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <section className="rounded-2xl rounded-tl-none bg-panel border border-stone-200 dark:border-neutral-800 p-4 sm:p-5 min-h-[calc(100vh-10rem)] flex flex-col">
        {filtered.length === 0 ? (
          (() => {
            const { icon: Icon, title, subtitle } = emptyStates[active];
            return (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                <Icon size={36} strokeWidth={1.5} className="text-gray-400 dark:text-gray-500" />
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {title}
                  </div>
                  {subtitle && (
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</div>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          <Table
            columns={columns}
            dataSource={filtered}
            rowKey="id"
            rowHoverable={false}
            size="middle"
            scroll={{ x: 'max-content' }}
            pagination={{
              pageSize: 15,
              showSizeChanger: true,
              showQuickJumper: true,
              pageSizeOptions: ['10', '15', '25', '50'],
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
            }}
            expandable={{
              expandedRowKeys: expandedKeys,
              showExpandColumn: false,
              expandedRowClassName: () => 'analytics-expanded-row',
              expandedRowRender: (record: RepoAssignment) => {
                const entry = analyticsCache[record.id];
                return (
                  <div className="px-1 py-2 animate-[fadeSlideIn_240ms_cubic-bezier(0.22,1,0.36,1)_both]">
                    {!entry || entry.status === 'loading' ? (
                      <div className="py-4">
                        <Skeleton active paragraph={{ rows: 4 }} />
                      </div>
                    ) : entry.status === 'error' ? (
                      <Alert
                        type="error"
                        showIcon
                        message="Couldn't load analytics"
                        description={entry.message}
                        closable
                      />
                    ) : (
                      <GitHubStatsPanel
                        snapshot={entry.data.snapshot}
                        deadline={entry.data.deadline}
                        repositoryId={entry.data.repositoryId}
                        students={entry.data.students}
                        refreshing={Boolean(entry.refreshing)}
                        onRefresh={() => refreshAnalytics(record.id)}
                      />
                    )}
                  </div>
                );
              },
            }}
          />
        )}
      </section>
    </div>
  );
};

export default RepositoryAssignmentsTable;
