import { Table, Tag, Tooltip, Skeleton, Tabs, Popover } from 'antd';
import { useParams, useNavigate, Await } from 'react-router';
import React, { Suspense, useState } from 'react';
import { namedAction } from 'remix-utils/named-action';
import { IconRotate } from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import useStore from '~/store';
import TokenPopupForm from './TokenPopupForm';
import { groupByAssignment } from '~/utils/helpers.client';
import { assertClassroomAccess } from '~/utils/helpers';
import {
  ProTierFeature,
  Countdown,
  EmojisDisplay,
  Emoji,
  PageHeader,
  StatsCard,
  TableActionButtons,
} from '~/components';
import { calculateGrades } from '@classmoji/utils';

interface Grade {
  emoji: string;
}

interface Grader {
  id: string;
  login: string;
  name: string;
}

interface GraderAssignment {
  grader: Grader;
}

interface Assignment {
  title: string;
  student_deadline: string;
  weight: number;
  grades_released: boolean;
}

interface Module {
  title: string;
  type: string;
  weight: number;
}

interface GitOrganization {
  login: string;
}

interface Classroom {
  git_organization: GitOrganization;
}

interface Repository {
  name: string;
  module: Module;
  classroom: Classroom;
}

interface RepositoryAssignment {
  id: string;
  status: string;
  is_late: boolean;
  is_late_override: boolean;
  num_late_hours: number;
  extension_hours: number;
  provider_issue_number: number;
  grades: Grade[];
  graders: GraderAssignment[];
  assignment: Assignment;
  repository: Repository;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_DASHBOARD',
    attemptedAction: 'view_dashboard',
  });
  const promises = {
    repoAssignments: ClassmojiService.repositoryAssignment.findForUser({
      repository: { student_id: userId, classroom_id: classroom.id },
    }),
    emojiMappings: ClassmojiService.emojiMapping.findByClassroomId(classroom.id),
    settings: ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id),
    letterGradeMappings: ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id),
    membership: ClassmojiService.classroomMembership.findByClassroomAndUser(classroom.id, userId),
    classroomEmojiMappings: ClassmojiService.emojiMapping.findClassroomEmojiMappingDescription(
      classroom.id
    ),
  };
  return {
    data: Promise.all(Object.values(promises)),
  };
};

