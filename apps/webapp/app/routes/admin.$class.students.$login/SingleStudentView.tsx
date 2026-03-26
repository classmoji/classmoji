import { Card, Tag, Table } from 'antd';

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
import InfoCard from './InfoCard';

interface StudentGrade {
  emoji: string;
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
    // Also accept alternative prop names from route.jsx
    modules,
    repositoryAssignmentsGroupedByModule,
  } = props;

  const { classroom } = useStore();

  // Support both old and new prop naming conventions
  const effectiveAssignments = assignments || modules || [];
  const effectiveIssuesGrouped =
    issuesGroupedByAssignment || repositoryAssignmentsGroupedByModule || {};

  // Build repositories array for grade calculation
  // calculateGrades expects { module, assignments } where assignments is array of repository assignments
  const repositories = effectiveAssignments
    .map((module) => {
      const assignments = effectiveIssuesGrouped[module.id] || [];
      return { module, assignments };
    })
    .filter((repo) => repo.assignments.length > 0);

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
          <span className="font-medium text-gray-900 dark:text-gray-100">{title}</span>
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
        <span className="font-medium text-gray-900 dark:text-gray-100">{weight}%</span>
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

        return <span className="font-bold text-gray-900">{grade}</span>;
      },
    },
  ];

  const getRepositoryAssignmentColumns = (moduleAssignment: StudentModule, allRepositoryAssignments: StudentRepoAssignment[]) => [
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
      width: '20%',
      render: (title: string) => (
        <span className="font-medium text-gray-800 dark:text-gray-200">{title}</span>
      ),
    },
    {
      title: 'Weight',
      dataIndex: ['assignment', 'weight'],
      key: 'weight',
      width: '10%',
      render: (weight: number) => (
        <span className="font-medium text-gray-900 dark:text-gray-100">{weight}%</span>
      ),
    },
    {
      title: 'Emoji Grade',
      key: 'emojiGrade',
      dataIndex: ['grades'],
      width: '10%',
      render: (grades: StudentGrade[]) => {
        if (!grades.length) return <span className="text-gray-500 italic">No grades yet</span>;
        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Grade',
      key: 'grade',
      dataIndex: ['grades'],
      width: '10%',
      render: (grades: StudentGrade[], repositoryAssignment: StudentRepoAssignment) => {
        if (!grades.length) return <span className="text-gray-500 italic">No grades yet</span>;
        const rawGrade = calculateNumericGrade(
          grades.map(({ emoji }) => emoji),
          emojiMappings as Record<string, number>
        );

        const grade = applyLatePenalty(rawGrade, repositoryAssignment, settings as OrganizationSettings);

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
        // Check if this repository assignment is dropped for this student
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
              repositoryAssignment={{ ...record, studentId: record.repository.student_id }}
              emojiMappings={emojiMappings}
            />
            <LateOverrideButton repositoryAssignment={record} />
          </TableActionButtons>
        );
      },
    },
  ];

  const expandedRowRender = (record: StudentModule) => {
    const repositoryAssignments = effectiveIssuesGrouped[record.id] || [];

    const sortedRepositoryAssignments = repositoryAssignments.sort((a: StudentRepoAssignment, b: StudentRepoAssignment) => {
      const dateDiff = new Date(a.assignment.student_deadline).getTime() - new Date(b.assignment.student_deadline).getTime();
      return dateDiff !== 0 ? dateDiff : a.assignment.title.localeCompare(b.assignment.title);
    });

    return (
      <Table
        columns={getRepositoryAssignmentColumns(record, sortedRepositoryAssignments)}
        dataSource={sortedRepositoryAssignments}
        rowHoverable={false}
        pagination={false}
        size="small"
        showHeader={true}
        bordered={false}
      />
    );
  };

  return (
    <div className="grid grid-cols-5 gap-8">
      <div className="col-span-1">
        {/* Student Profile Card */}
        <Card className="shadow-xs hover:shadow-md transition-shadow duration-200 border ">
          <div className="flex flex-col items-center gap-6 justify-center">
            <div className="relative">
              <img
                className="rounded-full h-[120px] w-[120px] object-cover ring-4 ring-primary-50 dark:ring-primary/30 shadow-lg"
                src={student?.avatar_url ?? student?.image ?? undefined}
                alt={student?.name ?? undefined}
              />
              <div className="absolute -bottom-2 -right-2 w-8 h-8 bg-primary dark:bg-primary rounded-full flex items-center justify-center shadow-lg">
                <span className="text-white font-bold text-sm">★</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="font-bold text-xl text-gray-900">{student?.name}</h1>
              <h3 className="text-gray-600 font-medium">@{student?.login}</h3>
              <h3 className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                ID: {student?.school_id}
              </h3>
            </div>
          </div>
        </Card>

        {/* Grade Cards */}
        <div className="grid grid-cols-2 gap-4 mt-6">
          <InfoCard title="Raw Letter" value={`${rawNumericGrade >= 0 ? rawLetterGrade : 'N/A'}`} />
          <InfoCard
            title="Final Letter"
            value={`${finalNumericGrade >= 0 ? finalLetterGrade : 'N/A'}`}
          />
          <InfoCard title="Raw Score" value={`${rawNumericGrade >= 0 ? rawNumericGrade : 'N/A'}`} />
          <InfoCard
            title="Final Score"
            value={`${finalNumericGrade >= 0 ? finalNumericGrade : 'N/A'}`}
          />
          <InfoCard
            title="Token Balance"
            value={tokenBalance}
            note={tokenBalance < 10 ? 'Low balance' : null}
          />
        </div>
      </div>

      <div className="col-span-4">
        {/* Assignments Table */}
        <Card className="shadow-xs">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-primary dark:bg-primary rounded-full"></div>
            <h2 className="text-xl font-bold text-gray-900">Module Overview</h2>
          </div>
          <Table
            columns={assignmentColumns}
            dataSource={effectiveAssignments}
            rowKey={a => a.id}
            expandable={{
              expandedRowRender,
              rowExpandable: record => (effectiveIssuesGrouped[record.id]?.length || 0) > 0,
              defaultExpandedRowKeys: effectiveAssignments
                .filter((m) => (effectiveIssuesGrouped[m.id]?.length || 0) > 0)
                .map((m) => m.id),
            }}
            rowHoverable={false}
            pagination={false}
            size="middle"
            bordered={true}
          />
        </Card>
      </div>
    </div>
  );
};

export default SingleStudentView;
