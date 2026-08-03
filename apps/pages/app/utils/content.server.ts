import { ClassmojiService } from './db.server.ts';
import type { PageForContent } from '~/types/pages.ts';

/**
 * Thin wrappers around the shared page-content service
 * (packages/services/src/classmoji/pageContent.service.ts).
 *
 * What stays app-local here:
 * - the migrateHtmlToBlockNote fallback in savePageCoverImage (needs the
 *   React editor schema, which must not leak into packages/services),
 * - the Web API File → Buffer adapter for uploads,
 * - extractBodyContent (used by the HTML→BlockNote migration).
 */

interface CoverImage {
  url: string;
  position: number;
}

interface PageContentResult {
  format: 'json' | 'html' | 'none';
  content: unknown;
  coverImage: CoverImage | null;
}

/**
 * Load page content from GitHub.
 * Tries JSON first (BlockNote format), falls back to HTML (legacy).
 * Preserves this app's historical { format, content, coverImage } shape
 * (the service returns the blocks under `blocks`, plus the file sha).
 */
export async function loadPageContent(page: PageForContent): Promise<PageContentResult> {
  const { format, blocks, coverImage } = await ClassmojiService.pageContent.loadPageContent(page);
  return { format, content: blocks, coverImage };
}

/**
 * Save BlockNote JSON content to GitHub (wrapper format { blocks, coverImage? }).
 * When coverImage is not provided, the service preserves the existing one.
 * Does NOT delete the legacy index.html — keeps for backward compatibility.
 */
export async function savePageContent(
  page: PageForContent,
  blocks: unknown,
  coverImage: CoverImage | null | undefined = undefined
): Promise<void> {
  await ClassmojiService.pageContent.savePageContent(page, blocks, { coverImage });
}

/**
 * Save only the cover image metadata to content.json without requiring editor
 * blocks. Loads the current content, migrating legacy HTML to BlockNote JSON
 * so it isn't lost when content.json is first created.
 */
export async function savePageCoverImage(
  page: PageForContent,
  coverImage: CoverImage | null
): Promise<void> {
  const { format, content } = await loadPageContent(page);

  let currentBlocks: unknown;
  if (format === 'json') {
    currentBlocks = content;
  } else if (format === 'html') {
    // Migrate HTML content so we don't lose it when creating content.json
    const { migrateHtmlToBlockNote } = await import('./migration.server.ts');
    const { schema } = await import('~/components/editor/blocks/index.tsx');
    currentBlocks = await migrateHtmlToBlockNote(content as string, schema);
  } else {
    currentBlocks = [{ type: 'paragraph', content: [] }];
  }

  await savePageContent(page, currentBlocks, coverImage);
}

/**
 * Upload a file to the page's assets folder on GitHub.
 * Converts the Web API File to a Node.js Buffer for the service.
 */
export async function uploadPageAsset(
  page: PageForContent,
  file: File
): Promise<{ url: string; path: string }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return ClassmojiService.pageContent.uploadPageAsset(page, buffer, file.name);
}

/**
 * Extract body content from a full HTML document.
 * Strips html/head/body tags and any title/subtitle.
 */
export function extractBodyContent(html: string): string {
  if (!html) return '';

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return html;

  let content = bodyMatch[1].trim();

  // Remove title and subtitle (first h1 and p.subtitle) — these are in the page DB model
  content = content.replace(/<h1[^>]*>.*?<\/h1>/i, '');
  content = content.replace(/<p class="subtitle"[^>]*>.*?<\/p>/i, '');

  return content.trim();
}
