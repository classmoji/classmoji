import { Tabs, Switch, Card, Tag, Button } from 'antd';
import {
  IconFolder,
  IconChevronLeft,
  IconList,
  IconTable,
  IconPlus,
} from '@tabler/icons-react';
import { useParams, useRevalidator, useNavigate, Outlet } from 'react-router';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import FolderTabs from '~/components/ui/FolderTabs';
import Menu from './Menu';
import { TriggerProgress } from '~/components';
import AssignmentTable from './AssignmentTable';
import { action } from './action';
import SummaryCards from './SummaryCards';
import ModuleTable from './ModuleTable';
import AssignmentsTab from './AssignmentsTab';
import LinkedPages, { type LinkedPage } from './LinkedPages';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

interface RepositoryAssignmentSummary {
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
  repository_id: string;
  created_at: Date;
  updated_at: Date;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, title } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_module',
  });

  const repository = await ClassmojiService.repository.findBySlugAndTitle(classSlug!, title!, {
    includePages: true,
  });
  const repos = await ClassmojiService.gitRepo.findByRepository(classSlug!, repository!.id);
  const assistants = (
    await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'ASSISTANT')
  ).filter(({ is_grader }) => is_grader);

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);
  const students = await ClassmojiService.classroomMembership.findStudents(classroom.id);
  const teams = await ClassmojiService.team.findByClassroomId(classroom.id);

  // Linked pages = pages linked to the repository unit + to any of its assignments.
  // PageLink rows carry `.page` (the Page) when includePages is set on the query.
  const linkedPages: LinkedPage[] = [];
  type PageLinkLike = {
    id: string;
    page?: { id: string; title: string; is_draft: boolean; updated_at: Date } | null;
  };
  for (const link of (repository?.pages ?? []) as PageLinkLike[]) {
    if (link.page) {
      linkedPages.push({
        id: link.id,
        pageId: link.page.id,
        title: link.page.title,
        linkedTo: 'linked to repository',
        isDraft: link.page.is_draft,
        updatedAt: link.page.updated_at,
      });
    }
  }
  for (const a of (repository?.assignments ?? []) as Array<{
    title: string;
    pages?: PageLinkLike[];
  }>) {
    for (const link of a.pages ?? []) {
      if (link.page) {
        linkedPages.push({
          id: link.id,
          pageId: link.page.id,
          title: link.page.title,
          linkedTo: `linked to ${a.title}`,
          isDraft: link.page.is_draft,
          updatedAt: link.page.updated_at,
        });
      }
    }
  }

  return {
    repository,
    repos,
    assistants,
    emojiMappings,
    settings,
    classroom,
    studentsCount: students.length,
    teamsCount: teams.length,
    linkedPages,
  };
};

