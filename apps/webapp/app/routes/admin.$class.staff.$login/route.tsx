import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConfigProvider, Drawer, Button, Tag, Card, Progress, Collapse, theme, Empty } from 'antd';
import { IconX, IconUserSearch, IconClock } from '@tabler/icons-react';

import { useRouteDrawer, useDarkMode } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import { RequireRole, StatsCard } from '~/components';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { resolveHighestMembership } from '@classmoji/auth/server';
import { addAuditLog } from '~/utils/helpers';
import { authClient } from '@classmoji/auth/client';
import { getEmojiSymbol } from '@classmoji/utils';
import type { Route } from './+types/route';

interface AssignmentSummary {
  id: string;
  studentName: string;
  studentLogin?: string | null;
  assignmentTitle: string;
  isGraded: boolean;
  gradeEmoji?: string | null;
}

interface ModuleAssignmentsGroup {
  name: string;
  assignments: AssignmentSummary[];
}

/**
 * The roles this drawer describes. It is a GRADING-progress view, so it covers
 * the roles that grade — the grader pool draws from ASSISTANT and TEACHER
 * memberships. An OWNER row has no grading queue to show, and the list page
 * offers no View link on one.
 */
const GRADING_ROLES = ['TEACHER', 'ASSISTANT'] as const;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, login } = params;

  // OWNER-only, deliberately narrower than the list page's loader: this is the
  // detail drawer, and widening the list read must never widen this.
  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'TEACHING_STAFF',
    action: 'view_staff_member',
  });

  const staffUser = await ClassmojiService.user.findByLogin(login!);

  if (!staffUser) {
    throw new Response('Staff member not found', { status: 404 });
  }

  // Role-scoped on purpose: memberships are unique on (classroom, user, role),
  // so filtering by role is what keeps a multi-role user's OWNER row out of the
  // answer. HIGHEST-first rather than the service's unordered findFirst, which
  // handed back an arbitrary one of the two for somebody who is both a teacher
  // and an assistant here — and the role decides both the Tag below and which
  // prefix "View as" lands on, so arbitrary there is arbitrary in the UI.
  const membership = await resolveHighestMembership(classroom.id, staffUser.id, [...GRADING_ROLES]);

  if (!membership) {
    throw new Response('User does not grade in this classroom', { status: 403 });
  }

  // Audit log for viewing staff details
  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'TEACHING_STAFF_DETAILS',
    resourceId: String(staffUser.id),
  });

  // Get their grading assignments
  const assignedGraderItems = await ClassmojiService.gitRepoAssignmentGrader.findAssignedByGrader(
    staffUser.id,
    classroom.id
  );

  // Get overall progress stats for this grader
  const gradersProgress = await ClassmojiService.gitRepoAssignmentGrader.findGradersProgress(
    classroom.id
  );
  const staffProgress = gradersProgress.find(g => g.login === login) || {
    total: 0,
    completed: 0,
    progress: 0,
  };

  // Group assignments by repository
  const assignmentsByRepository: Record<string, ModuleAssignmentsGroup> = {};
  assignedGraderItems.forEach(item => {
    const repoAssignment = item.git_repo_assignment;
    const repositoryName = repoAssignment?.git_repo?.repository?.title || 'Uncategorized';
    const repositoryId = repoAssignment?.git_repo?.repository?.id || 'uncategorized';

    if (!assignmentsByRepository[repositoryId]) {
      assignmentsByRepository[repositoryId] = {
        name: repositoryName,
        assignments: [],
      };
    }

    assignmentsByRepository[repositoryId].assignments.push({
      id: repoAssignment.id,
      studentName:
        repoAssignment.git_repo?.student?.name || repoAssignment.git_repo?.team?.name || 'Unknown',
      studentLogin: repoAssignment.git_repo?.student?.login || repoAssignment.git_repo?.team?.slug,
      assignmentTitle: repoAssignment.assignment?.title || 'Unknown Assignment',
      isGraded: repoAssignment.grades?.length > 0,
      gradeEmoji: repoAssignment.grades?.[0]?.emoji,
    });
  });

  // Field by field, not the raw rows: `user.findByLogin` returns the whole User
  // record (email, provider_email, school_id, stripe_customer_id, the ban
  // fields) and the membership include carries a nested user + classroom. The
  // drawer needs an identity and two flags, so that is all it is handed.
  return {
    staffMember: {
      id: staffUser.id,
      name: staffUser.name,
      login: staffUser.login,
      avatar_url: staffUser.image,
    },
    membership: {
      role: membership.role,
      is_grader: membership.is_grader,
      has_accepted_invite: membership.has_accepted_invite,
    },
    assignmentsByRepository,
    stats: staffProgress,
  };
};

