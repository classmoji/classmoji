/**
 * Theme Service
 *
 * Manages shared slide themes stored in `.slidesthemes/` in the content repository.
 * Allows reusing theme CSS/fonts across multiple slide presentations.
 */

import { ContentService } from '@classmoji/content';
import { GitHubProvider } from '@classmoji/services';
import prisma from '@classmoji/database';

const THEMES_FOLDER = '.slidesthemes';

/**
 * Get the base URL for content using our internal proxy
 * Uses the content proxy route which fetches from GitHub Pages (with API fallback)
 * and serves with correct MIME types.
 *
 * @param {string} org - Organization login
 * @param {string} repoName - Repository name
 * @returns {string} Base URL path (relative to slides service origin)
 */
function getBaseUrl(org, repoName) {
  // Return relative URL - will be resolved against slides service origin
  return `/content/${org}/${repoName}`;
}

/**
 * List all saved themes for an organization
 * @param {string} org - Organization login
 * @param {string} repoName - Content repository name
 * @returns {Promise<Array<{name: string, bodyClasses: string}>>}
 */
export async function listSavedThemes(org, repoName) {

  try {
    // Get git organization to access installation ID
    // Query by provider + login since login alone is not unique
    const gitOrg = await prisma.gitOrganization.findFirst({
      where: { provider: 'GITHUB', login: org },
    });

    if (!gitOrg || !gitOrg.github_installation_id) {
      console.warn(`Git organization not found or missing installation ID: ${org}`);
      return [];
    }

    // Create GitHub provider instance
    const gitProvider = new GitHubProvider(gitOrg.github_installation_id, org);

    const repoExists = await gitProvider.repositoryExists(org, repoName);
    if (!repoExists) return [];

    const octokit = await gitProvider.getOctokit();

    let contents;
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: org,
        repo: repoName,
        path: THEMES_FOLDER,
      });
      contents = Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }

    // Get theme.json from each theme folder
    const themes = [];
    for (const item of contents) {
      if (item.type === 'dir') {
        try {
          const { data: manifestData } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: org,
            repo: repoName,
            path: `${THEMES_FOLDER}/${item.name}/theme.json`,
          });

          const manifest = JSON.parse(Buffer.from(manifestData.content, 'base64').toString('utf-8'));
          themes.push({
            name: item.name,
            bodyClasses: manifest.bodyClasses || '',
          });
        } catch (error) {
          // Skip themes without valid manifest
          console.warn(`Skipping theme ${item.name}: ${error.message}`);
        }
      }
    }

    return themes.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error('Error listing themes:', error);
    return [];
  }
}

/**
 * Save a theme to the shared themes folder
 * @param {Object} options
 * @param {string} options.org - Organization login
 * @param {string} options.repoName - Content repository name
 * @param {string} options.themeName - Theme folder name (slug)
 * @param {string} options.bodyClasses - Body classes for the theme
 * @param {string} [options.customThemeCss] - Custom theme CSS content
 * @param {Array<{path: string, content: string, encoding: string}>} options.libFiles - Lib folder files
 * @returns {Promise<{themePath: string, filesUploaded: number}>}
 */
export async function saveTheme({
  org,
  repoName,
  themeName,
  bodyClasses,
  customThemeCss,
  libFiles,
  onProgress,
}) {
  const themePath = `${THEMES_FOLDER}/${themeName}`;

  // Minimal manifest - just store body classes
  const manifest = { bodyClasses };

  // Collect all files to upload
  const files = [
    {
      path: `${themePath}/theme.json`,
      content: JSON.stringify(manifest, null, 2),
      encoding: 'utf-8',
    },
    // Lib files go under theme folder
    ...libFiles.map(file => ({
      path: `${themePath}/${file.path}`,
      content: file.content,
      encoding: file.encoding,
    })),
  ];

  // Add custom theme CSS if present
  if (customThemeCss?.trim()) {
    files.push({
      path: `${themePath}/custom-theme.css`,
      content: customThemeCss,
      encoding: 'utf-8',
    });
  }

  const result = await ContentService.uploadBatch({
    orgLogin: org,
    repo: repoName,
    files,
    message: `Save shared theme: ${themeName}`,
    onProgress,
  });

  return {
    themePath,
    filesUploaded: result.filesUploaded,
  };
}

/**
 * Get theme URLs for use in slide HTML
 * @param {string} org - Organization login
 * @param {string} repoName - Content repository name
 * @param {string} themeName - Theme folder name
 * @returns {Promise<{libCssUrl: string, customThemeUrl: string | null, bodyClasses: string}>}
 */
export async function getThemeUrls(org, repoName, themeName) {
  const baseUrl = getBaseUrl(org, repoName);
  const themePath = `${THEMES_FOLDER}/${themeName}`;

  // Get git organization to access installation ID
  // Query by provider + login since login alone is not unique
  const gitOrg = await prisma.gitOrganization.findFirst({
    where: { provider: 'GITHUB', login: org },
  });

  if (!gitOrg || !gitOrg.github_installation_id) {
    throw new Error(`Git organization not found or missing installation ID: ${org}`);
  }

  // Create GitHub provider instance
  const gitProvider = new GitHubProvider(gitOrg.github_installation_id, org);
  const octokit = await gitProvider.getOctokit();

  // Get manifest for body classes
  const { data: manifestData } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: org,
    repo: repoName,
    path: `${themePath}/theme.json`,
  });
  const manifest = JSON.parse(Buffer.from(manifestData.content, 'base64').toString('utf-8'));

  // Check which lib CSS exists (prefer v2)
  let libCssFile = 'lib/offline-v2.css';
  try {
    await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: org,
      repo: repoName,
      path: `${themePath}/lib/offline-v2.css`,
    });
  } catch {
    libCssFile = 'lib/offline-v1.css';
  }

  // Check if custom theme exists
  let customThemeUrl = null;
  try {
    await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: org,
      repo: repoName,
      path: `${themePath}/custom-theme.css`,
    });
    customThemeUrl = `${baseUrl}/${themePath}/custom-theme.css`;
  } catch {
    // No custom theme
  }

  return {
    libCssUrl: `${baseUrl}/${themePath}/${libCssFile}`,
    customThemeUrl,
    bodyClasses: manifest.bodyClasses,
  };
}

/**
 * Check if a theme name already exists
 * @param {string} org - Organization login
 * @param {string} repoName - Content repository name
 * @param {string} themeName - Theme name to check
 * @returns {Promise<boolean>}
 */
export async function themeExists(org, repoName, themeName) {
  const themes = await listSavedThemes(org, repoName);
  return themes.some(t => t.name === themeName);
}

/**
 * Generate a slug from a display name
 */
export function generateThemeSlug(displayName) {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
