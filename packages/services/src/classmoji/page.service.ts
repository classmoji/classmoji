import getPrisma from '@classmoji/database';
import { titleToIdentifier, RESERVED_PAGE_SLUGS } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';
import { getGitProvider } from '../git/index.ts';
import { recordContentAssets, removeContentAssetFolder } from './contentAssets.service.ts';
import * as contentManifestService from './contentManifest.service.ts';
import * as notificationService from './notification.service.ts';
import { blankPageContentJson, previewBranchName } from './pageContent.service.ts';
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

// ─── Page slug allocation ───────────────────────────────────────────────────
// `slug` is the page's address on the classroom's public course site
// (`{subdomain}.classmoji.io/{slug}`) and is unique per classroom. It is set
// once at create and never updated — renaming a page must not break a URL that
// is already in circulation.

/**
 * Highest numeric fallback: `{base}-2` … `{base}-50`. Mirrored by `max_suffix`
 * in the 20260821003300_page_slug_backfill_and_unique migration so a row
 * renamed there and a page created here are named by the same rule. The
 * migration additionally falls back to an id suffix; this does not, on purpose
 * — a release command must never fail, but a human creating their 50th "Lab 1"
 * is better served by an error than by `lab-1-a3f9c210`.
 */
export const PAGE_SLUG_MAX_SUFFIX = 50;

/** Error `code` set when every slug candidate for a new page is taken. */
export const PAGE_SLUG_UNAVAILABLE = 'PAGE_SLUG_UNAVAILABLE';

/**
 * The unique index a colliding page SLUG violates, and the field set Prisma
 * reports for it.
 *
 * `pages` carries TWO composite uniques — [classroom_id, title] and
 * [classroom_id, slug] — so a bare `code === 'P2002'` test is wrong: it would
 * turn "a page with this title already exists", which the user must see and
 * fix, into a silent walk down slug candidates that all fail on the title and
 * end in a bogus PAGE_SLUG_UNAVAILABLE. Matching is EXACT on the field set.
 *
 * Prisma does not pin the shape of `meta.target`: depending on driver and
 * version it is an array of field names, the raw constraint name, or that name
 * inside a one-element array. All three are handled — the same reasoning, and
 * the same shape, as `isClassroomSlugConflict` in classroomSlug.ts.
 */
const PAGE_SLUG_INDEX_NAME = 'pages_classroom_id_slug_key';
const PAGE_SLUG_FIELD_SET = 'classroom_id,slug';

const targetTokens = (target: unknown): string[] => {
  const raw = Array.isArray(target) ? target : typeof target === 'string' ? target.split(',') : [];
  return raw.map(t => String(t).trim().toLowerCase()).filter(Boolean);
};

/** Is this error a unique violation on the page (classroom_id, slug) index? */
export function isPageSlugConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;

  const tokens = targetTokens((error as { meta?: { target?: unknown } }).meta?.target);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0] === PAGE_SLUG_INDEX_NAME) return true;
  return [...tokens].sort().join(',') === PAGE_SLUG_FIELD_SET;
}

/**
 * The slugs to try, in order, for a page with this title: the derived slug,
 * then `{base}-2` … `{base}-N`.
 *
 * Returns `[]` when the title has no slug-usable characters — the page then
 * gets slug NULL, never '' (an empty string is an ordinary value under the
 * unique index and a second one would collide; NULL is exempt). That the old
 * code wrote '' here is exactly what the backfill migration had to clean up.
 *
 * A base that lands on a RESERVED_PAGE_SLUGS entry is skipped rather than
 * offered: `{subdomain}/app` and `{subdomain}/schedule` belong to the platform,
 * so a page titled "Schedule" starts at `schedule-2`.
 */
export function pageSlugCandidates(title: string): string[] {
  const base = titleToIdentifier(title);
  if (!base) return [];

  const candidates = RESERVED_PAGE_SLUGS.has(base) ? [] : [base];
  for (let n = 2; n <= PAGE_SLUG_MAX_SUFFIX; n++) candidates.push(`${base}-${n}`);
  return candidates;
}

const CREATE_INCLUDE = {
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
} satisfies Prisma.PageInclude;

