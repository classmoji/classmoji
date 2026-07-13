import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import { ContentService } from '@classmoji/content';
import { getGitProvider } from '../git/index.ts';
import * as contentManifestService from './contentManifest.service.ts';
import * as notificationService from './notification.service.ts';
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
  const { id: _id, ...safeValues } = values;

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
          repository: true,
          assignment: true,
        },
      },
    },
  });

  return page;
}

// ─── Create-page choreography (extract-first, plan §5.2 gap 2) ──────────────
// The full "create a page" operation is: ensure the shared per-classroom
// content repo exists on GitHub → upload the page folder's files (always an
// index.html, plus any imported assets) → create the DB row → optionally link
// it to a repository → refresh the content manifest. This used to be
// duplicated in admin.$class.pages.new/route.tsx and api.pages.batch/route.ts;
// both now call createPage()/ensureContentRepo() below.

/**
 * Content-repo folder for a page title: `pages/{slug}`.
 * NOTE: this slug is the CONTENT PATH slug (route-identical regex) — distinct
 * from the DB `slug` column, which uses titleToIdentifier.
 */
export function pageContentPath(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `pages/${slug}`;
}

/** Initial index.html content for a blank page (web "Create Blank" flow). */
export function generatePageTemplate(_title: string): string {
  return `Add your content here...\n`;
}

/** A file to commit alongside the page's index.html (import-flow assets). */
export interface PageFileUpload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
}

/** Load the classroom and derive its content-repo coordinates, or throw. */
async function resolveContentRepo(classroomId: string) {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  if (!classroom) {
    throw new Error('Classroom not found');
  }
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Error('Git organization not configured');
  }
  if (!classroom.content_namespace) {
    throw new Error('Classroom content namespace not configured');
  }
  // Content repo name: content-{gitOrgLogin}-{contentNamespace}
  return {
    classroom,
    gitOrgLogin,
    repoName: `content-${gitOrgLogin}-${classroom.content_namespace}`,
  };
}

type ContentRepoContext = Awaited<ReturnType<typeof resolveContentRepo>>;