const StudentDashboard = ({ loaderData }: Route.ComponentProps) => {
  const { data } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('current');
  // Get token balance from parent route via Zustand
  const { tokenBalance } = useStore();

  // Filter functions for different tabs
  const filterRepositoryAssignments = (repoAssignments: RepositoryAssignment[], tab: string) => {
    switch (tab) {
      case 'current':
        return repoAssignments
          .filter(repoAssignment => repoAssignment.status === 'OPEN')
          .sort((a, b) =>
            dayjs(a.assignment.student_deadline).diff(dayjs(b.assignment.student_deadline))
          );
      case 'completed':
        return repoAssignments.filter(repoAssignment => repoAssignment.status === 'CLOSED');
      case 'all':
        return repoAssignments;
      case 'overview':
      default:
        return repoAssignments
          .filter(
            repoAssignment =>
              repoAssignment.status === 'OPEN' &&
              (repoAssignment.is_late ||
                dayjs(repoAssignment.assignment.student_deadline).diff(dayjs(), 'days') <= 3)
          )
          .slice(0, 5);
    }
  };

  const getColumns = ({ emojiMappings = {} }) => [
    {
      title: 'Module',
      dataIndex: ['repository', 'module', 'title'],
      key: 'module',
    },
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
      render: (title: string) => {
        return <p> {title}</p>;
      },
    },
    {
      title: 'Type',
      dataIndex: ['repository', 'module', 'type'],
      key: 'type',
      render: (type: string) => {
        return (
          <Tag bordered={false}>{type?.charAt(0).toUpperCase() + type?.slice(1).toLowerCase()}</Tag>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      filters:
        activeTab === 'all'
          ? [
              { text: 'Not Submitted', value: 'OPEN' },
              { text: 'Submitted', value: 'CLOSED' },
            ]
          : undefined,
      onFilter: (value: React.Key | boolean, record: RepositoryAssignment) =>
        record.status === value,
      render: (_: unknown, record: RepositoryAssignment) => {
        let color = '';
        let text = '';
        if (record.status === 'OPEN') {
          color = 'red';
          text = 'Not Submitted';
        } else if (record.status === 'CLOSED') {
          color = 'green';
          text = 'Submitted';
        }
        return (
          <div className="flex items-center">
            <Tag color={color} bordered={false}>
              {text}
            </Tag>
          </div>
        );
      },
    },
    {
      title: (
        <div className="flex items-center gap-1">
          <span>Grade</span>
          {Object.keys(emojiMappings).length > 0 && (
            <Popover
              content={
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {Object.entries(emojiMappings).map(([key, mapping]) => {
                    const m = mapping as { emoji: string; description?: string };
                    return (
                      <div key={key} className="flex items-center gap-3 py-1">
                        <Emoji emoji={m.emoji} fontSize={20} />
                        <span className="text-sm text-gray-700">
                          {m.description || 'No description'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              }
              title="Grade Descriptions"
              trigger="hover"
              placement="bottom"
            >
              <span className="cursor-help text-base">❓</span>
            </Popover>
          )}
        </div>
      ),
      dataIndex: 'grades',
      key: 'grade',
      render: (grades: Grade[], record: RepositoryAssignment) => {
        if (grades.length === 0 || !record.assignment.grades_released) return null;
        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Grader(s)',
      dataIndex: 'graders',
      key: 'graders',
      render: (graders: GraderAssignment[]) => {
        return (
          <div className="flex flex-col gap-2">
            {graders.map(({ grader }) => {
              return (
                <Tooltip title={`@${grader.login}`} key={grader.id}>
                  {grader.name}
                </Tooltip>
              );
            })}
          </div>
        );
      },
    },
    {
      title: 'Deadline',
      dataIndex: ['assignment', 'student_deadline'],
      key: 'deadline',
      render: (deadline: string, record: RepositoryAssignment) => {
        return (
          <div>
            <Countdown deadline={deadline} />
            <div className="mt-2">
              {record.num_late_hours > 0 && record.is_late_override ? (
                <p className="pt-2 text-sm font-semibold text-green-600">
                  ✓ Late penalty waived by instructor.
                </p>
              ) : (
                <>
                  {record.extension_hours > 0 && record.num_late_hours > 0 && (
                    <p className="pt-2 text-sm font-semibold text-green-600">
                      ➖ {record.extension_hours} extension hour(s).
                    </p>
                  )}
                  {record.num_late_hours > 0 && (
                    <p className="pt-2 text-sm font-semibold text-red-600">
                      ⚠️ {record.num_late_hours} hour(s) late.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, repoAssignment: RepositoryAssignment) => {
        const moduleWeight = repoAssignment.repository.module.weight / 100;
        const assignmentWeight = repoAssignment.assignment.weight / 100;
        const relativeWeight = Math.ceil(assignmentWeight * moduleWeight * 100);
        const doesAssignmentHaveWeight = repoAssignment.repository.module.weight > 0;
        return (
          <TableActionButtons
            onView={() => {
              window.open(
                `https://github.com/${repoAssignment.repository.classroom.git_organization.login}/${repoAssignment.repository.name}/issues/${repoAssignment.provider_issue_number}`,
                '_blank'
              );
            }}
          >
            {doesAssignmentHaveWeight && (
              <ProTierFeature>
                <TokenPopupForm
                  weight={relativeWeight}
                  repositoryAssignment={repoAssignment}
                  balance={tokenBalance}
                />
              </ProTierFeature>
            )}
            {dayjs().isAfter(dayjs(repoAssignment?.assignment?.student_deadline)) &&
              doesAssignmentHaveWeight && (
                <Tooltip title="Request a regrade">
                  <IconRotate
                    className="cursor-pointer"
                    size={16}
                    onClick={() => {
                      navigate(`/student/${classSlug}/regrade-requests/new`, {
                        state: {
                          repositoryAssignment: repoAssignment,
                        },
                      });
                    }}
                  />
                </Tooltip>
              )}
          </TableActionButtons>
        );
      },
    },
  ];

  return (
    <div className="">
      <PageHeader title="Dashboard" routeName="dashboard" />
      <Suspense fallback={<Skeleton active />}>
        <Await resolve={data}>
          {/* Await render function: Promise.all returns heterogeneous tuple that can't be statically typed */}
          {
            ((resolved: unknown) => {
              const [
                repoAssignments,
                emojiMappings,
                settings,
                letterGradeMappings,
                membership,
                orgEmojiMappings,
              ] = resolved as [
                RepositoryAssignment[],
                Record<string, unknown>,
                Record<string, unknown>,
                Record<string, unknown>,
                Record<string, unknown>,
                Record<string, { emoji: string; description?: string }>,
              ];
              const showGradesToStudents = settings.show_grades_to_students as boolean | undefined;
              const repoAssignmentsGroupedByModule = groupByAssignment(
                repoAssignments as unknown as Parameters<typeof groupByAssignment>[0]
              ) as unknown as Record<string, RepositoryAssignment[]>;
              const repositories = Object.values(repoAssignmentsGroupedByModule).map(
                repoAssignmentsInModule => {
                  const repo = repoAssignmentsInModule[0].repository;
                  const assignment = repoAssignmentsInModule[0].assignment;
                  return { ...repo, assignment, repositoryAssignments: repoAssignmentsInModule };
                }
              );
              const { finalLetterGrade } = calculateGrades(
                repositories as unknown as Parameters<typeof calculateGrades>[0],
                emojiMappings as unknown as Parameters<typeof calculateGrades>[1],
                settings as unknown as Parameters<typeof calculateGrades>[2],
                letterGradeMappings as unknown as Parameters<typeof calculateGrades>[3]
              );

              // Calculate counts for different categories - only OPEN assignments can be overdue
              const currentRepoAssignments = repoAssignments.filter(ra => ra.status === 'OPEN');
              const overdueRepoAssignments = repoAssignments.filter(
                ra =>
                  ra.status === 'OPEN' &&
                  (ra.is_late || dayjs().isAfter(dayjs(ra.assignment.student_deadline)))
              );
              const completedRepoAssignments = repoAssignments.filter(ra => ra.status === 'CLOSED');

              const tabItems = [
                {
                  key: 'current',
                  label: `📝 Current (${currentRepoAssignments.length})`,
                  children: (
                    <>
                      <div className="mb-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                        <p className="text-blue-600 dark:text-blue-400">
                          📚 All incomplete assignments (including overdue) sorted by deadline
                        </p>
                      </div>
                      {filterRepositoryAssignments(repoAssignments, 'current').length > 0 ? (
                        <Table
                          columns={getColumns({ emojiMappings: orgEmojiMappings })}
                          dataSource={filterRepositoryAssignments(repoAssignments, activeTab)}
                          rowKey="id"
                          rowHoverable={false}
                          size="small"
                          pagination={{
                            pageSize: 50,
                          }}
                        />
                      ) : (
                        <div className="text-center py-12 text-gray-500">
                          <div className="text-6xl mb-4">📚</div>
                          <h3 className="text-xl font-semibold text-gray-700 mb-2">
                            No current assignments
                          </h3>
                          <p>No incomplete assignments remaining</p>
                        </div>
                      )}
                    </>
                  ),
                },
                {
                  key: 'completed',
                  label: `✅ Completed (${completedRepoAssignments.length})`,
                  children: (
                    <>
                      <div className="mb-4 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                        <p className="text-green-600 dark:text-green-400">
                          🎯 Your successfully submitted assignments with grades and feedback
                        </p>
                      </div>
                      {filterRepositoryAssignments(repoAssignments, 'completed').length > 0 ? (
                        <Table
                          columns={getColumns({ emojiMappings: orgEmojiMappings })}
                          dataSource={filterRepositoryAssignments(repoAssignments, activeTab)}
                          rowKey="id"
                          rowHoverable={false}
                          size="small"
                          pagination={{
                            pageSize: 50,
                          }}
                        />
                      ) : (
                        <div className="text-center py-12 text-gray-500">
                          <div className="text-6xl mb-4">📝</div>
                          <h3 className="text-xl font-semibold text-gray-700 mb-2">
                            No completed assignments yet
                          </h3>
                          <p>Completed assignments will appear here</p>
                        </div>
                      )}
                    </>
                  ),
                },
                {
                  key: 'all',
                  label: `📋 All (${repoAssignments.length})`,
                  children: (
                    <>
                      <div className="mb-4 p-4 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
                        <p className="text-gray-600 dark:text-gray-400">
                          📊 Complete list of all your assignments across all courses and statuses
                        </p>
                      </div>
                      <Table
                        columns={getColumns({ emojiMappings: orgEmojiMappings })}
                        dataSource={filterRepositoryAssignments(repoAssignments, activeTab)}
                        rowKey="id"
                        rowHoverable={false}
                        size="small"
                        pagination={{
                          pageSize: 100,
                        }}
                      />
                    </>
                  ),
                },
              ];

              return (
                <>
                  <div
                    className={`grid gap-5 pb-6 ${
                      !showGradesToStudents ? 'grid-cols-3' : 'grid-cols-4'
                    }`}
                  >
                    <StatsCard title="Total Assignments">{repoAssignments?.length}</StatsCard>
                    <StatsCard title="Unsubmitted Assignments">
                      {
                        repoAssignments.filter(({ status }: { status: string }) => status == 'OPEN')
                          .length
                      }
                    </StatsCard>
                    <StatsCard title="Late Assignments">{overdueRepoAssignments.length}</StatsCard>
                    {showGradesToStudents && (
                      <StatsCard title="Grade Estimation">
                        {membership.letter_grade
                          ? String(membership.letter_grade)
                          : finalLetterGrade}
                      </StatsCard>
                    )}
                  </div>
                  <Tabs
                    activeKey={activeTab}
                    onChange={setActiveTab}
                    items={tabItems}
                    size="large"
                  />
                </>
              );
            }) as unknown as React.ReactNode
          }
        </Await>
      </Suspense>
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const data = await request.json();
  const classSlug = params.class!;

  return namedAction(request, {
    async purchaseExtensionHours() {
      // Use assertClassroomAccess for consistent authorization
      // OWNER/TEACHER can purchase for anyone, STUDENT only for themselves
      const { userId, classroom, membership } = await assertClassroomAccess({
        request,
        classroomSlug: classSlug,
        allowedRoles: ['OWNER', 'TEACHER'], // Teachers/Owners can purchase for anyone
        resourceType: 'TOKEN_PURCHASE',
        attemptedAction: 'purchase_extension_hours',
        metadata: {
          hours_requested: data.hours_purchased,
          repository_issue_id: data.repository_issue_id,
        },
        resourceOwnerId: data.student_id,
        selfAccessRoles: ['STUDENT'], // Students can purchase for themselves only
      });

      // Validate input data
      if (!data.hours_purchased || data.hours_purchased <= 0) {
        throw new Error('Invalid hours: Must be a positive number.');
      }

      if (!data.amount || data.amount >= 0) {
        throw new Error('Invalid amount: Token spending amount must be negative.');
      }

      if (!data.repository_assignment_id) {
        throw new Error('Missing repository assignment ID.');
      }

      // Verify the classroom_id matches
      if (String(data.classroom_id) !== String(classroom.id)) {
        throw new Error('Invalid classroom ID.');
      }

      // All validations passed, proceed with the update
      await ClassmojiService.token.updateExtension(data);
      return {
        action: 'PURCHASE_EXTENSION_HOURS',
        success: 'Successfully purchased hour(s).',
      };
    },
  });
};

export default StudentDashboard;
