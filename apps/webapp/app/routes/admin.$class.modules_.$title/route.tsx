import { Divider, Tabs, Switch, Card, Tag } from 'antd';
import { IconFileText, IconList, IconTable } from '@tabler/icons-react';
import { useParams, useRevalidator, Outlet } from 'react-router';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import Menu from './Menu';
import { TriggerProgress } from '~/components';
import AssignmentTable from './AssignmentTable';
import { action } from './action';
import SummaryCards from './SummaryCards';
import ModuleTable from './ModuleTable';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface ModuleAssignmentSummary {
  id: string;
  title: string;
  slug: string | null;
  description: string;
  weight: number;
  student_deadline: Date | null;
  grader_deadline: Date | null;
  release_at: Date | null;
  grades_released: boolean;
  is_published: boolean;
  tokens_per_hour: number;
  module_id: string;
  created_at: Date;
  updated_at: Date;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, title } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'MODULES',
    action: 'view_module',
  });

  const module = await ClassmojiService.module.findBySlugAndTitle(classSlug!, title!);
  const repos = await ClassmojiService.repository.findByModule(classSlug!, module!.id);
  const assistants = (
    await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'ASSISTANT')
  ).filter(({ is_grader }) => is_grader);

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  return { module, repos, assistants, emojiMappings, settings, classroom };
};

const SingleModule = ({ loaderData }: Route.ComponentProps) => {
  const { module, repos, assistants, emojiMappings, settings, classroom } = loaderData;
  const { fetcher, notify: _notify } = useGlobalFetcher();
  const { class: classSlug } = useParams();
  const { revalidate } = useRevalidator();
  const [viewMode, setViewMode] = useState('assignment'); // 'module' or 'assignment'

  const handleGradeRelease = async (assignmentId: string, gradesReleased: boolean) => {
    fetcher!.submit(
      {
        assignment_id: assignmentId,
        grades_released: gradesReleased,
      },
      {
        action: `/api/repositoryAssignment/${classSlug}?/updateGradeRelease`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };

  const tabItems = (module!.assignments as ModuleAssignmentSummary[])
    .sort((a, b) => {
      // First sort by deadline
      const aTime = a.student_deadline ? new Date(a.student_deadline).getTime() : 0;
      const bTime = b.student_deadline ? new Date(b.student_deadline).getTime() : 0;
      if (aTime !== bTime) {
        return aTime - bTime;
      }
      // Then sort by title
      return a.title.localeCompare(b.title);
    })
    .map(assignment => {
      return {
        key: assignment.id,
        label: assignment.title,
        children: (
          <>
            <Card
              size="small"
              title="Grade Management"
              className="mb-4"
              extra={
                <div className="flex items-center gap-2">
                  <Tag color={assignment.grades_released ? 'green' : 'orange'}>
                    {assignment.grades_released ? 'Released' : 'Hidden'}
                  </Tag>
                  <Switch
                    size="small"
                    checked={assignment.grades_released}
                    onChange={checked => handleGradeRelease(assignment.id, checked)}
                  />
                </div>
              }
            >
              <p className="text-gray-600">
                {assignment.grades_released ? (
                  <>
                    Students <span className="text-green-600 font-medium">can see</span> their
                    grades for this assignment
                  </>
                ) : (
                  <>
                    Grades are{' '}
                    <span className="text-red-600 font-medium">hidden from students</span> until
                    released
                  </>
                )}
              </p>
            </Card>

            <AssignmentTable
              assignment={
                assignment as unknown as Parameters<typeof AssignmentTable>[0]['assignment']
              }
              module={module as Parameters<typeof AssignmentTable>[0]['module']}
              repos={repos as Parameters<typeof AssignmentTable>[0]['repos']}
              assistants={assistants as Parameters<typeof AssignmentTable>[0]['assistants']}
              emojiMappings={
                emojiMappings as Parameters<typeof AssignmentTable>[0]['emojiMappings']
              }
              settings={settings as Parameters<typeof AssignmentTable>[0]['settings']}
              org={classroom.git_organization.login}
            />
          </>
        ),
      };
    });

  return (
    <>
      <div className="flex justify-between items-center ">
        <div className="flex items-center gap-2 mt-4">
          <IconFileText className="text-black dark:text-gray-200" />
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-black dark:text-gray-200">Modules / </span>{' '}
            <span className="text-2xl text-black dark:text-gray-200">{`${module!.title}`}</span>
          </div>
        </div>

        <Menu
          module={module as Parameters<typeof Menu>[0]['module']}
          assistants={assistants as Parameters<typeof Menu>[0]['assistants']}
        />
      </div>
      <Divider />

      <SummaryCards
        module={module!}
        repos={
          repos as {
            project_id?: string | null;
            assignments?: { assignment_id: string; status: string }[];
            [key: string]: unknown;
          }[]
        }
      />

      {/* View Toggle */}
      <div className="flex justify-end items-center mb-6">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-600 dark:text-gray-400">View:</span>
          <div className="flex items-center gap-3 bg-gray-50 dark:bg-gray-800 rounded-lg p-2 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <IconTable
                size={18}
                className={
                  viewMode === 'module' ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400'
                }
              />
              <span
                className={`text-sm font-medium ${
                  viewMode === 'module'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                Module
              </span>
            </div>
            <Switch
              checked={viewMode === 'assignment'}
              onChange={checked => setViewMode(checked ? 'assignment' : 'module')}
              size="small"
            />
            <div className="flex items-center gap-2">
              <IconList
                size={18}
                className={
                  viewMode === 'assignment'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-gray-400'
                }
              />
              <span
                className={`text-sm font-medium ${
                  viewMode === 'assignment'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                Assignments
              </span>
            </div>
          </div>
        </div>
      </div>

      {viewMode === 'assignment' ? (
        <Tabs items={tabItems} />
      ) : (
        <ModuleTable
          module={module as Parameters<typeof ModuleTable>[0]['module']}
          repos={repos as unknown as Parameters<typeof ModuleTable>[0]['repos']}
          emojiMappings={emojiMappings as Parameters<typeof ModuleTable>[0]['emojiMappings']}
          settings={settings as Parameters<typeof ModuleTable>[0]['settings']}
          org={classroom.git_organization.login}
        />
      )}

      <TriggerProgress operation="UPDATE_REPOS" validIdentifiers={['update_repository']} />

      <TriggerProgress
        operation="CALCULATE_REPO_CONTRIBUTIONS"
        validIdentifiers={['calculate_repo_contributions']}
      />

      <TriggerProgress
        operation="ASSIGN_GRADERS_TO_ASSIGNMENTS"
        validIdentifiers={['add_grader_to_repository_assignment']}
        callback={() => setTimeout(() => revalidate(), 100)}
      />

      <Outlet />
    </>
  );
};

export { action };
export default SingleModule;
