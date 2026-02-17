import prisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { generateTermString } from '@classmoji/utils';

/**
 * Content Manifest Service
 * Manages the .classmoji/manifest.json file in the GitHub content repo
 */

/**
 * Save the content manifest to GitHub
 * @param {number} classroomId - The classroom ID
 */
export async function saveManifest(classroomId) {
  // Get classroom with git organization
  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });

  if (!classroom?.git_organization) {
    console.warn('Cannot save manifest: git organization not configured');
    return;
  }

  // Build manifest from database
  const modules = await prisma.module.findMany({
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
  const allPages = await prisma.page.findMany({
    where: { classroom_id: classroomId },
    include: { links: true },
  });
  const allSlides = await prisma.slide.findMany({
    where: { classroom_id: classroomId },
    include: { links: true },
  });

  // Build manifest using slugs as keys
  const manifest = { modules: {}, general: { pages: [], slides: [] } };

  for (const mod of modules) {
    manifest.modules[mod.slug] = {
      pages: mod.pages.map(l => l.page.slug),
      slides: mod.slides.map(l => l.slide.slug),
      assignments: {},
    };

    for (const assignment of mod.assignments) {
      manifest.modules[mod.slug].assignments[assignment.slug] = {
        pages: assignment.pages.map(l => l.page.slug),
        slides: assignment.slides.map(l => l.slide.slug),
      };
    }
  }

  // Find general (unlinked) content
  manifest.general.pages = allPages
    .filter(p => p.links.length === 0)
    .map(p => p.slug);
  manifest.general.slides = allSlides
    .filter(s => s.links.length === 0)
    .map(s => s.slug);

  // Write to repo
  const term = generateTermString(classroom.term, classroom.year);
  const repoName = `content-${classroom.git_organization.login}-${term}`;

  try {
    await ContentService.put({
      gitOrganization: classroom.git_organization,
      repo: repoName,
      path: '.classmoji/manifest.json',
      content: JSON.stringify(manifest, null, 2),
      message: 'Update content manifest',
    });
  } catch (error) {
    // Log but don't fail the request if manifest save fails
    console.error('Failed to save content manifest:', error.message);
  }
}
