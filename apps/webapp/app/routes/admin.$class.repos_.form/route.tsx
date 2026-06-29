import { namedAction } from 'remix-utils/named-action';
import { useNavigate, useParams } from 'react-router';
import { IconChevronLeft, IconFolder } from '@tabler/icons-react';

import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import FormModule from './FormModule';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { ActionTypes } from '~/constants';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_module_form',
  });

  const url = new URL(request.url);
  const moduleTitle = url.searchParams.get('title');
  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  let repository = null;
  let hasReposWithProjects = false;

  if (moduleTitle) {
    repository = await ClassmojiService.repository.findBySlugAndTitle(classSlug!, moduleTitle, {
      includePages: true,
      includeSlides: true,
    });

    // Check if any repos have projects (for locking project template field)
    if (repository) {
      const reposWithProjects = await getPrisma().gitRepo.count({
        where: {
          repository_id: repository.id,
          project_id: { not: null },
        },
      });
      hasReposWithProjects = reposWithProjects > 0;

      const autogradingTests = await ClassmojiService.autogradingTest.findByRepositoryId(
        repository.id
      );
      repository = { ...repository, autograding_tests: autogradingTests };
    }
  }

  // Get all pages and slides for this classroom (for linking options)
  const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
    includeLinks: true,
  });
  const slides = await getPrisma().slide.findMany({
    where: { classroom_id: classroom.id },
    include: {
      links: {
        include: { repository: true },
      },
    },
    orderBy: { title: 'asc' },
  });

  return {
    repository,
    isNew: !repository,
    tags,
    classroom,
    pages,
    slides,
    hasReposWithProjects,
  };
};

