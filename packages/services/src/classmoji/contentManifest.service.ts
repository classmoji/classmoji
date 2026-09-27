import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';

interface ManifestAssignmentEntry {
  pages: string[];
  slides: string[];
}

interface ManifestModuleEntry {
  pages: string[];
  slides: string[];
  assignments: Record<string, ManifestAssignmentEntry>;
}

/**
 * Content Manifest Service
 * Manages the .classmoji/manifest.json file in the GitHub content repo
 */

/** Whether any link places the document on a repository or an assignment. */
export const isPlaced = (
  links: ReadonlyArray<{ repository_id: string | null; assignment_id: string | null }>
): boolean => links.some(link => Boolean(link.repository_id || link.assignment_id));

/**
 * Save the content manifest to GitHub.
 *
 * Returns whether the manifest actually reached the content repo: `true` only
 * after the commit lands, `false` when the push was skipped (no git
 * organization configured) or failed. Callers that report a manifest state to a
 * user should relay it; the ones that only refresh the manifest as a side
 * effect can keep ignoring it. Throwing behaviour is unchanged — a GitHub
 * failure is still swallowed, since the database write it follows is already
 * committed.
 *
 * @param {string} classroomId - The classroom ID
 */
export async function saveManifest(classroomId: string): Promise<boolean> {
  // Get classroom with git organization
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });

  if (!classroom?.git_organization) {
    console.warn('Cannot save manifest: git organization not configured');
    return false;
  }

  // Build manifest from database
  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroomId },
    include: {
      pages: { include: { page: true } },
      slides: { include: { slide: true } },
      assignments: {
        include: {
          pages: { include: { page: true } },
          slides: { include: { slide: true } },
        },
      },
    },
    orderBy: { title: 'asc' },
  });

  // Get all pages/slides to find unlinked ones
  const allPages = await getPrisma().page.findMany({
    where: { classroom_id: classroomId },
    include: { links: true },
  });
  const allSlides = await getPrisma().slide.findMany({
    where: { classroom_id: classroomId },
    include: { links: true },
  });

  // Build manifest using slugs as keys
  const manifest: {
    repositories: Record<string, ManifestModuleEntry>;
    general: { pages: string[]; slides: string[] };
  } = { repositories: {}, general: { pages: [], slides: [] } };

  for (const mod of repositories) {
    const modSlug = mod.slug ?? String(mod.id);
    manifest.repositories[modSlug] = {
      pages: mod.pages.map(l => l.page.slug ?? String(l.page.id)),
      slides: mod.slides.map(l => l.slide.slug ?? String(l.slide.id)),
      assignments: {},
    };

    for (const assignment of mod.assignments) {
      const assignmentSlug = assignment.slug ?? String(assignment.id);
      manifest.repositories[modSlug].assignments[assignmentSlug] = {
        pages: assignment.pages.map(l => l.page.slug ?? String(l.page.id)),
        slides: assignment.slides.map(l => l.slide.slug ?? String(l.slide.id)),
      };
    }
  }

  // Find general content: whatever is not placed on a repository or an
  // assignment. A link to a QUIZ (source material) is not a placement — the
  // manifest has no quiz section — so a page or deck linked only to quizzes
  // stays general rather than silently dropping out of the manifest.
  manifest.general.pages = allPages
    .filter(p => !isPlaced(p.links))
    .map(p => p.slug ?? String(p.id));
  manifest.general.slides = allSlides
    .filter(s => !isPlaced(s.links))
    .map(s => s.slug ?? String(s.id));

  // Write to repo
  const repoName = classroom.content_repo;

  try {
    await ContentService.put({
      gitOrganization: classroom.git_organization,
      repo: repoName,
      path: '.classmoji/manifest.json',
      content: JSON.stringify(manifest, null, 2),
      message: 'Update content manifest',
    });
  } catch (error: unknown) {
    // Log but don't fail the request if manifest save fails
    console.error(
      'Failed to save content manifest:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }

  return true;
}