async function ensureContentRepoExists({ classroom, gitOrgLogin, repoName }: ContentRepoContext) {
  const gitProvider = getGitProvider(classroom.git_organization!);
  const repoExists = await gitProvider.repositoryExists(gitOrgLogin, repoName);
  if (!repoExists) {
    try {
      await gitProvider.createPublicRepository(
        gitOrgLogin,
        repoName,
        `Course content for ${classroom.name || gitOrgLogin} - ${classroom.content_namespace}`
      );

      // Give GitHub a moment to initialize the repo
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (repoError) {
      console.error('Failed to create GitHub repository:', repoError);
      throw new Error(
        'Failed to create GitHub repository. Please check your GitHub organization permissions'
      );
    }
  }

  // Always try to enable GitHub Pages (idempotent - skips if already enabled)
  try {
    await gitProvider.enableGitHubPages(gitOrgLogin, repoName);
  } catch (pagesError) {
    // Pages API requires special permission - log but continue
    console.warn(
      `Could not auto-enable GitHub Pages: ${pagesError instanceof Error ? pagesError.message : String(pagesError)}`
    );
  }
}

/**
 * Make sure the classroom's shared content repo exists on GitHub (creating it
 * and enabling GitHub Pages when missing). Idempotent.
 */
export async function ensureContentRepo(classroomId: string) {
  const ctx = await resolveContentRepo(classroomId);
  await ensureContentRepoExists(ctx);
  return { repoName: ctx.repoName };
}

/**
 * Orchestrated page creation: content-repo folder + index.html (+ any extra
 * files) on GitHub, DB row, optional repository link, manifest refresh.
 *
 * @param html   index.html content; defaults to the blank-page template.
 * @param files  Extra files to commit in the same batch (full repo paths,
 *               e.g. `pages/{slug}/assets/foo.png`) — the import flow's images.
 * @param ensureRepo  Skip the exists/create check when the caller already ran
 *                    ensureContentRepo (batch import).
 * @param commitMessage  Override the default commit message
 *                       (`Create page: {title}` / `Import page: {title}`).
 */
export async function createPage({
  classroomId,
  title,
  html,
  files = [],
  createdBy,
  linkRepositoryId = null,
  ensureRepo = true,
  commitMessage,
}: {
  classroomId: string;
  title: string;
  html?: string;
  files?: PageFileUpload[];
  createdBy: string;
  linkRepositoryId?: string | null;
  ensureRepo?: boolean;
  commitMessage?: string;
}) {
  const ctx = await resolveContentRepo(classroomId);
  if (ensureRepo) {
    await ensureContentRepoExists(ctx);
  }

  const contentPath = pageContentPath(title);
  const htmlPath = `${contentPath}/index.html`;
  const pageHtml = html ?? generatePageTemplate(title);

  if (files.length > 0) {
    // Import flow: assets + index.html in a single batch commit.
    try {
      await ContentService.uploadBatch({
        gitOrganization: ctx.classroom.git_organization!,
        repo: ctx.repoName,
        files: [...files, { path: htmlPath, content: pageHtml, encoding: 'utf-8' }],
        branch: 'main',
        message: commitMessage ?? `Import page: ${title}`,
      });
    } catch (uploadError) {
      console.error('Failed to upload files to GitHub:', uploadError);
      throw new Error(
        `Failed to upload files to GitHub: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        { cause: uploadError }
      );
    }
  } else {
    // Blank flow: single-file commit.
    try {
      await ContentService.put({
        gitOrganization: ctx.classroom.git_organization!,
        repo: ctx.repoName,
        path: htmlPath,
        content: pageHtml,
        message: commitMessage ?? `Create page: ${title}`,
      });
    } catch (uploadError) {
      console.error('Failed to upload file to GitHub:', uploadError);
      throw new Error(
        `Failed to upload file to GitHub: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        { cause: uploadError }
      );
    }
  }

  try {
    const page = await create({
      classroom_id: ctx.classroom.id,
      title,
      content_path: contentPath,
      created_by: createdBy,
    });

    // Link to repository if specified (batch import)
    if (linkRepositoryId) {
      await linkPage(page.id, { repositoryId: linkRepositoryId });
    }

    // Update manifest after creating page
    await contentManifestService.saveManifest(ctx.classroom.id);

    return page;
  } catch (dbError) {
    console.error('Failed to save page to database:', dbError);
    throw new Error(
      `Page created in GitHub but failed to save to database: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      { cause: dbError }
    );
  }
}

/**
 * Find a page by ID
 */
export async function findById(pageId: string, options: PageQueryOptions = {}) {
  const page = await getPrisma().page.findUnique({
    where: { id: pageId },
    include: {
      classroom:
        (options.includeClassroom ?? true)
          ? {
              include: {
                git_organization: true,
              },
            }
          : false,
      creator: options.includeCreator ?? false,
      links:
        (options.includeLinks ?? false)
          ? {
              include: {
                repository: true,
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
      classroom:
        (options.includeClassroom ?? false)
          ? {
              include: {
                git_organization: true,
              },
            }
          : false,
      creator: options.includeCreator ?? true,
      links:
        (options.includeLinks ?? false)
          ? {
              include: {
                repository: true,
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
 * Find pages linked to a repository
 */
export async function findByRepository(repositoryId: string) {
  const pageLinks = await getPrisma().pageLink.findMany({
    where: {
      repository_id: repositoryId,
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
 * Link a page to a repository or assignment
 */
export async function linkPage(
  pageId: string,
  {
    repositoryId,
    assignmentId,
    order = 0,
  }: { repositoryId?: string; assignmentId?: string; order?: number }
) {
  const link = await getPrisma().pageLink.create({
    data: {
      page_id: pageId,
      repository_id: repositoryId || null,
      assignment_id: assignmentId || null,
      order,
    },
    include: {
      page: true,
      repository: true,
      assignment: true,
    },
  });

  return link;
}

/**
 * Unlink a page from a repository or assignment
 */
export async function unlinkPage(
  pageId: string,
  { repositoryId, assignmentId }: { repositoryId?: string; assignmentId?: string }
) {
  const link = await getPrisma().pageLink.deleteMany({
    where: {
      page_id: pageId,
      repository_id: repositoryId || null,
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
  updates: Pick<Prisma.PageUncheckedUpdateInput, 'title' | 'content_path' | 'show_in_student_menu'>
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
          repository: true,
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
    const repoName = `content-${gitOrgLogin}-${page.classroom.content_namespace}`;

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
      classroom:
        (options.includeClassroom ?? true)
          ? {
              include: {
                git_organization: true,
              },
            }
          : false,
      creator: options.includeCreator ?? false,
      links:
        (options.includeLinks ?? false)
          ? {
              include: {
                repository: true,
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
  const previous =
    'is_draft' in updates
      ? await getPrisma().page.findUnique({
          where: { id: pageId },
          select: { is_draft: true },
        })
      : null;

  const page = await getPrisma().page.update({
    where: { id: pageId },
    data: {
      ...updates,
      updated_at: new Date(),
    },
  });

  if (previous && previous.is_draft !== page.is_draft) {
    await notificationService.runSafely('page publish notification', async () => {
      const studentIds = await notificationService.getStudentsInClassroom(page.classroom_id);
      await notificationService.createNotifications({
        type: page.is_draft ? 'PAGE_UNPUBLISHED' : 'PAGE_PUBLISHED',
        classroomId: page.classroom_id,
        recipientUserIds: studentIds,
        resourceType: 'page',
        resourceId: page.id,
        title: page.is_draft ? `Page unpublished: ${page.title}` : `Page published: ${page.title}`,
      });
    });
  }

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
      { menu_order: 'asc' }, // Null values go last
      { title: 'asc' }, // Then alphabetically
    ],
    select: {
      id: true,
      title: true,
      menu_order: true,
    },
  });
}
