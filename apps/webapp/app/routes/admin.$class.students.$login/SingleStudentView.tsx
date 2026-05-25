import { Tag, Table } from 'antd';

import {
  EmojisDisplay,
  TableActionButtons,
  EmojiGrader,
  RepositoryAssignmentStatus,
  LateOverrideButton,
} from '~/components';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import useStore from '~/store';
import {
  applyLatePenalty,
  calculateNumericGrade,
  calculateRepositoryGrade,
  calculateGrades,
  isRepositoryAssignmentDropped,
  type OrganizationSettings,
  type LetterGradeMappingEntry,
} from '@classmoji/utils';

interface StudentGrade {
  id: string;
  emoji: string;
  grader?: { name: string };
}

interface StudentAssignment {
  id: string;
  title: string;
  weight: number;
  student_deadline: string;
}

interface StudentModule {
  id: string;
  title: string;
  type: string;
  weight: number;
  is_extra_credit: boolean;
}

interface StudentRepoAssignment {
  id: string;
  assignment_id: string;
  provider_issue_number: number;
  assignment: StudentAssignment;
  grades: StudentGrade[];
  is_late: boolean;
  is_late_override: boolean;
  num_late_hours: number;
  extension_hours: number;
  repository: {
    name: string;
    student_id: string;
    [key: string]: unknown;
  };
  graders: Array<{ grader: { id: string; login: string; name: string } }>;
  [key: string]: unknown;
}

interface Student {
  name: string | null;
  login: string | null;
  avatar_url?: string | null;
  image?: string | null;
  school_id?: string | null;
  [key: string]: unknown;
}

