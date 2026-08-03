/**
 * slide.service.ts — slide CRUD orchestration (content-tools plan §5/§7).
 *
 * Mirrors page.service's shape: findById with classroom+git_organization,
 * createSlide choreography (repo ensure → starter deck saveDeck → DB row →
 * manifest refresh), deleteSlide/getSlideDeleteInfo ported from
 * apps/slides/app/utils/slideService.server.ts.
 *
 * Cloudinary stays app-local: deleteSlide accepts an optional onDeleteVideos
 * callback instead of importing the cloudinary service.
 */

import getPrisma from '@classmoji/database';
import { classroomContentRepoName } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';
import * as contentManifestService from '../classmoji/contentManifest.service.ts';
import { ensureContentRepo } from '../classmoji/page.service.ts';
import { mintSlideId, type IdGenerator } from './deckHtml.ts';
import { saveDeck } from './slideContent.service.ts';
import type { DeckJson } from './deckTypes.ts';

const THEMES_FOLDER = '.slidesthemes';

interface SlideQueryOptions {
  includeClassroom?: boolean;
  includeCreator?: boolean;
  includeLinks?: boolean;
}

/** Error `code` set when a new slide's derived content path is already taken. */
export const SLIDE_CONTENT_PATH_CONFLICT = 'SLIDE_CONTENT_PATH_CONFLICT';

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a slide by ID (mirrors page.service.findById — classroom with
 * git_organization included by default).
 */
