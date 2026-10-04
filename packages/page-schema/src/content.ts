/**
 * The `content.json` wrapper, serialized exactly as `savePageContent`
 * (packages/services/src/classmoji/pageContent.service.ts) writes it:
 * `{ blocks, coverImage? }`, two-space indent, no trailing newline, and no
 * `coverImage` key at all when there is no cover.
 */

export interface PageCoverImage {
  url: string;
  position: number;
}

export interface PageContent<Block = unknown> {
  blocks: Block[];
  coverImage?: PageCoverImage | null;
}

export function serializePageContent(content: PageContent): string {
  const wrapper: { blocks: unknown; coverImage?: PageCoverImage } = { blocks: content.blocks };
  if (content.coverImage != null) wrapper.coverImage = content.coverImage;
  return JSON.stringify(wrapper, null, 2);
}

/**
 * Parse a stored `content.json`: the `{ blocks, coverImage? }` wrapper, or the
 * older bare block array (read the same way `loadPageContent` does).
 */
export function parsePageContent(text: string): PageContent {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return { blocks: parsed, coverImage: null };
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as PageContent).blocks)) {
    const { blocks, coverImage } = parsed as PageContent;
    return { blocks, coverImage: coverImage || null };
  }
  throw new Error('content.json is neither a block array nor a { blocks } wrapper');
}