const SingleRepository = ({ loaderData }: Route.ComponentProps) => {
  const {
    repository,
    repos,
    assistants,
    emojiMappings,
    settings,
    classroom,
    studentsCount,
    teamsCount,
    linkedPages,
  } = loaderData;
  const { fetcher } = useGlobalFetcher();
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [viewMode, setViewMode] = useState('assignment'); // 'repository' or 'assignment'

  const gitOrgLogin = classroom.git_organization?.login;

  const handleGradeRelease = async (assignmentId: string, gradesReleased: boolean) => {
    fetcher!.submit(
      { assignment_id: assignmentId, grades_released: gradesReleased },
      {
        action: `/api/gitRepoAssignment/${classSlug}?/updateGradeRelease`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };

  const gradeTabItems = (repository!.assignments as RepositoryAssignmentSummary[])
    .slice()
    .sort((a, b) => {
      const aTime = a.student_deadline ? new Date(a.student_deadline).getTime() : 0;
      const bTime = b.student_deadline ? new Date(b.student_deadline).getTime() : 0;
      if (aTime !== bTime) return aTime - bTime;
      return a.title.localeCompare(b.title);
    })
    .map(assignment => ({
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
                  Students <span className="text-green-600 font-medium">can see</span> their grades
                  for this assignment
                </>
              ) : (
                <>
                  Grades are <span className="text-red-600 font-medium">hidden from students</span>{' '}
                  until released
                </>
              )}
            </p>
          </Card>

          <AssignmentTable
            assignment={
              assignment as unknown as Parameters<typeof AssignmentTable>[0]['assignment']
            }
            repository={repository as Parameters<typeof AssignmentTable>[0]['repository']}
            repos={repos as Parameters<typeof AssignmentTable>[0]['repos']}
            assistants={assistants as Parameters<typeof AssignmentTable>[0]['assistants']}
            emojiMappings={emojiMappings as Parameters<typeof AssignmentTable>[0]['emojiMappings']}
            settings={settings as Parameters<typeof AssignmentTable>[0]['settings']}
            org={gitOrgLogin}
          />
        </>
      ),
    }));

  const gradesToggle = (
    <div className="flex items-center gap-3 bg-gray-50 dark:bg-neutral-800 rounded-lg p-2 border border-gray-200 dark:border-neutral-700">
      <div className="flex items-center gap-2">
        <IconTable
          size={18}
          className={
            viewMode === 'repository' ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400'
          }
        />
        <span
          className={`text-sm font-medium ${viewMode === 'repository' ? 'text-yellow-600 dark:text-yellow-400' : 'text-ink-2'}`}
        >
          Repository
        </span>
      </div>
      <Switch
        checked={viewMode === 'assignment'}
        onChange={checked => setViewMode(checked ? 'assignment' : 'repository')}
        size="small"
      />
      <div className="flex items-center gap-2">
        <IconList
          size={18}
          className={
            viewMode === 'assignment' ? 'text-yellow-600 dark:text-yellow-400' : 'text-gray-400'
          }
        />
        <span
          className={`text-sm font-medium ${viewMode === 'assignment' ? 'text-yellow-600 dark:text-yellow-400' : 'text-ink-2'}`}
        >
          Assignments
        </span>
      </div>
    </div>
  );

  const gradesContent =
    viewMode === 'assignment' ? (
      <Tabs items={gradeTabItems} />
    ) : (
      <ModuleTable
        repository={repository as Parameters<typeof ModuleTable>[0]['repository']}
        repos={repos as unknown as Parameters<typeof ModuleTable>[0]['repos']}
        emojiMappings={emojiMappings as Parameters<typeof ModuleTable>[0]['emojiMappings']}
        settings={settings as Parameters<typeof ModuleTable>[0]['settings']}
        org={gitOrgLogin}
      />
    );

  // Grades first — it's where faculty go most often.
  const tabItems = [
    {
      key: 'grades',
      label: 'Grades',
      extra: gradesToggle,
      children: gradesContent,
    },
    {
      key: 'assignments',
      label: 'Assignments',
      extra: (
        <Button
          icon={<IconPlus size={16} />}
          onClick={() => navigate(`/admin/${classSlug}/repos/form?title=${repository!.title}`)}
        >
          New assignment
        </Button>
      ),
      children: (
        <AssignmentsTab
          classSlug={classSlug}
          repositoryTitle={repository!.title}
          assignments={
            repository!.assignments as Parameters<typeof AssignmentsTab>[0]['assignments']
          }
        />
      ),
    },
  ];

  return (
    <div className="min-h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-ink-2">
          <button
            type="button"
            onClick={() => navigate(`/admin/${classSlug}/repos`)}
            className="hover:text-ink-1"
            aria-label="Back to repositories"
          >
            <IconChevronLeft size={18} />
          </button>
          <IconFolder size={18} className="text-gray-400" />
          <button
            type="button"
            onClick={() => navigate(`/admin/${classSlug}/repos`)}
            className="hover:text-ink-1"
          >
            Repositories
          </button>
          <span className="text-ink-3">/</span>
          <span className="font-semibold text-ink-1">{repository!.title}</span>
        </div>

        <Menu
          repository={repository as Parameters<typeof Menu>[0]['repository']}
          assistants={assistants as Parameters<typeof Menu>[0]['assistants']}
        />
      </div>

      <SummaryCards
        repository={repository as Parameters<typeof SummaryCards>[0]['repository']}
        repos={repos as Parameters<typeof SummaryCards>[0]['repos']}
        studentsCount={studentsCount}
        teamsCount={teamsCount}
        emojiMappings={emojiMappings as Parameters<typeof SummaryCards>[0]['emojiMappings']}
        settings={settings as Parameters<typeof SummaryCards>[0]['settings']}
      />

      <FolderTabs items={tabItems} defaultActiveKey="grades" panelClassName="min-h-[300px]" />

      <LinkedPages classSlug={classSlug} pages={linkedPages} />

      <TriggerProgress operation="UPDATE_REPOS" validIdentifiers={['update_git_repo']} />

      <TriggerProgress
        operation="CALCULATE_REPO_CONTRIBUTIONS"
        validIdentifiers={['calculate_repo_contributions']}
      />

      <TriggerProgress
        operation="ASSIGN_GRADERS_TO_ASSIGNMENTS"
        validIdentifiers={['add_grader_to_git_repo_assignment']}
        callback={() => setTimeout(() => revalidate(), 100)}
      />

      <Outlet />
    </div>
  );
};

export { action };
export default SingleRepository;
