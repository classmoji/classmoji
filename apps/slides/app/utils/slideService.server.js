/**
 * Slide Service
 *
 * Handles slide operations including deletion with GitHub cleanup.
 */

import { ContentService } from '@classmoji/content';
import { GitHubProvider, ClassmojiService } from '@classmoji/services';
import prisma from '@classmoji/database';
import { deleteSlideVideos } from './cloudinaryService.server';

const THEMES_FOLDER = '.slidesthemes';

/**
 * Get the shared theme name from slide HTML content
 * @param {string} htmlContent - The slide HTML content
 * @returns {string|null} - The shared theme name or null
 */
function getSharedThemeFromHtml(htmlContent) {
  const themeMatch = htmlContent.match(/data-theme="shared:([^"]+)"/);
  return themeMatch ? themeMatch[1] : null;
}

/**
 * Count how many slides are using a specific shared theme
 * @param {string} gitOrgLogin - Git organization login
 * @param {string} term - Term string (e.g., "25w")
 * @param {string} themeName - Theme name to check
 * @returns {Promise<{count: number, slides: Array<{id: string, title: string}>}>}
 */
export async function countSlidesUsingTheme(gitOrgLogin, term, themeName) {
  // Get git organization for installation ID
  const gitOrg = await prisma.gitOrganization.findFirst({
    where: { provider: 'GITHUB', login: gitOrgLogin },
  });

  if (!gitOrg?.github_installation_id) {
    return { count: 0, slides: [] };
  }

  // Get all slides for this term
  const slides = await prisma.slide.findMany({
    where: { term },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });

  // Filter to slides from this git org
  const orgSlides = slides.filter(
    s => s.classroom?.git_organization?.login === gitOrgLogin
  );

  const gitProvider = new GitHubProvider(gitOrg.github_installation_id, gitOrgLogin);
  const octokit = await gitProvider.getOctokit();
  const repoName = `content-${gitOrgLogin}-${term}`;

  const slidesUsingTheme = [];

  for (const slide of orgSlides) {
    try {
      // Fetch the slide's index.html to check its theme
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: gitOrgLogin,
        repo: repoName,
        path: `${slide.content_path}/index.html`,
      });

      const htmlContent = Buffer.from(data.content, 'base64').toString('utf-8');
      const slideTheme = getSharedThemeFromHtml(htmlContent);

      if (slideTheme === themeName) {
        slidesUsingTheme.push({ id: slide.id, title: slide.title });
      }
    } catch (error) {
      // Skip slides that can't be read
      console.warn(`Could not read slide ${slide.id}:`, error.message);
    }
  }

  return {
    count: slidesUsingTheme.length,
    slides: slidesUsingTheme,
  };
}

/**
 * Delete a shared theme from GitHub
 * @param {string} gitOrgLogin - Git organization login
 * @param {string} term - Term string
 * @param {string} themeName - Theme name to delete
 */
export async function deleteSharedTheme(gitOrgLogin, term, themeName) {
  const gitOrg = await prisma.gitOrganization.findFirst({
    where: { provider: 'GITHUB', login: gitOrgLogin },
  });

  if (!gitOrg?.github_installation_id) {
    throw new Error('Git organization not found');
  }

  const repoName = `content-${gitOrgLogin}-${term}`;
  const themePath = `${THEMES_FOLDER}/${themeName}`;

  await ContentService.deleteFolder({
    orgLogin: gitOrgLogin,
    repo: repoName,
    path: themePath,
    message: `Delete shared theme: ${themeName}`,
  });
}

/**
 * Delete a slide and its content from GitHub
 * @param {Object} options
 * @param {string} options.slideId - Slide ID to delete
 * @param {boolean} [options.deleteTheme=false] - Whether to delete the shared theme
 * @returns {Promise<{success: boolean, themeName?: string, themeDeleted?: boolean, otherSlidesUsingTheme?: number}>}
 */
