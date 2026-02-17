import { ContentService } from '@classmoji/content';
import { generateTermString } from '@classmoji/utils';

/**
 * Get the content repo name for a page's classroom.
 */
function getRepoName(page) {
  const gitOrg = page.classroom.git_organization;
  const term = generateTermString(page.classroom.term, page.classroom.year);
  return `content-${gitOrg.login}-${term}`;
}

/**
 * Load page content from GitHub.
 * Tries JSON first (BlockNote format), falls back to HTML (legacy).
 *
 * @param {Object} page - Page with classroom.git_organization
 * @returns {{ format: 'json'|'html'|'none', content: Object|string|null, coverImage: { url: string, position: number }|null }}
 */
export async function loadPageContent(page) {
  const gitOrg = page.classroom.git_organization;
  const repo = getRepoName(page);

  // Try JSON first (BlockNote format)
  try {
    const jsonResult = await ContentService.getContent({
      gitOrganization: gitOrg,
      repo,
      path: `${page.content_path}/content.json`,
    });

    if (jsonResult?.content) {
      const parsed = JSON.parse(jsonResult.content);

      // New format: { coverImage?, blocks } wrapper
      if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.blocks)) {
        return {
          format: 'json',
          content: parsed.blocks,
          coverImage: parsed.coverImage || null,
        };
      }

      // Old format: bare blocks array
      return {
        format: 'json',
        content: parsed,
        coverImage: null,
      };
    }
  } catch {
    // JSON not found, try HTML
  }

  // Fallback: HTML (legacy format)
  try {
    const htmlResult = await ContentService.getContent({
      gitOrganization: gitOrg,
      repo,
      path: `${page.content_path}/index.html`,
    });

    if (htmlResult?.content) {
      return {
        format: 'html',
        content: htmlResult.content,
        coverImage: null,
      };
    }
  } catch {
    // HTML not found either
  }

  return { format: 'none', content: null, coverImage: null };
}

/**
 * Save BlockNote JSON content to GitHub.
 * Uses the new wrapper format: { coverImage?, blocks }.
 * When coverImage is not provided, preserves the existing coverImage from the JSON file.
 * Does NOT delete the legacy index.html — keeps for backward compatibility.
 *
 * @param {Object} page - Page with classroom.git_organization
 * @param {Array} blocks - BlockNote document blocks array
 * @param {{ url: string, position: number }|null} [coverImage] - Cover image metadata; omit to preserve existing
 */
export async function savePageContent(page, blocks, coverImage = undefined) {
  const gitOrg = page.classroom.git_organization;
  const repo = getRepoName(page);
  const path = `${page.content_path}/content.json`;

  // When coverImage isn't explicitly provided, read the existing JSON to preserve it
  if (coverImage === undefined) {
    try {
      const existing = await ContentService.getContent({
        gitOrganization: gitOrg,
        repo,
        path,
      });
      if (existing?.content) {
        const parsed = JSON.parse(existing.content);
        if (parsed && !Array.isArray(parsed) && parsed.coverImage) {
          coverImage = parsed.coverImage;
        }
      }
    } catch {
      // No existing file — coverImage stays undefined (won't be in wrapper)
    }
  }

  const wrapper = { blocks };
  if (coverImage !== undefined) {
    wrapper.coverImage = coverImage;
  }

  await ContentService.put({
    gitOrganization: gitOrg,
    repo,
    path,
    content: JSON.stringify(wrapper, null, 2),
    message: `Update page: ${page.title}`,
  });
}

/**
 * Save only the cover image metadata to content.json without requiring editor blocks.
 * Loads the current JSON, updates the coverImage field, and saves back.
 *
 * @param {Object} page - Page with classroom.git_organization
 * @param {{ url: string, position: number }|null} coverImage - Cover image metadata, or null to remove
 */
export async function savePageCoverImage(page, coverImage) {
  const { format, content, coverImage: existingCover } = await loadPageContent(page);

  let currentBlocks;
  if (format === 'json') {
    currentBlocks = content;
  } else if (format === 'html') {
    // Migrate HTML content so we don't lose it when creating content.json
    const { migrateHtmlToBlockNote } = await import('./migration.server.js');
    const { schema } = await import('~/components/editor/blocks/index.jsx');
    currentBlocks = await migrateHtmlToBlockNote(content, schema);
  } else {
    currentBlocks = [{ type: 'paragraph', content: [] }];
  }

  await savePageContent(page, currentBlocks, coverImage);
}

/**
 * Upload a file to the page's assets folder on GitHub.
 *
 * Converts Web API File to Node.js Buffer for ContentService compatibility.
 *
 * @param {Object} page - Page with classroom.git_organization
 * @param {File} file - Web API File from formData
 * @returns {{ url: string, path: string }}
 */
export async function uploadPageAsset(page, file) {
  const gitOrg = page.classroom.git_organization;
  const repo = getRepoName(page);
  const assetsFolder = `${page.content_path}/assets`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await ContentService.upload({
    gitOrganization: gitOrg,
    repo,
    folder: assetsFolder,
    file: buffer,
    filename: file.name,
    branch: 'main',
    message: `Upload asset for ${page.title || 'page'}`,
  });

  return { url: result.url, path: result.path };
}

/**
 * Extract body content from a full HTML document.
 * Strips html/head/body tags and any title/subtitle.
 */
export function extractBodyContent(html) {
  if (!html) return '';

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return html;

  let content = bodyMatch[1].trim();

  // Remove title and subtitle (first h1 and p.subtitle) — these are in the page DB model
  content = content.replace(/<h1[^>]*>.*?<\/h1>/i, '');
  content = content.replace(/<p class="subtitle"[^>]*>.*?<\/p>/i, '');

  return content.trim();
}
