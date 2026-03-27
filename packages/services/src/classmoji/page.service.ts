import getPrisma from '@classmoji/database';
import { titleToIdentifier, generateTermString } from '@classmoji/utils';
import { ContentService } from '@classmoji/content';
import * as contentManifestService from './contentManifest.service.ts';
import type { Prisma } from '@prisma/client';

interface PageQueryOptions {
  includeClassroom?: boolean;
  includeCreator?: boolean;
  includeLinks?: boolean;
}

/**
 * Page Service
 * Manages page CRUD operations
 */

/**
 * Create a new page
 */
export async function create(values: Prisma.PageUncheckedCreateInput) {
  // Explicitly exclude id - Prisma will auto-generate with uuid()
  const { id, ...safeValues } = values;

  const page = await getPrisma().page.create({
    data: {
      classroom_id: safeValues.classroom_id,
      title: safeValues.title,
      slug: titleToIdentifier(safeValues.title),
      content_path: safeValues.content_path,
      created_by: safeValues.created_by,
      is_draft: safeValues.is_draft ?? true,
      is_public: safeValues.is_public ?? false,
      show_in_student_menu: safeValues.show_in_student_menu ?? false,
    },
    include: {
      classroom: {
        include: {
          git_organization: true,
        },
      },
      creator: true,
      links: {
        include: {
          module: true,
          assignment: true,
        },
      },
    },
  });

  return page;
}

/**
 * Find a page by ID
 */
export async function findById(pageId: string, options: PageQueryOptions = {}) {
  const page = await getPrisma().page.findUnique({
    where: { id: pageId },
    include: {
      classroom: options.includeClassroom ?? true
        ? {
            include: {
              git_organization: true,
            },
          }
        : false,
      creator: options.includeCreator ?? false,
      links: options.includeLinks ?? false
        ? {
            include: {
              module: true,
              assignment: true,
            },
          }
        : false,
    },
  });

  return page;
}

/**
 * Find all pages for a classroom
 */
export async function findByClassroomId(classroomId: string, options: PageQueryOptions = {}) {
  const pages = await getPrisma().page.findMany({
    where: {
      classroom_id: classroomId,
    },
    include: {
      classroom: options.includeClassroom ?? false
        ? {
            include: {
              git_organization: true,
            },
          }
        : false,
      creator: options.includeCreator ?? true,
      links: options.includeLinks ?? false
        ? {
            include: {
              module: true,
              assignment: true,
            },
          }
        : false,
    },
    orderBy: {
      created_at: 'desc',
    },
  });

  return pages;
}

/**
 * Find pages linked to a module
 */
export async function findByModule(moduleId: string) {
  const pageLinks = await getPrisma().pageLink.findMany({
    where: {
      module_id: moduleId,
    },
    include: {
      page: {
        include: {
          classroom: {
            include: {
              git_organization: true,
            },
          },
          creator: true,
        },
      },
    },
    orderBy: {
      order: 'asc',
    },
  });

  return pageLinks.map(link => ({ ...link.page, linkOrder: link.order }));
}

/**
 * Find pages linked to an assignment
 */
export async function findByAssignment(assignmentId: string) {
  const pageLinks = await getPrisma().pageLink.findMany({
    where: {
      assignment_id: assignmentId,
    },
    include: {
      page: {
        include: {
          classroom: {
            include: {
              git_organization: true,
            },
          },
          creator: true,
        },
      },
    },
    orderBy: {
      order: 'asc',
    },
  });

  return pageLinks.map(link => ({ ...link.page, linkOrder: link.order }));
}

/**
 * Link a page to a module or assignment
 */
export async function linkPage(pageId: string, { moduleId, assignmentId, order = 0 }: { moduleId?: string; assignmentId?: string; order?: number }) {
  const link = await getPrisma().pageLink.create({
    data: {
      page_id: pageId,
      module_id: moduleId || null,
      assignment_id: assignmentId || null,
      order,
    },
    include: {
      page: true,
      module: true,
      assignment: true,
    },
  });

  return link;
}

