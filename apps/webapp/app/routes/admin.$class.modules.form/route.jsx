import { Drawer } from 'antd';
import { namedAction } from 'remix-utils/named-action';

import { getAuthSession } from '@classmoji/auth/server';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import FormModule from './FormModule';
import { ClassmojiService } from '@classmoji/services';
import prisma from '@classmoji/database';
import { useRouteDrawer } from '~/hooks';
import { ActionTypes } from '~/constants';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'view_module_form',
  });

  const authData = await getAuthSession(request);
  const url = new URL(request.url);
  const moduleTitle = url.searchParams.get('title');
  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  let module = null;
  let hasReposWithProjects = false;

  if (moduleTitle) {
    module = await ClassmojiService.module.findBySlugAndTitle(classSlug, moduleTitle, {
      includePages: true,
      includeSlides: true,
    });

    // Check if any repos have projects (for locking project template field)
    if (module) {
      const reposWithProjects = await prisma.repository.count({
        where: {
          module_id: module.id,
          project_id: { not: null },
        },
      });
      hasReposWithProjects = reposWithProjects > 0;
    }
  }

  // Get all pages and slides for this classroom (for linking options)
  const pages = await ClassmojiService.page.findByClassroomId(classroom.id, {
    includeLinks: true,
  });
  const slides = await prisma.slide.findMany({
    where: { classroom_id: classroom.id },
    include: {
      links: {
        include: { module: true },
      },
    },
    orderBy: { title: 'asc' },
  });

  return {
    token: authData?.token,
    module,
    isNew: !module,
    tags,
    classroom,
    pages,
    slides,
    hasReposWithProjects,
  };
};

const ModuleForm = ({ loaderData }) => {
  const { token, module, isNew, tags, classroom, pages, slides, hasReposWithProjects } = loaderData;
  const { opened, close } = useRouteDrawer({});

  return (
    <Drawer
      open={opened}
      onClose={close}
      title={isNew ? `Let's create your module.` : 'Edit module'}
      width="100%"
    >
      <FormModule
        token={token}
        module={module}
        isNew={isNew}
        close={close}
        tags={tags}
        classroom={classroom}
        pages={pages}
        slides={slides}
        hasReposWithProjects={hasReposWithProjects}
      />
    </Drawer>
  );
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom, userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'MODULES',
    action: 'create_module',
  });

  const data = await request.json();

  // Extract fields that shouldn't go to Prisma
  const { organization, assignmentsToRemove, assignments, tag, linkedPageIds, linkedSlideIds, ...moduleData } = data;

  // Helper to sync module-level content links
  const syncModuleContentLinks = async (moduleId) => {
    // Get current links for this module
    const currentPageLinks = await prisma.pageLink.findMany({
      where: { module_id: moduleId },
      select: { page_id: true },
    });
    const currentSlideLinks = await prisma.slideLink.findMany({
      where: { module_id: moduleId },
      select: { slide_id: true },
    });

    const currentPageIds = currentPageLinks.map(l => l.page_id);
    const currentSlideIds = currentSlideLinks.map(l => l.slide_id);

    const newPageIds = linkedPageIds || [];
    const newSlideIds = linkedSlideIds || [];

    // Pages to add and remove
    const pagesToAdd = newPageIds.filter(id => !currentPageIds.includes(id));
    const pagesToRemove = currentPageIds.filter(id => !newPageIds.includes(id));

    // Slides to add and remove
    const slidesToAdd = newSlideIds.filter(id => !currentSlideIds.includes(id));
    const slidesToRemove = currentSlideIds.filter(id => !newSlideIds.includes(id));

    // Add new page links
    if (pagesToAdd.length > 0) {
      await prisma.pageLink.createMany({
        data: pagesToAdd.map(pageId => ({
          page_id: pageId,
          module_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old page links
    if (pagesToRemove.length > 0) {
      await prisma.pageLink.deleteMany({
        where: {
          module_id: moduleId,
          page_id: { in: pagesToRemove },
        },
      });
    }

    // Add new slide links
    if (slidesToAdd.length > 0) {
      await prisma.slideLink.createMany({
        data: slidesToAdd.map(slideId => ({
          slide_id: slideId,
          module_id: moduleId,
        })),
        skipDuplicates: true,
      });
    }

    // Remove old slide links
    if (slidesToRemove.length > 0) {
      await prisma.slideLink.deleteMany({
        where: {
          module_id: moduleId,
          slide_id: { in: slidesToRemove },
        },
      });
    }
  };

  // Helper to sync assignment-level content links
  const syncAssignmentContentLinks = async (assignmentsList) => {
    for (const assignment of assignmentsList || []) {
      const assignmentId = assignment.id;
      const newPageIds = assignment.linkedPageIds || [];
      const newSlideIds = assignment.linkedSlideIds || [];

      // Get current links for this assignment
      const currentPageLinks = await prisma.pageLink.findMany({
        where: { assignment_id: assignmentId },
        select: { page_id: true },
      });
      const currentSlideLinks = await prisma.slideLink.findMany({
        where: { assignment_id: assignmentId },
        select: { slide_id: true },
      });

      const currentPageIds = currentPageLinks.map(l => l.page_id);
      const currentSlideIds = currentSlideLinks.map(l => l.slide_id);

      // Pages to add and remove
      const pagesToAdd = newPageIds.filter(id => !currentPageIds.includes(id));
      const pagesToRemove = currentPageIds.filter(id => !newPageIds.includes(id));

      // Slides to add and remove
      const slidesToAdd = newSlideIds.filter(id => !currentSlideIds.includes(id));
      const slidesToRemove = currentSlideIds.filter(id => !newSlideIds.includes(id));

      // Add new page links
      if (pagesToAdd.length > 0) {
        await prisma.pageLink.createMany({
          data: pagesToAdd.map(pageId => ({
            page_id: pageId,
            assignment_id: assignmentId,
          })),
          skipDuplicates: true,
        });
      }

      // Remove old page links
      if (pagesToRemove.length > 0) {
        await prisma.pageLink.deleteMany({
          where: {
            assignment_id: assignmentId,
            page_id: { in: pagesToRemove },
          },
        });
      }

      // Add new slide links
      if (slidesToAdd.length > 0) {
        await prisma.slideLink.createMany({
          data: slidesToAdd.map(slideId => ({
            slide_id: slideId,
            assignment_id: assignmentId,
          })),
          skipDuplicates: true,
        });
      }

      // Remove old slide links
      if (slidesToRemove.length > 0) {
        await prisma.slideLink.deleteMany({
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
        const createdModule = await ClassmojiService.module.create({
          ...moduleData,
          classroom_id: classroom.id,
          tag_id: tag || null,
          assignments: assignments || [],
        });

        // Sync content links for module and assignments
        await syncModuleContentLinks(createdModule.id);
        await syncAssignmentContentLinks(assignments);

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Module created',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error) {
        console.error('Module create error:', error);
        return {
          error: 'Failed to create module. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
    async update() {
      try {
        await ClassmojiService.module.updateWithAssignments({
          ...moduleData,
          tag,
          assignments: assignments || [],
          assignmentsToRemove: assignmentsToRemove || [],
        });

        // Sync content links for module and assignments
        await syncModuleContentLinks(moduleData.id);
        await syncAssignmentContentLinks(assignments);

        // Save content manifest to GitHub repo
        await saveContentManifest();

        return {
          success: 'Module updated',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      } catch (error) {
        console.error('Module update error:', error);
        return {
          error: 'Failed to update module. Please try again.',
          action: ActionTypes.SAVE_ASSIGNMENT,
        };
      }
    },
  });
};

export default ModuleForm;
