/**
 * Content Reference URL Builder
 *
 * Converts structured content references from Ask Moji into clickable URLs.
 *
 * Routes supported:
 * - {pagesUrl}/{classroomSlug}/{pageId} - External pages app URL
 * - {slidesUrl}/{slideId} - External slides URL
 * - https://classmoji.io/{slug} - Platform documentation
 *
 * A null return means NO LINK, and every caller must render text rather than a
 * link when it gets one. Returning a best-effort URL instead would hand a user
 * a confident chip that goes nowhere, which is worse than prose.
 */
import { docsUrl } from '@classmoji/utils';

/**
 * Build a URL for a content reference
 *
 * @param {Object} reference - Content reference from Ask Moji
 * @param {string} reference.referenceType - Type: 'page', 'slides', 'platform_docs'
 * @param {string} reference.contentPath - UUID for page/slides, or doc identifier for platform_docs
 * @param {string} classroomSlug - Classroom slug for URL routing
 * @param {string|null} slidesUrl - External slides URL (e.g., 'https://slides.classmoji.io')
 * @param {string|null} pagesUrl - External pages URL (e.g., 'https://pages.classmoji.com')
 * @returns {string|null} - Full URL or null if can't build
 */
interface ContentReferenceInput {
  referenceType: string;
  contentPath: string;
  displayText?: string;
}

export function buildContentReferenceUrl(
  reference: ContentReferenceInput | null,
  classroomSlug: string | null,
  slidesUrl: string | null = null,
  pagesUrl: string | null = null
) {
  if (!reference || !classroomSlug) return null;

  const { referenceType, contentPath } = reference;
  // This runs in the browser, where there is no process.env: the pages URL
  // arrives from the server in the widget's init payload. Without it a page
  // reference renders as text rather than a guessed link.
  const defaultPagesUrl = pagesUrl || null;

  switch (referenceType) {
    case 'page': {
      // contentPath is the page id from content_search / content_list
      if (!defaultPagesUrl) {
        console.warn('[contentReferenceUrl] pagesUrl not provided for page reference');
        return null;
      }
      return `${defaultPagesUrl}/${classroomSlug}/${contentPath}`;
    }

    case 'slides': {
      // contentPath is the slide UUID from query_available_content
      // Slides use external URL (SLIDES_URL env var)
      if (!slidesUrl) {
        console.warn('[contentReferenceUrl] slidesUrl not provided for slides reference');
        return null;
      }
      return `${slidesUrl}/${contentPath}`;
    }

    case 'platform_docs': {
      // `contentPath` is the SLUG of a `kind: 'doc'` search hit — the page's
      // path under classmoji.io, e.g. `docs/instructors/roster`.
      //
      // This used to build `/docs/${contentPath}`, which was wrong twice over:
      // the origin is the marketing site and not the app, and with a full slug
      // it produced `/docs/docs/instructors/roster`. `docsUrl` comes from
      // `@classmoji/utils` — the SAME function the MCP uses for a hit's `url` —
      // so the link the model cites and the chip the user clicks cannot
      // disagree.
      //
      // It returns null for a malformed slug. That is a SHAPE guard, not an
      // existence check: it blocks traversal and absolute paths, but
      // `docs/instructors/made-up-feature` passes, and so does the
      // `/docs/docs/instructors` typo the corpus itself contains. Only the
      // index knows what exists, and a slug that came from a search hit already
      // does.
      return docsUrl(contentPath);
    }

    // Deprecated: Keep for backwards compatibility with old references
    case 'assignment':
    case 'syllabus': {
      console.warn(
        `[contentReferenceUrl] Deprecated reference type: ${referenceType}, use 'page' instead`
      );
      if (!defaultPagesUrl) return null;
      return `${defaultPagesUrl}/${classroomSlug}?path=${encodeURIComponent(contentPath)}`;
    }

    default:
      console.warn('[contentReferenceUrl] Unknown reference type:', referenceType);
      return null;
  }
}

/**
 * Strip the inline citation markup the model sometimes invents despite being
 * told to cite by plain title. Seen in the wild:
 *   <referenced_content id="…" type="page" title="T">T</referenced_content>
 *   [page:T]
 * Both collapse to the title. Real links come from the reference chips, never
 * from the prose, so nothing is lost.
 */
export function normalizeAssistantText(text: string): string {
  if (!text) return text;
  return text
    .replace(/<referenced_content\b[^>]*>([\s\S]*?)<\/referenced_content>/g, '$1')
    .replace(/<referenced_content\b[^>]*\/>/g, '')
    .replace(/\[(?:page|slide|slides|file):([^\]]+)\]/g, '$1');
}
