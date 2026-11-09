/**
 * Theme Service
 *
 * Resolves the URLs of a shared slide theme stored as a folder in
 * `.slidesthemes/<name>/` of the content repository (`theme.json`, `lib/`
 * CSS, optional `custom-theme.css`). Those folders were written by the former
 * slides.com importer; decks that reference one (`data-theme="shared:<name>"`)
 * still render through `getThemeUrls`.
 */

import { ContentService } from '@classmoji/content';

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
function getBaseUrl(org: string, repoName: string): string {
  // Return relative URL - will be resolved against slides service origin
  return `/content/${org}/${repoName}`;
}

/**
 * Get theme URLs for use in slide HTML
 * @param {string} org - Organization login
 * @param {string} repoName - Content repository name
 * @param {string} themeName - Theme folder name
 * @returns {Promise<{libCssUrl: string, customThemeUrl: string | null, bodyClasses: string}>}
 */
export async function getThemeUrls(org: string, repoName: string, themeName: string) {
  const baseUrl = getBaseUrl(org, repoName);
  const themePath = `${THEMES_FOLDER}/${themeName}`;

  // Get manifest for body classes
  const manifestFile = await ContentService.getContent({
    orgLogin: org,
    repo: repoName,
    path: `${themePath}/theme.json`,
  });
  if (!manifestFile) {
    throw new Error(`Theme not found: ${themeName}`);
  }
  const manifest = JSON.parse(manifestFile.content);

  // Check which lib CSS exists (prefer v2)
  const hasV2 = await ContentService.getMeta({
    orgLogin: org,
    repo: repoName,
    path: `${themePath}/lib/offline-v2.css`,
  });
  const libCssFile = hasV2 ? 'lib/offline-v2.css' : 'lib/offline-v1.css';

  // Check if custom theme exists
  const hasCustom = await ContentService.getMeta({
    orgLogin: org,
    repo: repoName,
    path: `${themePath}/custom-theme.css`,
  });
  const customThemeUrl: string | null = hasCustom
    ? `${baseUrl}/${themePath}/custom-theme.css`
    : null;

  return {
    libCssUrl: `${baseUrl}/${themePath}/${libCssFile}`,
    customThemeUrl,
    bodyClasses: manifest.bodyClasses,
  };
}
