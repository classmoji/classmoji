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
  calculateNumericGrade,
  calculateRepositoryGrade,
  calculateGrades,
  isRepositoryAssignmentDropped,
} from '@classmoji/utils';
import InfoCard from './InfoCard';

const SingleStudentView = props => {
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

  const { classroom } = useStore(state => state);

  // Support both old and new prop naming conventions
  const effectiveAssignments = assignments || modules || [];
  const effectiveIssuesGrouped =
    issuesGroupedByAssignment || repositoryAssignmentsGroupedByModule || {};

  // Build repositories array for grade calculation
  // calculateGrades expects { module, assignments } where assignments is array of repository assignments
  const repositories = effectiveAssignments
    .map(module => {
      const assignments = effectiveIssuesGrouped[module.id] || [];
      return { module, assignments };
    })
    .filter(repo => repo.assignments.length > 0);

  const { finalNumericGrade, finalLetterGrade, rawNumericGrade, rawLetterGrade } = calculateGrades(
    repositories,
    emojiMappings,
    settings,
    letterGradeMappings
  );

  const assignmentColumns = [
    {
      title: 'Module',
      dataIndex: 'title',
      key: 'module',
      render: title => (
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
      render: type => (
        <Tag color={type === 'INDIVIDUAL' ? 'blue' : 'purple'}>
          {type.charAt(0) + type.slice(1).toLowerCase()}
        </Tag>
      ),
    },
    {
      title: 'Weight',
      dataIndex: 'weight',
      key: 'weight',
      render: weight => (
        <span className="font-medium text-gray-900 dark:text-gray-100">{weight}%</span>
      ),
    },
    {
      title: 'Repository Grade',
      key: 'repositoryGrade',
      render: (_, module) => {
        const repositoryAssignments = effectiveIssuesGrouped[module.id];
        const grade = calculateRepositoryGrade(repositoryAssignments, emojiMappings, settings, module);

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

  const getRepositoryAssignmentColumns = (moduleAssignment, allRepositoryAssignments) => [
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
      width: '20%',
      render: title => (
        <span className="font-medium text-gray-800 dark:text-gray-200">{title}</span>
      ),
    },
    {
      title: 'Weight',
      dataIndex: ['assignment', 'weight'],
      key: 'weight',
      width: '10%',
      render: weight => (
        <span className="font-medium text-gray-900 dark:text-gray-100">{weight}%</span>
      ),
    },
    {
      title: 'Emoji Grade',
      key: 'emojiGrade',
      dataIndex: ['grades'],
      width: '10%',
      render: grades => {
        if (!grades.length) return <span className="text-gray-500 italic">No grades yet</span>;
        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Grade',
      key: 'grade',
      dataIndex: ['grades'],
      width: '10%',
      render: (grades, repositoryAssignment) => {
        if (!grades.length) return <span className="text-gray-500 italic">No grades yet</span>;
        let grade = calculateNumericGrade(
          grades.map(({ emoji }) => emoji),
          emojiMappings
        );

        // Deduct points for late submissions unless late override is used
        // Note: num_late_hours, is_late_override, extension_hours are on the RepositoryAssignment
        if (
          repositoryAssignment.num_late_hours > 0 &&
          repositoryAssignment.is_late_override == false
        ) {
          grade =
            grade -
            (repositoryAssignment.num_late_hours + repositoryAssignment.extension_hours) *
              settings.late_penalty_points_per_hour;
        }

        // When late hours is more than 100, set grade to 0
        if (grade < 0) grade = 0;

        const getGradeColor = grade => {
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
      render: repoAssignment => {
        // Check if this repository assignment is dropped for this student
        const dropped = isRepositoryAssignmentDropped(
          repoAssignment?.id,
          allRepositoryAssignments,
          emojiMappings,
          settings,
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
      render: (_, record) => {
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

  const expandedRowRender = record => {
    const repositoryAssignments = effectiveIssuesGrouped[record.id] || [];

    const sortedRepositoryAssignments = repositoryAssignments.sort((a, b) => {
      const dateDiff = a.assignment.student_deadline - b.assignment.student_deadline;
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
                src={student.avatar_url}
                alt={student.name}
              />
              <div className="absolute -bottom-2 -right-2 w-8 h-8 bg-primary dark:bg-primary rounded-full flex items-center justify-center shadow-lg">
                <span className="text-white font-bold text-sm">★</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="font-bold text-xl text-gray-900">{student.name}</h1>
              <h3 className="text-gray-600 font-medium">@{student.login}</h3>
              <h3 className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                ID: {student.school_id}
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
                .filter(m => (effectiveIssuesGrouped[m.id]?.length || 0) > 0)
                .map(m => m.id),
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
