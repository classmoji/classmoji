import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { generateTermString } from '@classmoji/utils';

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

/**
 * Save the content manifest to GitHub
 * @param {number} classroomId - The classroom ID
 */
export async function saveManifest(classroomId: string): Promise<void> {
  // Get classroom with git organization
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });

  if (!classroom?.git_organization) {
    console.warn('Cannot save manifest: git organization not configured');
    return;
  }

  // Build manifest from database
  const modules = await getPrisma().module.findMany({
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
    modules: Record<string, ManifestModuleEntry>;
    general: { pages: string[]; slides: string[] };
  } = { modules: {}, general: { pages: [], slides: [] } };

  for (const mod of modules) {
    const modSlug = mod.slug ?? String(mod.id);
    manifest.modules[modSlug] = {
      pages: mod.pages.map(l => l.page.slug ?? String(l.page.id)),
      slides: mod.slides.map(l => l.slide.slug ?? String(l.slide.id)),
      assignments: {},
    };

    for (const assignment of mod.assignments) {
      const assignmentSlug = assignment.slug ?? String(assignment.id);
      manifest.modules[modSlug].assignments[assignmentSlug] = {
        pages: assignment.pages.map(l => l.page.slug ?? String(l.page.id)),
        slides: assignment.slides.map(l => l.slide.slug ?? String(l.slide.id)),
      };
    }
  }

  // Find general (unlinked) content
  manifest.general.pages = allPages
    .filter(p => p.links.length === 0)
    .map(p => p.slug ?? String(p.id));
  manifest.general.slides = allSlides
    .filter(s => s.links.length === 0)
    .map(s => s.slug ?? String(s.id));

  // Write to repo
  const term = generateTermString(classroom.term ?? undefined, classroom.year ?? undefined);
  const repoName = `content-${classroom.git_organization.login}-${term}`;

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
    console.error('Failed to save content manifest:', error instanceof Error ? error.message : String(error));
  }
}
