import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConfigProvider, Drawer, Button, Tag, Card, Progress, Collapse, theme, Empty } from 'antd';
import { IconX, IconUserSearch, IconClock } from '@tabler/icons-react';
import { toast } from 'react-toastify';

import { useRouteDrawer, useDarkMode } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { RequireRole, StatsCard } from '~/components';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { addAuditLog } from '~/utils/helpers';
import { authClient } from '@classmoji/auth/client';
import { getEmojiSymbol } from '@classmoji/utils';

export const loader = async ({ params, request }) => {
  const { class: classSlug, login } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'ASSISTANTS',
    action: 'view_assistant',
  });

  // Get the assistant user
  const assistant = await ClassmojiService.user.findByLogin(login);

  if (!assistant) {
    throw new Response('Assistant not found', { status: 404 });
  }

  // Get their membership and verify they are an ASSISTANT in this classroom
  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    assistant.id
  );

  if (!membership || membership.role !== 'ASSISTANT') {
    throw new Response('User is not an assistant in this classroom', { status: 403 });
  }

  // Audit log for viewing assistant details
  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'ASSISTANT_DETAILS',
    resourceId: assistant.id,
  });

  // Get their grading assignments
  const assignedGraderItems = await ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(
    assistant.id,
    classroom.id
  );

  // Get overall progress stats for this grader
  const gradersProgress = await ClassmojiService.repositoryAssignmentGrader.findGradersProgress(
    classroom.id
  );
  const assistantProgress = gradersProgress.find(g => g.login === login) || {
    total: 0,
    completed: 0,
    progress: 0,
  };

  // Group assignments by module
  const assignmentsByModule = {};
  assignedGraderItems.forEach(item => {
    const repoAssignment = item.repository_assignment;
    const moduleName = repoAssignment?.repository?.module?.title || 'Uncategorized';
    const moduleId = repoAssignment?.repository?.module?.id || 'uncategorized';

    if (!assignmentsByModule[moduleId]) {
      assignmentsByModule[moduleId] = {
        name: moduleName,
        assignments: [],
      };
    }

    assignmentsByModule[moduleId].assignments.push({
      id: repoAssignment.id,
      studentName: repoAssignment.repository?.student?.name || repoAssignment.repository?.team?.name || 'Unknown',
      studentLogin: repoAssignment.repository?.student?.login || repoAssignment.repository?.team?.slug,
      assignmentTitle: repoAssignment.assignment?.title || 'Unknown Assignment',
      isGraded: repoAssignment.grades?.length > 0,
      gradeEmoji: repoAssignment.grades?.[0]?.emoji,
    });
  });

  return {
    assistant,
    membership,
    assignmentsByModule,
    stats: assistantProgress,
  };
};

const AdminAssistantDrawer = ({ loaderData }) => {
  const { assistant, membership, assignmentsByModule, stats } = loaderData;
  const { close, opened, width } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const [impersonating, setImpersonating] = useState(false);

  const handleImpersonate = async () => {
    if (!assistant.login) {
      toast.error('Assistant has not accepted invite.');
      return;
    }

    setImpersonating(true);
    try {
      const { data, error } = await authClient.admin.impersonateUser({
        userId: assistant.id.toString(),
      });

      if (error) {
        throw new Error(error.message || 'Failed to view as assistant');
      }

      navigate(`/assistant/${classSlug}/dashboard`);
    } catch (error) {
      console.error('Impersonation failed:', error);
      toast.error(error.message || 'Failed to view as assistant');
    } finally {
      setImpersonating(false);
    }
  };

  const getProgressColor = progress => {
    if (progress >= 90) return '#22c55e'; // green
    if (progress >= 75) return '#eab308'; // yellow
    if (progress >= 50) return '#f97316'; // orange
    return '#ef4444'; // red
  };

  const moduleCollapseItems = Object.entries(assignmentsByModule).map(([moduleId, module]) => {
    const gradedCount = module.assignments.filter(a => a.isGraded).length;
    const totalCount = module.assignments.length;

    return {
      key: moduleId,
      label: (
        <div className="flex items-center justify-between w-full pr-4">
          <span className="font-medium">{module.name}</span>
          <Tag color={gradedCount === totalCount ? 'green' : 'orange'}>
            {gradedCount}/{totalCount} graded
          </Tag>
        </div>
      ),
      children: (
        <div className="space-y-2">
          {module.assignments.map(assignment => (
            <div
              key={assignment.id}
              className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{assignment.studentName}</p>
                <p className="text-xs text-gray-500 truncate">{assignment.assignmentTitle}</p>
              </div>
              <div className="flex items-center gap-2 ml-2">
                {assignment.isGraded ? (
                  <Tag color="green" className="flex items-center gap-1">
                    <span className="text-base">{getEmojiSymbol(assignment.gradeEmoji)}</span>
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
  });

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Drawer
        title={
          <div className="flex items-center justify-between">
            <span>@{assistant.login} - {assistant.name}</span>
          </div>
        }
        opened={opened}
        styles={{
          header: {
            backgroundColor: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
        }}
        onClose={close}
        open={opened}
        width={width}
        closeIcon={<IconX className="text-gray-700 dark:text-gray-300" size={18} />}
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
                src={assistant.avatar_url || `https://avatars.githubusercontent.com/${assistant.login}`}
                alt={assistant.name}
                className="w-16 h-16 rounded-full ring-2 ring-gray-200 dark:ring-gray-700"
              />
              <div>
                <h3 className="text-lg font-semibold">{assistant.name}</h3>
                <p className="text-gray-500">@{assistant.login}</p>
                <div className="flex gap-2 mt-2">
                  {membership?.has_accepted_invite !== false ? (
                    <Tag color="green">Active</Tag>
                  ) : (
                    <Tag color="orange">Pending</Tag>
                  )}
                  {membership?.is_grader && (
                    <Tag color="blue">Grader</Tag>
                  )}
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
        <div className="grid grid-cols-3 gap-4 mb-4">
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
          {moduleCollapseItems.length > 0 ? (
            <Collapse
              items={moduleCollapseItems}
              defaultActiveKey={[]}
              className="bg-transparent"
            />
          ) : (
            <Empty
              description="No assignments assigned yet"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )}
        </Card>
      </Drawer>
    </ConfigProvider>
  );
};

export default AdminAssistantDrawer;