interface SingleStudentViewProps {
  assignments?: StudentModule[];
  student: Student | null;
  issuesGroupedByAssignment?: Record<string, StudentRepoAssignment[]>;
  emojiMappings: unknown;
  settings: unknown;
  letterGradeMappings: unknown;
  tokenBalance: number;
  modules?: StudentModule[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma query shapes vary across grouped assignment views
  repositoryAssignmentsGroupedByModule?: Record<string, any[]>;
  classroom?: Record<string, unknown>;
}

const SingleStudentView = (props: SingleStudentViewProps) => {
  const {
    assignments,
    student,
    issuesGroupedByAssignment,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
    modules,
    repositoryAssignmentsGroupedByModule,
  } = props;

  const { classroom } = useStore();

  const effectiveAssignments = assignments || modules || [];
  const effectiveIssuesGrouped =
    issuesGroupedByAssignment || repositoryAssignmentsGroupedByModule || {};

  const repositories = effectiveAssignments
    .map(module => {
      const assignments = effectiveIssuesGrouped[module.id] || [];
      return { module, assignments };
    })
    .filter(repo => repo.assignments.length > 0);

  const { finalNumericGrade, finalLetterGrade, rawNumericGrade, rawLetterGrade } = calculateGrades(
    repositories,
    emojiMappings as Record<string, number>,
    settings as OrganizationSettings,
    letterGradeMappings as LetterGradeMappingEntry[]
  );

  const assignmentColumns = [
    {
      title: 'Module',
      dataIndex: 'title',
      key: 'module',
      render: (title: string) => (
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 bg-primary dark:bg-primary rounded-full"></div>
          <span className="font-medium text-ink-0">{title}</span>
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (
        <Tag color={type === 'INDIVIDUAL' ? 'blue' : 'purple'}>
          {type.charAt(0) + type.slice(1).toLowerCase()}
        </Tag>
      ),
    },
    {
      title: 'Weight',
      dataIndex: 'weight',
      key: 'weight',
      render: (weight: number) => (
        <span className="font-medium text-ink-0">{weight}%</span>
      ),
    },
    {
      title: 'Repository Grade',
      key: 'repositoryGrade',
      render: (_: unknown, module: StudentModule) => {
        const repositoryAssignments = effectiveIssuesGrouped[module.id];
        const grade = calculateRepositoryGrade(
          repositoryAssignments,
          emojiMappings as Record<string, number>,
          settings as OrganizationSettings,
          module
        );

        if (grade === -1) return <Tag color="red">No Grade</Tag>;

        if (module.is_extra_credit) {
          return (
            <span className="font-bold text-green-600">+ {(grade * module.weight) / 100}</span>
          );
        }

        return <span className="font-bold text-ink-0">{grade}</span>;
      },
    },
  ];

  const getRepositoryAssignmentColumns = (
    moduleAssignment: StudentModule,
    allRepositoryAssignments: StudentRepoAssignment[]
  ) => [
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
      width: '20%',
      render: (title: string) => (
        <span className="font-medium text-ink-1">{title}</span>
      ),
    },
    {
      title: 'Weight',
      dataIndex: ['assignment', 'weight'],
      key: 'weight',
      width: '10%',
      render: (weight: number) => (
        <span className="font-medium text-ink-0">{weight}%</span>
      ),
    },
    {
      title: 'Emoji Grade',
      key: 'emojiGrade',
      dataIndex: ['grades'],
      width: '10%',
      render: (grades: StudentGrade[]) => {
        if (!grades.length) return <span className="text-ink-3 italic">No grades yet</span>;
        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Grade',
      key: 'grade',
      dataIndex: ['grades'],
      width: '10%',
      render: (grades: StudentGrade[], repositoryAssignment: StudentRepoAssignment) => {
        if (!grades.length) return <span className="text-ink-3 italic">No grades yet</span>;
        const rawGrade = calculateNumericGrade(
          grades.map(({ emoji }) => emoji),
          emojiMappings as Record<string, number>
        );

        const grade = applyLatePenalty(
          rawGrade,
          repositoryAssignment,
          settings as OrganizationSettings
        );

        const getGradeColor = (grade: number) => {
          if (grade >= 90) return 'text-green-600';
          if (grade >= 80) return 'text-yellow-600';
          if (grade >= 70) return 'text-orange-600';
          return 'text-red-600';
        };

        return <span className={`font-bold ${getGradeColor(grade)}`}>{grade}</span>;
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: '25%',
      render: (repoAssignment: StudentRepoAssignment) => {
        const dropped = isRepositoryAssignmentDropped(
          repoAssignment?.id,
          allRepositoryAssignments,
          emojiMappings as Record<string, number>,
          settings as OrganizationSettings,
          moduleAssignment
        );
        return (
          <RepositoryAssignmentStatus repositoryAssignment={repoAssignment} isDropped={dropped} />
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      dataIndex: 'actions',
      width: '20%',
      render: (_: unknown, record: StudentRepoAssignment) => {
        return (
          <TableActionButtons
            onView={
              classroom?.git_organization?.login
                ? () => openRepositoryAssignmentInGithub(classroom.git_organization.login, record)
                : undefined
            }
          >
            <EmojiGrader
              repositoryAssignment={{
                id: record.id,
                assignment_id: record.assignment_id,
                studentId: record.repository.student_id,
                grades: record.grades,
                repository: record.repository,
              }}
              emojiMappings={emojiMappings as Record<string, unknown>}
            />
            <LateOverrideButton repositoryAssignment={record} />
          </TableActionButtons>
        );
      },
    },
  ];

  const expandedRowRender = (record: StudentModule) => {
    const repositoryAssignments = effectiveIssuesGrouped[record.id] || [];

    const sortedRepositoryAssignments = repositoryAssignments.sort(
      (a: StudentRepoAssignment, b: StudentRepoAssignment) => {
        const dateDiff =
          new Date(a.assignment.student_deadline).getTime() -
          new Date(b.assignment.student_deadline).getTime();
        return dateDiff !== 0 ? dateDiff : a.assignment.title.localeCompare(b.assignment.title);
      }
    );

    return (
      <Table
        columns={getRepositoryAssignmentColumns(record, sortedRepositoryAssignments)}
        dataSource={sortedRepositoryAssignments}
        rowHoverable={false}
        pagination={false}
        size="small"
        showHeader={true}
        bordered={false}
        scroll={{ x: 'max-content' }}
      />
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <img
          className="rounded-full h-11 w-11 sm:h-14 sm:w-14 object-cover ring-2 ring-primary-50 dark:ring-primary/30"
          src={student?.avatar_url ?? student?.image ?? undefined}
          alt={student?.name ?? undefined}
        />
        <div className="min-w-0">
          <h1 className="font-bold text-lg text-ink-0">{student?.name}</h1>
          <div className="flex items-center gap-2 text-sm text-ink-3">
            <span>@{student?.login}</span>
            {student?.school_id && (
              <>
                <span className="text-ink-4">&middot;</span>
                <span>ID: {student.school_id}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-xl ring-1 ring-line p-3 text-center">
          <div className="text-xs font-medium text-ink-3 mb-1">Raw Letter</div>
          <div className="text-xl font-bold text-ink-0">{rawNumericGrade >= 0 ? rawLetterGrade : 'N/A'}</div>
        </div>
        <div className="rounded-xl ring-1 ring-line p-3 text-center">
          <div className="text-xs font-medium text-ink-3 mb-1">Final Letter</div>
          <div className="text-xl font-bold text-ink-0">{finalNumericGrade >= 0 ? finalLetterGrade : 'N/A'}</div>
        </div>
        <div className="rounded-xl ring-1 ring-line p-3 text-center">
          <div className="text-xs font-medium text-ink-3 mb-1">Raw Score</div>
          <div className="text-xl font-bold text-ink-0">{rawNumericGrade >= 0 ? rawNumericGrade : 'N/A'}</div>
        </div>
        <div className="rounded-xl ring-1 ring-line p-3 text-center">
          <div className="text-xs font-medium text-ink-3 mb-1">Final Score</div>
          <div className="text-xl font-bold text-ink-0">{finalNumericGrade >= 0 ? finalNumericGrade : 'N/A'}</div>
        </div>
        <div className="rounded-xl ring-1 ring-line p-3 text-center">
          <div className="text-xs font-medium text-ink-3 mb-1">Tokens</div>
          <div className="text-xl font-bold text-ink-0">{tokenBalance}</div>
          {tokenBalance < 10 && (
            <div className="text-xs text-red-500 mt-1">Low balance</div>
          )}
        </div>
      </div>

      <Table
        columns={assignmentColumns}
        dataSource={effectiveAssignments}
        rowKey={a => a.id}
        expandable={{
          expandedRowRender,
          rowExpandable: record => (effectiveIssuesGrouped[record.id]?.length || 0) > 0,
          defaultExpandedRowKeys: effectiveAssignments
            .filter(m => (effectiveIssuesGrouped[m.id]?.length || 0) > 0)
            .map(m => m.id),
        }}
        rowHoverable={false}
        pagination={false}
        size="middle"
        bordered={true}
        scroll={{ x: 'max-content' }}
      />
    </div>
  );
};

export default SingleStudentView;
