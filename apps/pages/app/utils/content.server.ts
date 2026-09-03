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
  /**
   * Git blob sha of the file the content came from (content.json for 'json',
   * index.html for 'html', null for 'none'). Only the 'json' sha may be used
   * as an expectedSha for saves — saves write content.json, never index.html.
   */
  sha: string | null;
}

/**
 * Load page content from GitHub.
 * Tries JSON first (BlockNote format), falls back to HTML (legacy).
 * Preserves this app's historical { format, content, coverImage } shape
 * (the service returns the blocks under `blocks`), plus the file sha for
 * conflict tokens.
 *
 * @param options.ref - Git ref to read from (e.g. the page's preview branch).
 * @param options.skipCache - Bypass the 60s ContentService cache (sha-bearing
 *   reads that seed an expectedSha MUST pass true).
 */
export async function loadPageContent(
  page: PageForContent,
  options: { ref?: string; skipCache?: boolean } = {}
): Promise<PageContentResult> {
  const { format, blocks, coverImage, sha } = await ClassmojiService.pageContent.loadPageContent(
    page,
    options
  );
  return { format, content: blocks, coverImage, sha };
}

/**
 * Save BlockNote JSON content to GitHub (wrapper format { blocks, coverImage? }).
 * When coverImage is not provided, the service preserves the existing one.
 * Does NOT delete the legacy index.html — keeps for backward compatibility.
 *
 * @param options.expectedSha - Optimistic-lock sha of content.json; a
 *   concurrent write throws an error with status 409 instead of clobbering.
 * @returns The new content.json sha (the caller's next conflict token) and
 *   commit sha.
 */
export async function savePageContent(
  page: PageForContent,
  blocks: unknown,
  options: { coverImage?: CoverImage | null; expectedSha?: string } = {}
): Promise<{ sha: string; commit: string }> {
  return ClassmojiService.pageContent.savePageContent(page, blocks, options);
}

/**
 * Save only the cover image metadata to content.json without requiring editor
 * blocks. Loads the current content, migrating legacy HTML to BlockNote JSON
 * so it isn't lost when content.json is first created.
 *
 * F5: this is a read-modify-write of the whole file — the read bypasses the
 * 60s cache and the write is CAS'd on the read's sha, so a cover-image change
 * can never revert content edits that landed in between (throws status 409
 * instead; callers surface "page changed — try again").
 */
export async function savePageCoverImage(
  page: PageForContent,
  coverImage: CoverImage | null
): Promise<{ sha: string }> {
  const { format, content, sha } = await loadPageContent(page, { skipCache: true });

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

  const result = await savePageContent(page, currentBlocks, {
    coverImage,
    // Only content.json's own sha is a valid precondition — the 'html'
    // fallback sha belongs to index.html, a different file than this write.
    ...(format === 'json' && sha ? { expectedSha: sha } : {}),
  });
  // Returned so the editor can refresh its conflict token — a cover write
  // advances content.json's sha, and a save carrying the pre-cover token
  // would otherwise self-conflict.
  return { sha: result.sha };
}

/**
 * Upload a file to the page's assets folder on GitHub.
 * Converts the Web API File to a Node.js Buffer for the service.
 *
 * `url` and `path` are both the repo path — the reference to STORE. `displayUrl`
 * is the signed URL to show it with right now, and is null when the delivery
 * layer is not configured.
 */
export async function uploadPageAsset(
  page: PageForContent,
  file: File
): Promise<{ url: string; path: string; displayUrl: string | null }> {
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
