import { Switch, Table } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  IconCircleCheck,
  IconFileCheck,
  IconFileDescription,
  IconPencilCheck,
  IconClipboardList,
  IconClockExclamation,
  IconListDetails,
} from '@tabler/icons-react';
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

type TabKey =
  | 'overview'
  | 'submitted'
  | 'unsubmitted'
  | 'ungraded'
  | 'graded'
  | 'overdue'
  | 'all';

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
        dayjs().isAfter(dayjs(a.assignment.grader_deadline)) &&
        (!a.grades || a.grades.length === 0)
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
                  openRepositoryAssignmentInGithub(
                    classroom.git_organization.login,
                    repoAssignment
                  )
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
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4 min-h-8">
        <h1 className="text-base font-semibold leading-8 text-gray-600 dark:text-gray-400">
          Grading
        </h1>

        <div className="flex items-center gap-3">
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
            className="w-64"
          />
        </div>
      </div>

      <div className="flex -mb-px relative overflow-x-auto">
        {TAB_ORDER.map((tab, idx) => {
          const isActive = tab.key === active;
          const baseZ = TAB_ORDER.length - idx;
          const zStyle = { zIndex: isActive ? 40 : baseZ };
          const count = counts[tab.key];
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              style={zStyle}
              className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 border-stone-200 dark:border-neutral-800 border-b-transparent'
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

      <section className="rounded-2xl rounded-tl-none bg-white dark:bg-neutral-900 border border-stone-200 dark:border-neutral-800 p-4 sm:p-5 min-h-[calc(100vh-10rem)] flex flex-col">
        {filtered.length === 0 ? (
          (() => {
            const { icon: Icon, title, subtitle } = emptyStates[active];
            return (
              <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                <Icon
                  size={36}
                  strokeWidth={1.5}
                  className="text-gray-400 dark:text-gray-500"
                />
                <div>
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                    {title}
                  </div>
                  {subtitle && (
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {subtitle}
                    </div>
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
            pagination={{
              pageSize: 15,
              showSizeChanger: true,
              showQuickJumper: true,
              pageSizeOptions: ['10', '15', '25', '50'],
              showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
            }}
          />
        )}
      </section>
    </div>
  );
};

export default RepositoryAssignmentsTable;
