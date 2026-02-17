import prisma from '@classmoji/database';
import { titleToIdentifier, generateTermString } from '@classmoji/utils';
import { ContentService } from '@classmoji/content';
import * as contentManifestService from './contentManifest.service.js';

/**
 * Page Service
 * Manages page CRUD operations
 */

/**
 * Create a new page
 */
export async function create(values) {
  // Explicitly exclude id - Prisma will auto-generate with uuid()
  const { id, ...safeValues } = values;

  const page = await prisma.page.create({
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
export async function findById(pageId, options = {}) {
  const page = await prisma.page.findUnique({
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
export async function findByClassroomId(classroomId, options = {}) {
  const pages = await prisma.page.findMany({
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
export async function findByModule(moduleId) {
  const pageLinks = await prisma.pageLink.findMany({
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
export async function findByAssignment(assignmentId) {
  const pageLinks = await prisma.pageLink.findMany({
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
export async function linkPage(pageId, { moduleId, assignmentId, order = 0 }) {
  const link = await prisma.pageLink.create({
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
export async function unlinkPage(pageId, { moduleId, assignmentId }) {
  const link = await prisma.pageLink.deleteMany({
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
export async function update(pageId, updates) {
  const page = await prisma.page.update({
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
export async function deleteById(pageId) {
  const page = await prisma.page.delete({
    where: { id: pageId },
  });

  return page;
}

/**
 * Delete a page with full cleanup (GitHub + manifest)
 * @param {string} pageId - The page ID to delete
 * @returns {Promise<{success: boolean, page: Object}>}
 */
export async function deletePage(pageId) {
  // Get the page with classroom and git organization info
  const page = await prisma.page.findUnique({
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
    const term = generateTermString(page.classroom.term, page.classroom.year);
    const repoName = `content-${gitOrgLogin}-${term}`;

    try {
      await ContentService.deleteFolder({
        orgLogin: gitOrgLogin,
        repo: repoName,
        path: page.content_path,
        message: `Delete page: ${page.title}`,
      });
    } catch (error) {
      console.error('Failed to delete page content from GitHub:', error);
      // Continue with database deletion even if GitHub fails
    }
  }

  // Delete from database
  await prisma.page.delete({
    where: { id: pageId },
  });

  // Update the manifest
  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error) {
    console.error('Failed to update manifest after page deletion:', error);
  }

  return { success: true, page };
}

/**
 * Find a page by content path (for syllabus bot content references)
 */
export async function findByContentPath(classroomId, contentPath, options = {}) {
  const page = await prisma.page.findFirst({
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
export async function quickUpdate(pageId, updates) {
  const page = await prisma.page.update({
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
export async function findForStudentMenu(classroomId) {
  return prisma.page.findMany({
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