const ModuleForm = ({ loaderData }: Route.ComponentProps) => {
  const { repository, isNew, tags, classroom, pages, slides, hasReposWithProjects } = loaderData;
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const goToRepos = () => navigate(`/admin/${classSlug}/repos`);
  // FormModule calls `close` on Discard and after a successful save.
  const close = () => navigate(-1);

  return (
    <div className="min-h-full relative">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 text-ink-2 mt-2 mb-4">
        <button
          type="button"
          onClick={goToRepos}
          className="hover:text-ink-1"
          aria-label="Back to repositories"
        >
          <IconChevronLeft size={18} />
        </button>
        <IconFolder size={18} className="text-gray-400" />
        <button type="button" onClick={goToRepos} className="hover:text-ink-1">
          Repositories
        </button>
        <span className="text-ink-3">/</span>
        <span className="font-semibold text-ink-1">
          {isNew ? 'New repository' : (repository?.title ?? 'Edit repository')}
        </span>
      </div>

      <FormModule
        repository={repository as Parameters<typeof FormModule>[0]['repository']}
        isNew={isNew}
        close={close}
        tags={tags}
        classroom={classroom as Parameters<typeof FormModule>[0]['classroom']}
        pages={pages}
        slides={slides}
        hasReposWithProjects={hasReposWithProjects}
      />
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const {
    classroom,
    userId: _userId,
    membership,
  } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'create_repository',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  // Extract fields that shouldn't go to Prisma
  const {
    organization: _organization,
    assignmentsToRemove,
    assignments,
    tag,
    linkedPageIds,
    linkedSlideIds,
    autogradingTests,
    ...moduleData
  } = data;

  // Helper to sync repository-level content links
  const syncModuleContentLinks = async (moduleId: string) => {
    // Get current links for this repository
    const currentPageLinks = await getPrisma().pageLink.findMany({
      where: { repository_id: moduleId },
      select: { page_id: true },
    });
    const currentSlideLinks = await getPrisma().slideLink.findMany({
      where: { repository_id: moduleId },
      select: { slide_id: true },
    });

    const currentPageIds = currentPageLinks.map(l => l.page_id);
    const currentSlideIds = currentSlideLinks.map(l => l.slide_id);

    const newPageIds = linkedPageIds || [];
    const newSlideIds = linkedSlideIds || [];

    // Pages to add and remove
    const pagesToAdd = newPageIds.filter((id: string) => !currentPageIds.includes(id));
    const pagesToRemove = currentPageIds.filter(id => !newPageIds.includes(id));

    // Slides to add and remove
    const slidesToAdd = newSlideIds.filter((id: string) => !currentSlideIds.includes(id));
    const slidesToRemove = currentSlideIds.filter(id => !newSlideIds.includes(id));

    // Add new page links
    if (pagesToAdd.length > 0) {
      await getPrisma().pageLink.createMany({
        data: pagesToAdd.map((pageId: string) => ({
          page_id: pageId,
          repository_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old page links
    if (pagesToRemove.length > 0) {
      await getPrisma().pageLink.deleteMany({
        where: {
          repository_id: moduleId,
          page_id: { in: pagesToRemove },
        },
      });
    }

    // Add new slide links
    if (slidesToAdd.length > 0) {
      await getPrisma().slideLink.createMany({
        data: slidesToAdd.map((slideId: string) => ({
          slide_id: slideId,
          repository_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old slide links
    if (slidesToRemove.length > 0) {
      await getPrisma().slideLink.deleteMany({
        where: {
          repository_id: moduleId,
          slide_id: { in: slidesToRemove },
        },
      });
    }
  };

  // Helper to sync assignment-level content links
  const syncAssignmentContentLinks = async (
    assignmentsList: Array<{ id: string; linkedPageIds?: string[]; linkedSlideIds?: string[] }>
  ) => {
    for (const assignment of assignmentsList || []) {
      const assignmentId = assignment.id;
      const newPageIds = assignment.linkedPageIds || [];
      const newSlideIds = assignment.linkedSlideIds || [];

      // Get current links for this assignment
      const currentPageLinks = await getPrisma().pageLink.findMany({
        where: { assignment_id: assignmentId },
        select: { page_id: true },
      });
      const currentSlideLinks = await getPrisma().slideLink.findMany({
        where: { assignment_id: assignmentId },
        select: { slide_id: true },
      });

      const currentPageIds = currentPageLinks.map(l => l.page_id);
      const currentSlideIds = currentSlideLinks.map(l => l.slide_id);

      // Pages to add and remove
      const pagesToAdd = newPageIds.filter((id: string) => !currentPageIds.includes(id));
      const pagesToRemove = currentPageIds.filter(id => !newPageIds.includes(id));

      // Slides to add and remove
      const slidesToAdd = newSlideIds.filter((id: string) => !currentSlideIds.includes(id));
      const slidesToRemove = currentSlideIds.filter(id => !newSlideIds.includes(id));

      // Add new page links
      if (pagesToAdd.length > 0) {
        await getPrisma().pageLink.createMany({
          data: pagesToAdd.map((pageId: string) => ({
            page_id: pageId,
            assignment_id: assignmentId,
          })),
          skipDuplicates: true,
        });
      }

      // Remove old page links
      if (pagesToRemove.length > 0) {
        await getPrisma().pageLink.deleteMany({
          where: {
            assignment_id: assignmentId,
            page_id: { in: pagesToRemove },
          },
        });
      }

      // Add new slide links
      if (slidesToAdd.length > 0) {
        await getPrisma().slideLink.createMany({
          data: slidesToAdd.map((slideId: string) => ({
            slide_id: slideId,
            assignment_id: assignmentId,
          })),
          skipDuplicates: true,
        });
      }

      // Remove old slide links
      if (slidesToRemove.length > 0) {
        await getPrisma().slideLink.deleteMany({
          where: {
            assignment_id: assignmentId,
            slide_id: { in: slidesToRemove },
          },
        });
      }
    }
  };

  // Helper to save content manifest to GitHub repo
  const saveContentManifest = async () => {
    await ClassmojiService.contentManifest.saveManifest(classroom.id);
  };

  return namedAction(request, {
    async create() {
      try {
        const createdModule = await ClassmojiService.repository.create({
          ...moduleData,
          classroom_id: classroom.id,
          tag_id: tag || null,
          assignments: assignments || [],
        });

        // Sync content links for repository and assignments
        await syncModuleContentLinks(createdModule.id);
        await syncAssignmentContentLinks(assignments);
        await ClassmojiService.autogradingTest.replaceForRepository(
          createdModule.id,
          autogradingTests || []
        );

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Repository created',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error: unknown) {
        console.error('Repository create error:', error);
        return {
          error: 'Failed to create repository. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
    async update() {
      try {
        await ClassmojiService.repository.updateWithAssignments({
          ...moduleData,
          tag,
          assignments: assignments || [],
          assignmentsToRemove: assignmentsToRemove || [],
        });

        // Sync content links for repository and assignments
        await syncModuleContentLinks(moduleData.id);
        await syncAssignmentContentLinks(assignments);
        await ClassmojiService.autogradingTest.replaceForRepository(
          moduleData.id,
          autogradingTests || []
        );

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Repository updated',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error: unknown) {
        console.error('Repository update error:', error);
        return {
          error: 'Failed to update repository. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
  });
};

export default ModuleForm;