/**
 * Run `write` with the first page slug this classroom does not already hold.
 *
 * Insert-and-catch, never scan-then-insert: a uniqueness check followed by an
 * insert is two statements with a gap between them, and two admins creating
 * "Lab 1" at once both read "free" before either writes. The index is the only
 * authority; a P2002 on it is the signal to try the next candidate.
 *
 * `write` receives `null` when the title has no slug-usable characters and MUST
 * store it as such — never ''. It performs the whole write, and must NOT run
 * inside an interactive `prisma.$transaction`: a P2002 raised in one aborts the
 * whole transaction (Postgres 25P02), so every remaining candidate would fail
 * with "current transaction is aborted". Same constraint, same reasoning as
 * `createWithUniqueClassroomSlug` in classroomSlug.ts.
 *
 * Callback-shaped rather than a create() wrapper so the import paths — which
 * write columns create() does not carry (width, menu_order, header_image_*) and
 * sometimes hold their own PrismaClient — get the identical allocation rule
 * instead of a second, drifting copy.
 *
 * @throws an Error with `code = PAGE_SLUG_UNAVAILABLE` when every candidate is taken.
 */
export async function createWithUniquePageSlug<T>(
  title: string,
  write: (slug: string | null) => Promise<T>
): Promise<T> {
  const candidates = pageSlugCandidates(title);

  // Title with no usable characters (an emoji, punctuation). NULL, not '': the
  // page simply has no site URL and stays reachable by id.
  if (candidates.length === 0) return write(null);

  for (const candidate of candidates) {
    try {
      return await write(candidate);
    } catch (error: unknown) {
      // A duplicate TITLE (the other composite unique on this table) is the
      // caller's problem and propagates untouched.
      if (!isPageSlugConflict(error)) throw error;
    }
  }

  throw Object.assign(
    new Error(
      `No free page slug for "${title}" — all ${candidates.length} candidates are taken. Choose a different title.`
    ),
    { code: PAGE_SLUG_UNAVAILABLE }
  );
}

/**
 * Create a new page, taking the first free slug.
 */
export async function create(values: Prisma.PageUncheckedCreateInput) {
  // Explicitly exclude id - Prisma will auto-generate with uuid()
  // `slug` is likewise never taken from the caller: it is derived here so every
  // creation path (web, import, MCP) produces the same address for a title.
  const { id: _id, slug: _slug, ...safeValues } = values;

  const data = {
    classroom_id: safeValues.classroom_id,
    title: safeValues.title,
    content_path: safeValues.content_path,
    created_by: safeValues.created_by,
    is_draft: safeValues.is_draft ?? true,
    is_public: safeValues.is_public ?? false,
    show_in_student_menu: safeValues.show_in_student_menu ?? false,
  };

  return createWithUniquePageSlug(safeValues.title, slug =>
    getPrisma().page.create({ data: { ...data, slug }, include: CREATE_INCLUDE })
  );
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

/** Error `code` set when a new page's derived content path is already taken. */
export const PAGE_CONTENT_PATH_CONFLICT = 'PAGE_CONTENT_PATH_CONFLICT';

/** Load the classroom and its content-repo coordinates, or throw. */
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
  if (!classroom.content_repo) {
    throw new Error('Classroom content repo not configured');
  }
  // Stored, user-editable repo name — never re-derived from org + namespace.
  return {
    classroom,
    gitOrgLogin,
    repoName: classroom.content_repo,
  };
}

type ContentRepoContext = Awaited<ReturnType<typeof resolveContentRepo>>;

/**
 * Best-effort deletion of the singleton preview branch for a content path.
 * 404/422 (branch absent) is the common case and silent; any other failure is
 * loud but non-fatal — callers proceed either way.
 */
async function deletePreviewBranchBestEffort({
  orgLogin,
  repo,
  contentPath,
  context,
}: {
  orgLogin: string;
  repo: string;
  contentPath: string;
  context: string;
}): Promise<void> {
  const branch = previewBranchName(contentPath);
  try {
    await ContentService.deleteBranch({ orgLogin, repo, branch });
    console.warn(`[page.service] Deleted preview branch ${branch} (${context})`);
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) return; // already absent
    console.error(`[page.service] Failed to delete preview branch ${branch} (${context}):`, error);
  }
}