const AdminStaffDrawer = ({ loaderData }: Route.ComponentProps) => {
  const { staffMember, membership, assignmentsByRepository, stats } = loaderData;
  const { close, opened, width } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const [impersonating, setImpersonating] = useState(false);
  const callout = useCallout();

  const handleImpersonate = async () => {
    if (!staffMember.login) {
      callout.show({
        variant: 'error',
        title: 'This staff member has not accepted their invite.',
      });
      return;
    }

    setImpersonating(true);
    try {
      const { data: _data, error } = await authClient.admin.impersonateUser({
        userId: staffMember.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to view as this staff member');
      }

      // Land on the prefix that matches the role being impersonated. This
      // drawer now covers TEACHER as well as ASSISTANT, and a teacher dropped
      // on /assistant would be looking at the wrong shell.
      const prefix = membership.role === 'TEACHER' ? 'teacher' : 'assistant';
      navigate(`/${prefix}/${classSlug}/dashboard`);
    } catch (error: unknown) {
      console.error('Impersonation failed:', error);
      callout.show({
        variant: 'error',
        title: error instanceof Error ? error.message : 'Failed to view as this staff member',
      });
    } finally {
      setImpersonating(false);
    }
  };

  const getProgressColor = (progress: number) => {
    if (progress >= 90) return '#22c55e'; // green
    if (progress >= 75) return '#eab308'; // yellow
    if (progress >= 50) return '#f97316'; // orange
    return '#ef4444'; // red
  };

  const repositoryCollapseItems = Object.entries(assignmentsByRepository).map(
    ([repositoryId, repository]) => {
      const gradedCount = repository.assignments.filter(assignment => assignment.isGraded).length;
      const totalCount = repository.assignments.length;

      return {
        key: repositoryId,
        label: (
          <div className="flex items-center justify-between w-full pr-4">
            <span className="font-medium">{repository.name}</span>
            <Tag color={gradedCount === totalCount ? 'green' : 'orange'}>
              {gradedCount}/{totalCount} graded
            </Tag>
          </div>
        ),
        children: (
          <div className="space-y-2">
            {repository.assignments.map(assignment => (
              <div
                key={assignment.id}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-neutral-800 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{assignment.studentName}</p>
                  <p className="text-xs text-gray-500 truncate">{assignment.assignmentTitle}</p>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  {assignment.isGraded ? (
                    <Tag color="green" className="flex items-center gap-1">
                      <span className="text-base">
                        {getEmojiSymbol(assignment.gradeEmoji ?? '')}
                      </span>
                    </Tag>
                  ) : (
                    <Tag color="orange" className="flex items-center gap-1">
                      <IconClock size={12} />
                      Needs Grading
                    </Tag>
                  )}
                </div>
              </div>
            ))}
          </div>
        ),
      };
    }
  );

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Drawer
        title={
          <div className="flex items-center justify-between">
            <span>
              @{staffMember.login} - {staffMember.name}
            </span>
          </div>
        }
        styles={{
          header: {
            backgroundColor: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
        }}
        onClose={close}
        open={opened}
        width={width}
        closeIcon={<IconX className="text-ink-1" size={18} />}
        footer={
          <div className="flex justify-end py-2">
            <Button onClick={close}>Close</Button>
          </div>
        }
      >
        {/* Header Section */}
        <Card className="mb-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <img
                src={
                  staffMember.avatar_url ||
                  `https://avatars.githubusercontent.com/${staffMember.login}`
                }
                alt={staffMember.name!}
                className="w-16 h-16 rounded-full ring-2 ring-gray-200 dark:ring-neutral-700"
              />
              <div>
                <h3 className="text-lg font-semibold">{staffMember.name}</h3>
                <p className="text-gray-500">@{staffMember.login}</p>
                <div className="flex gap-2 mt-2">
                  <Tag color={membership.role === 'TEACHER' ? 'blue' : 'cyan'}>
                    {membership.role === 'TEACHER' ? 'Teacher' : 'Assistant'}
                  </Tag>
                  {membership?.has_accepted_invite !== false ? (
                    <Tag color="green">Active</Tag>
                  ) : (
                    <Tag color="orange">Pending</Tag>
                  )}
                  {membership?.is_grader && <Tag color="blue">Grader</Tag>}
                </div>
              </div>
            </div>
            <RequireRole roles={['OWNER']}>
              <Button
                type="primary"
                icon={<IconUserSearch size={16} />}
                onClick={handleImpersonate}
                loading={impersonating}
              >
                View as
              </Button>
            </RequireRole>
          </div>
        </Card>

        {/* Stats Section */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatsCard title="Total Assigned">{stats.total}</StatsCard>
          <StatsCard title="Completed">{stats.completed}</StatsCard>
          <Card className="text-center">
            <p className="text-sm text-gray-500 mb-2">Progress</p>
            <Progress
              type="circle"
              percent={Math.round(stats.progress)}
              size={60}
              strokeColor={getProgressColor(stats.progress)}
            />
          </Card>
        </div>

        {/* Assignments Breakdown */}
        <Card title="Assignments Breakdown">
          {repositoryCollapseItems.length > 0 ? (
            <Collapse
              items={repositoryCollapseItems}
              defaultActiveKey={[]}
              className="bg-transparent"
            />
          ) : (
            <Empty description="No assignments assigned yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      </Drawer>
    </ConfigProvider>
  );
};

export default AdminStaffDrawer;