/**
 * Unlink a page from a module or assignment
 */
export async function unlinkPage(pageId: string, { moduleId, assignmentId }: { moduleId?: string; assignmentId?: string }) {
  const link = await getPrisma().pageLink.deleteMany({
    where: {
      page_id: pageId,
      module_id: moduleId || null,
      assignment_id: assignmentId || null,
    },
  });

  return link;
}

/**
 * Update a page
 */
export async function update(
  pageId: string,
  updates: Pick<
    Prisma.PageUncheckedUpdateInput,
    'title' | 'content_path' | 'show_in_student_menu'
  >
) {
  const page = await getPrisma().page.update({
    where: { id: pageId },
    data: {
      title: updates.title,
      content_path: updates.content_path,
      show_in_student_menu: updates.show_in_student_menu,
      updated_at: new Date(),
    },
    include: {
      classroom: {
        include: {
          git_organization: true,
        },
      },
      creator: true,
      links: {
        include: {
          module: true,
          assignment: true,
        },
      },
    },
  });

  return page;
}

/**
 * Delete a page (database only - for backwards compatibility)
 */
export async function deleteById(pageId: string) {
  const page = await getPrisma().page.delete({
    where: { id: pageId },
  });

  return page;
}

/**
 * Delete a page with full cleanup (GitHub + manifest)
 * @param {string} pageId - The page ID to delete
 * @returns {Promise<{success: boolean, page: Object}>}
 */
export async function deletePage(pageId: string) {
  // Get the page with classroom and git organization info
  const page = await getPrisma().page.findUnique({
    where: { id: pageId },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });

  if (!page) {
    throw new Error('Page not found');
  }

  const classroomId = page.classroom_id;
  const gitOrgLogin = page.classroom?.git_organization?.login;

  // Delete from GitHub if configured
  if (gitOrgLogin && page.content_path) {
    const term = generateTermString(page.classroom.term ?? undefined, page.classroom.year ?? undefined);
    const repoName = `content-${gitOrgLogin}-${term}`;

    try {
      await ContentService.deleteFolder({
        orgLogin: gitOrgLogin,
        repo: repoName,
        path: page.content_path,
        message: `Delete page: ${page.title}`,
      });
    } catch (error: unknown) {
      console.error('Failed to delete page content from GitHub:', error);
      // Continue with database deletion even if GitHub fails
    }
  }

  // Delete from database
  await getPrisma().page.delete({
    where: { id: pageId },
  });

  // Update the manifest
  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error('Failed to update manifest after page deletion:', error);
  }

  return { success: true, page };
}

/**
 * Find a page by content path (for syllabus bot content references)
 */
export async function findByContentPath(
  classroomId: string,
  contentPath: string,
  options: PageQueryOptions = {}
) {
  const page = await getPrisma().page.findFirst({
    where: {
      classroom_id: classroomId,
      content_path: contentPath,
    },
    include: {
      classroom: options.includeClassroom ?? true
        ? {
            include: {
              git_organization: true,
            },
          }
        : false,
      creator: options.includeCreator ?? false,
      links: options.includeLinks ?? false
        ? {
            include: {
              module: true,
              assignment: true,
            },
          }
        : false,
    },
  });

  return page;
}

/**
 * Quick update for specific fields
 */
export async function quickUpdate(pageId: string, updates: Prisma.PageUncheckedUpdateInput) {
  const page = await getPrisma().page.update({
    where: { id: pageId },
    data: {
      ...updates,
      updated_at: new Date(),
    },
  });

  return page;
}

/**
 * Find pages that should appear in student menu
 */
export async function findForStudentMenu(classroomId: string) {
  return getPrisma().page.findMany({
    where: {
      classroom_id: classroomId,
      show_in_student_menu: true,
      is_draft: false, // Only show published pages
    },
    orderBy: [
      { menu_order: 'asc' },  // Null values go last
      { title: 'asc' },       // Then alphabetically
    ],
    select: {
      id: true,
      title: true,
      menu_order: true,
    },
  });
}