async function ensureContentRepoExists({ classroom, gitOrgLogin, repoName }: ContentRepoContext) {
  const gitProvider = getGitProvider(classroom.git_organization!);
  const repoExists = await gitProvider.repositoryExists(gitOrgLogin, repoName);
  if (!repoExists) {
    try {
      await gitProvider.createPublicRepository(
        gitOrgLogin,
        repoName,
        `Course content for ${classroom.name || gitOrgLogin}`
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

  const contentPath = pageContentPath(title);

  // Distinct titles can normalize to the SAME content path ("Lab 1" and
  // "Lab-1" → pages/lab-1), and content_path carries no unique constraint —
  // only [classroom_id, title] does. An unchecked create would overwrite the
  // existing folder's committed content on GitHub before the DB create ever
  // ran (and same-title dups clobbered GitHub before failing on P2002).
  // Refuse BEFORE any GitHub write.
  const collision = await findByContentPath(classroomId, contentPath, {
    includeClassroom: false,
  });
  if (collision) {
    throw Object.assign(
      new Error(
        `A page already uses the content path '${contentPath}' (existing page: "${collision.title}"). Choose a title that maps to a different URL path.`
      ),
      { code: PAGE_CONTENT_PATH_CONFLICT }
    );
  }

  if (ensureRepo) {
    await ensureContentRepoExists(ctx);
  }

  // Slug-reuse retarget guard: a preview branch left over from a previously
  // deleted page at the same content path would make this new page appear to
  // have pending (stale) edits — clear it before the first write.
  await deletePreviewBranchBestEffort({
    orgLogin: ctx.gitOrgLogin,
    repo: ctx.repoName,
    contentPath,
    context: 'stale preview from a reused slug, cleared before create',
  });

  const htmlPath = `${contentPath}/index.html`;

  // Every branch below records what it committed. `content.json` and
  // `index.html` are READ through the asset map now (see `fetchContentText`),
  // so a page created without rows is a page that renders as empty until the
  // push webhook lands — a fresh page, blank for a minute, on the one surface
  // where the author is watching.
  let written: Array<{ path: string; sha: string }> = [];

  if (files.length > 0) {
    // Import flow: assets + index.html in a single batch commit.
    try {
      const result = await ContentService.uploadBatch({
        gitOrganization: ctx.classroom.git_organization!,
        repo: ctx.repoName,
        files: [
          ...files,
          { path: htmlPath, content: html ?? generatePageTemplate(title), encoding: 'utf-8' },
        ],
        branch: 'main',
        message: commitMessage ?? `Import page: ${title}`,
      });
      written = result.files;
    } catch (uploadError) {
      console.error('Failed to upload files to GitHub:', uploadError);
      throw new Error(
        `Failed to upload files to GitHub: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        { cause: uploadError }
      );
    }
  } else if (html != null) {
    // Import/markdown flow without extra assets: single-file commit.
    try {
      const result = await ContentService.put({
        gitOrganization: ctx.classroom.git_organization!,
        repo: ctx.repoName,
        path: htmlPath,
        content: html,
        message: commitMessage ?? `Create page: ${title}`,
      });
      written = [{ path: htmlPath, sha: result.sha }];
    } catch (uploadError) {
      console.error('Failed to upload file to GitHub:', uploadError);
      throw new Error(
        `Failed to upload file to GitHub: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        { cause: uploadError }
      );
    }
  } else {
    // Blank flow: index.html (kept for URL/manifest stability) + a blank
    // BlockNote content.json wrapper in ONE commit, so fresh pages are
    // json-first for the granular content tools from birth.
    try {
      const result = await ContentService.uploadBatch({
        gitOrganization: ctx.classroom.git_organization!,
        repo: ctx.repoName,
        files: [
          { path: htmlPath, content: generatePageTemplate(title), encoding: 'utf-8' },
          {
            path: `${contentPath}/content.json`,
            content: blankPageContentJson(),
            encoding: 'utf-8',
          },
        ],
        branch: 'main',
        message: commitMessage ?? `Create page: ${title}`,
      });
      written = result.files;
    } catch (uploadError) {
      console.error('Failed to upload files to GitHub:', uploadError);
      throw new Error(
        `Failed to upload files to GitHub: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
        { cause: uploadError }
      );
    }
  }

  // Never throws, and its failure is not this caller's problem: the files are
  // already committed, and the next sync writes the same rows.
  //
  // No sizes: the import branch's `files` carry base64 for binary uploads, so a
  // byte length taken here would be the encoding's, not the file's — and a
  // wrong size overwrites a right one a tree sync measured. Omitted rather than
  // guessed; the next full sync fills the column in.
  await recordContentAssets(
    ctx.classroom.id,
    written.map(file => ({ path: file.path, sha: file.sha }))
  );

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
    const repoName = page.classroom.content_repo;

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

    // Forget the map rows too. The blobs are content-addressed and immutable,
    // so a surviving row keeps serving the deleted page's last bytes out of R2
    // — a deleted page that still renders, until the next sweep.
    await removeContentAssetFolder(classroomId, page.content_path);

    // Drop any pending preview branch alongside the folder — a stale
    // preview/<content_path> ref would retarget a future page reusing the slug.
    await deletePreviewBranchBestEffort({
      orgLogin: gitOrgLogin,
      repo: repoName,
      contentPath: page.content_path,
      context: 'page deleted',
    });
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