export async function findById(slideId: string, options: SlideQueryOptions = {}) {
  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
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

  return slide;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Content-repo slug for a slide title (route-identical computation from
 * $classroomSlug.new). Content path is `slides/{slug}`.
 */
export function slideSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function slideContentPath(title: string): string {
  return `slides/${slideSlug(title)}`;
}

function escapeStarterHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The starter deck's seeded customCss — exactly the inline <style> content the
 * legacy starter template carried (slideHelpers.server.ts). Seeded because the
 * generator emits NO implicit styles.
 */
export const STARTER_CUSTOM_CSS = `
    .reveal h1, .reveal h2, .reveal h3 { color: #333; }
    .reveal .slides section { text-align: left; }
    .reveal pre { width: 100%; }
    .reveal code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  `;

/**
 * Canonical starter deck: 4 slides matching the legacy starter template's
 * content, config center:false, monokai code theme, starter customCss seeded.
 */
export function starterDeck(title: string, idGen: IdGenerator = mintSlideId): DeckJson {
  const escapedTitle = escapeStarterHtml(title);
  return {
    version: 1,
    theme: 'white',
    codeTheme: 'monokai',
    config: { center: false },
    customCss: STARTER_CUSTOM_CSS,
    slides: [
      { id: idGen(), html: `<h1>${escapedTitle}</h1>` },
      { id: idGen(), html: '<h2>Slide 2</h2>\n<p>Add your content here...</p>' },
      {
        id: idGen(),
        html:
          '<h2>Code Example</h2>\n<pre><code class="language-javascript">// Your code here\n' +
          'function example() {\n  return "Hello, World!";\n}</code></pre>',
      },
      { id: idGen(), html: '<h2>Questions?</h2>' },
    ],
  };
}

/**
 * Orchestrated slide creation: content-path collision check → ensure the
 * shared content repo exists → starter deck via saveDeck (deck.json +
 * index.html in one commit) → DB row → manifest refresh.
 */
export async function createSlide({
  classroomId,
  title,
  createdBy,
  idGen,
}: {
  classroomId: string;
  title: string;
  createdBy: string;
  /** Injectable for tests. */
  idGen?: IdGenerator;
}) {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  if (!classroom) {
    throw new Error('Classroom not found');
  }
  if (!classroom.git_organization?.login) {
    throw new Error('Git organization not configured');
  }
  if (!classroom.content_namespace) {
    throw new Error('Classroom content namespace not configured');
  }

  const slug = slideSlug(title);
  if (!slug) {
    throw new Error('Title must contain at least one letter or number');
  }
  const contentPath = `slides/${slug}`;

  // Distinct titles can normalize to the same slug/content path; slug carries
  // a [classroom_id, slug] unique constraint and an unchecked create would
  // overwrite the existing folder on GitHub before the DB create failed.
  // Refuse BEFORE any GitHub write (mirrors page.service.createPage).
  const collision = await getPrisma().slide.findFirst({
    where: {
      classroom_id: classroomId,
      OR: [{ content_path: contentPath }, { slug }],
    },
  });
  if (collision) {
    throw Object.assign(
      new Error(
        `A slide deck already uses the content path '${contentPath}' (existing deck: "${collision.title}"). Choose a title that maps to a different URL path.`
      ),
      { code: SLIDE_CONTENT_PATH_CONFLICT }
    );
  }

  await ensureContentRepo(classroomId);

  const deck = starterDeck(title, idGen);
  const { sha, commit, html } = await saveDeck({
    slide: { title, content_path: contentPath, classroom },
    deck,
    message: `Create slides: ${title}`,
  });

  const slide = await getPrisma().slide.create({
    data: {
      title,
      slug,
      content_path: contentPath,
      classroom_id: classroomId,
      created_by: createdBy,
    },
  });

  // Update manifest after creating the slide (non-fatal on failure).
  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error('Failed to update manifest after slide creation:', error);
  }

  return { slide, deck, sha, commit, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared-theme detection (deck.json-first, index.html regex fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the shared theme name for a slide folder: deck.json.theme first (the
 * source of truth once it exists), index.html data-theme regex fallback.
 */
async function readSharedThemeName({
  orgLogin,
  repo,
  contentPath,
}: {
  orgLogin: string;
  repo: string;
  contentPath: string;
}): Promise<string | null> {
  try {
    const deckFile = await ContentService.getContent({
      orgLogin,
      repo,
      path: `${contentPath}/deck.json`,
    });
    if (deckFile) {
      try {
        const deck = JSON.parse(deckFile.content) as { theme?: unknown };
        if (typeof deck?.theme === 'string') {
          // deck.json wins — a non-shared theme means no shared theme, even if
          // a stale index.html still says otherwise.
          return deck.theme.startsWith('shared:') ? deck.theme.slice('shared:'.length) : null;
        }
      } catch {
        // Malformed deck.json — fall through to the html fallback.
      }
    }
    const htmlFile = await ContentService.getContent({
      orgLogin,
      repo,
      path: `${contentPath}/index.html`,
    });
    if (htmlFile) {
      const themeMatch = htmlFile.content.match(/data-theme="shared:([^"]+)"/);
      return themeMatch ? themeMatch[1] : null;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not read slide content at ${contentPath}:`, message);
  }
  return null;
}

/**
 * Count how many slides are using a specific shared theme.
 * Ported from apps/slides slideService.server.ts with deck.json-first reads.
 */
export async function countSlidesUsingTheme(
  gitOrgLogin: string,
  contentNamespace: string,
  themeName: string
): Promise<{ count: number; slides: Array<{ id: string; title: string }> }> {
  const gitOrg = await getPrisma().gitOrganization.findFirst({
    where: { provider: 'GITHUB', login: gitOrgLogin },
  });
  if (!gitOrg?.github_installation_id) {
    return { count: 0, slides: [] };
  }

  const slides = await getPrisma().slide.findMany({
    where: { classroom: { content_namespace: contentNamespace } },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });
  const orgSlides = slides.filter(
    (s: { classroom?: { git_organization?: { login?: string } | null } | null }) =>
      s.classroom?.git_organization?.login === gitOrgLogin
  );

  const repoName = classroomContentRepoName({ login: gitOrgLogin, namespace: contentNamespace });
  const slidesUsingTheme: Array<{ id: string; title: string }> = [];

  for (const slide of orgSlides) {
    const slideTheme = await readSharedThemeName({
      orgLogin: gitOrgLogin,
      repo: repoName,
      contentPath: slide.content_path,
    });
    if (slideTheme === themeName) {
      slidesUsingTheme.push({ id: slide.id, title: slide.title });
    }
  }

  return { count: slidesUsingTheme.length, slides: slidesUsingTheme };
}

/**
 * Delete a shared theme's folder from the content repo.
 */
export async function deleteSharedTheme(
  gitOrgLogin: string,
  contentNamespace: string,
  themeName: string
): Promise<void> {
  const gitOrg = await getPrisma().gitOrganization.findFirst({
    where: { provider: 'GITHUB', login: gitOrgLogin },
  });
  if (!gitOrg?.github_installation_id) {
    throw new Error('Git organization not found');
  }

  const repoName = classroomContentRepoName({ login: gitOrgLogin, namespace: contentNamespace });
  await ContentService.deleteFolder({
    orgLogin: gitOrgLogin,
    repo: repoName,
    path: `${THEMES_FOLDER}/${themeName}`,
    message: `Delete shared theme: ${themeName}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Literal-include lookup so Prisma statically types the nested
 * classroom.git_organization (the dynamic include in findById can't).
 */
async function loadSlideWithClassroom(slideId: string) {
  return getPrisma().slide.findUnique({
    where: { id: slideId },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });
}

/**
 * Delete a slide and its content from GitHub.
 *
 * Cloudinary video cleanup stays app-local: pass onDeleteVideos to run it
 * (videos live under the cloudinary folder `classmoji/slides/{slideId}/`).
 */
export async function deleteSlide({
  slideId,
  deleteTheme = false,
  onDeleteVideos,
}: {
  slideId: string;
  deleteTheme?: boolean;
  onDeleteVideos?: (slideId: string) => Promise<unknown>;
}): Promise<{
  success: boolean;
  themeName: string | null;
  themeDeleted: boolean;
  otherSlidesUsingTheme: number;
}> {
  const slide = await loadSlideWithClassroom(slideId);
  if (!slide) {
    throw new Error('Slide not found');
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Error('Git organization not configured');
  }
  if (!slide.classroom.git_organization?.github_installation_id) {
    throw new Error('GitHub installation not configured');
  }

  const repoName = classroomContentRepoName({
    login: gitOrgLogin,
    namespace: slide.classroom.content_namespace,
  });

  // Check if this slide uses a shared theme (deck.json-first).
  const themeName = await readSharedThemeName({
    orgLogin: gitOrgLogin,
    repo: repoName,
    contentPath: slide.content_path,
  });
  let themeDeleted = false;
  let otherSlidesUsingTheme = 0;

  // Delete the slide content folder from GitHub.
  try {
    await ContentService.deleteFolder({
      orgLogin: gitOrgLogin,
      repo: repoName,
      path: slide.content_path,
      message: `Delete slide: ${slide.title}`,
    });
  } catch (error: unknown) {
    console.error('Failed to delete slide content from GitHub:', error);
    // Continue with database deletion even if GitHub fails.
  }

  // Cloudinary cleanup via the app-provided callback.
  if (onDeleteVideos) {
    try {
      await onDeleteVideos(slideId);
    } catch (error: unknown) {
      console.error('Failed to delete slide videos:', error);
    }
  }

  // Handle shared theme deletion if requested.
  if (themeName && deleteTheme) {
    const themeUsage = await countSlidesUsingTheme(
      gitOrgLogin,
      slide.classroom.content_namespace,
      themeName
    );
    otherSlidesUsingTheme = themeUsage.slides.filter(s => s.id !== slideId).length;

    if (otherSlidesUsingTheme === 0) {
      try {
        await deleteSharedTheme(gitOrgLogin, slide.classroom.content_namespace, themeName);
        themeDeleted = true;
      } catch (error: unknown) {
        console.error('Failed to delete shared theme:', error);
      }
    }
  }

  const classroomId = slide.classroom_id;

  await getPrisma().slide.delete({
    where: { id: slideId },
  });

  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error('Failed to update manifest after slide deletion:', error);
  }

  return {
    success: true,
    themeName,
    themeDeleted,
    otherSlidesUsingTheme,
  };
}

/**
 * Get slide info including theme usage for the deletion confirmation dialog.
 */
export async function getSlideDeleteInfo(slideId: string) {
  const slide = await loadSlideWithClassroom(slideId);
  if (!slide) {
    throw new Error('Slide not found');
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin || !slide.classroom.git_organization?.github_installation_id) {
    return { slide, themeName: null };
  }

  const repoName = classroomContentRepoName({
    login: gitOrgLogin,
    namespace: slide.classroom.content_namespace,
  });

  const themeName = await readSharedThemeName({
    orgLogin: gitOrgLogin,
    repo: repoName,
    contentPath: slide.content_path,
  });
  if (!themeName) {
    return { slide, themeName: null };
  }

  const themeUsage = await countSlidesUsingTheme(
    gitOrgLogin,
    slide.classroom.content_namespace,
    themeName
  );
  const otherSlides = themeUsage.slides.filter(s => s.id !== slideId);

  return {
    slide,
    themeName,
    otherSlidesUsingTheme: otherSlides.length,
    slideList: otherSlides,
  };
}
