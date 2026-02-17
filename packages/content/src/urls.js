/**
 * URL builders for GitHub Pages content reads
 *
 * Content is served directly from GitHub Pages CDN (Fastly)
 * No authentication required - URLs are public but unlisted
 */

/**
 * Build a GitHub Pages URL for content
 * @param {Object} options
 * @param {string} options.org - GitHub organization login
 * @param {string} options.repo - Repository name
 * @param {string} options.path - Path to file within repo
 * @returns {string} GitHub Pages URL
 */
export function getContentUrl({ org, repo, path }) {
  // GitHub Pages URL format: https://{org}.github.io/{repo}/{path}
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `https://${org}.github.io/${repo}/${cleanPath}`;
}

/**
 * Build a GitHub Pages URL for slide content
 * @param {Object} options
 * @param {string} options.orgLogin - Organization login
 * @param {string} options.term - Term identifier (e.g., "26w")
 * @param {string} options.contentPath - Path within content repo
 * @param {string} [options.filename] - Specific file (default: index.html)
 * @returns {string} GitHub Pages URL for the slide
 */
export function getSlideContentUrl({ orgLogin, term, contentPath, filename = 'index.html' }) {
  const repo = `content-${orgLogin}-${term}`;
  const path = filename ? `${contentPath}/${filename}` : contentPath;
  return getContentUrl({ org: orgLogin, repo, path });
}

/**
 * Build a GitHub raw content URL (alternative to Pages)
 * Useful for fetching during build or when Pages isn't set up
 * @param {Object} options
 * @param {string} options.org - GitHub organization login
 * @param {string} options.repo - Repository name
 * @param {string} options.path - Path to file within repo
 * @param {string} [options.branch] - Branch name (default: main)
 * @returns {string} GitHub raw content URL
 */
export function getRawContentUrl({ org, repo, path, branch = 'main' }) {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `https://raw.githubusercontent.com/${org}/${repo}/${branch}/${cleanPath}`;
}