export async function deleteSlide({ slideId, deleteTheme = false }) {
  // Get the slide with classroom and git organization info
  const slide = await prisma.slide.findUnique({
    where: { id: slideId },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });

  if (!slide) {
    throw new Error('Slide not found');
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Error('Git organization not configured');
  }

  const gitOrg = slide.classroom.git_organization;
  if (!gitOrg.github_installation_id) {
    throw new Error('GitHub installation not configured');
  }

  const repoName = `content-${gitOrgLogin}-${slide.term}`;
  const gitProvider = new GitHubProvider(gitOrg.github_installation_id, gitOrgLogin);
  const octokit = await gitProvider.getOctokit();

  // Check if this slide uses a shared theme
  let themeName = null;
  let themeDeleted = false;
  let otherSlidesUsingTheme = 0;

  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: gitOrgLogin,
      repo: repoName,
      path: `${slide.content_path}/index.html`,
    });

    const htmlContent = Buffer.from(data.content, 'base64').toString('utf-8');
    themeName = getSharedThemeFromHtml(htmlContent);
  } catch (error) {
    console.warn('Could not read slide HTML:', error.message);
  }

  // Delete the slide content folder from GitHub
  try {
    await ContentService.deleteFolder({
      orgLogin: gitOrgLogin,
      repo: repoName,
      path: slide.content_path,
      message: `Delete slide: ${slide.title}`,
    });
  } catch (error) {
    console.error('Failed to delete slide content from GitHub:', error);
    // Continue with database deletion even if GitHub fails
  }

  // Delete Cloudinary videos associated with this slide
  // Videos are stored in folder: classmoji/slides/{slideId}/
  const cloudinaryResult = await deleteSlideVideos(slideId);
  if (cloudinaryResult.deleted) {
    console.log(`Cloudinary cleanup completed for slide ${slideId}`);
  }

  // Handle shared theme deletion if requested
  if (themeName && deleteTheme) {
    // Count how many OTHER slides are using this theme (excluding the one being deleted)
    const themeUsage = await countSlidesUsingTheme(gitOrgLogin, slide.term, themeName);
    otherSlidesUsingTheme = themeUsage.slides.filter(s => s.id !== slideId).length;

    if (otherSlidesUsingTheme === 0) {
      try {
        await deleteSharedTheme(gitOrgLogin, slide.term, themeName);
        themeDeleted = true;
      } catch (error) {
        console.error('Failed to delete shared theme:', error);
      }
    }
  }

  // Store classroom_id before deleting
  const classroomId = slide.classroom_id;

  // Delete from database
  await prisma.slide.delete({
    where: { id: slideId },
  });

  // Update the manifest
  try {
    await ClassmojiService.contentManifest.saveManifest(classroomId);
  } catch (error) {
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
 * Get slide info including theme usage for deletion confirmation
 * @param {string} slideId - Slide ID
 * @returns {Promise<{slide: Object, themeName?: string, otherSlidesUsingTheme?: number, slideList?: Array}>}
 */
export async function getSlideDeleteInfo(slideId) {
  const slide = await prisma.slide.findUnique({
    where: { id: slideId },
    include: {
      classroom: {
        include: { git_organization: true },
      },
    },
  });

  if (!slide) {
    throw new Error('Slide not found');
  }

  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    return { slide, themeName: null };
  }

  const gitOrg = slide.classroom.git_organization;
  if (!gitOrg.github_installation_id) {
    return { slide, themeName: null };
  }

  const repoName = `content-${gitOrgLogin}-${slide.term}`;
  const gitProvider = new GitHubProvider(gitOrg.github_installation_id, gitOrgLogin);

  let themeName = null;

  try {
    const octokit = await gitProvider.getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: gitOrgLogin,
      repo: repoName,
      path: `${slide.content_path}/index.html`,
    });

    const htmlContent = Buffer.from(data.content, 'base64').toString('utf-8');
    themeName = getSharedThemeFromHtml(htmlContent);
  } catch (error) {
    console.warn('Could not read slide HTML:', error.message);
  }

  if (!themeName) {
    return { slide, themeName: null };
  }

  // Count other slides using this theme
  const themeUsage = await countSlidesUsingTheme(gitOrgLogin, slide.term, themeName);
  const otherSlides = themeUsage.slides.filter(s => s.id !== slideId);

  return {
    slide,
    themeName,
    otherSlidesUsingTheme: otherSlides.length,
    slideList: otherSlides,
  };
}
