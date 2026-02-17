/**
 * Content Reference URL Builder
 *
 * Converts structured content references from the syllabus bot
 * into clickable URLs.
 *
 * Routes supported:
 * - {pagesUrl}/{classroomSlug}/{pageId} - External pages app URL
 * - {slidesUrl}/{slideId} - External slides URL
 * - /docs/{contentPath} - Platform documentation
 */

/**
 * Build a URL for a content reference
 *
 * @param {Object} reference - Content reference from syllabus bot
 * @param {string} reference.referenceType - Type: 'page', 'slides', 'platform_docs'
 * @param {string} reference.contentPath - UUID for page/slides, or doc identifier for platform_docs
 * @param {string} classroomSlug - Classroom slug for URL routing
 * @param {string|null} slidesUrl - External slides URL (e.g., 'https://slides.classmoji.io')
 * @param {string|null} pagesUrl - External pages URL (e.g., 'https://pages.classmoji.com')
 * @returns {string|null} - Full URL or null if can't build
 */
export function buildContentReferenceUrl(reference, classroomSlug, slidesUrl = null, pagesUrl = null) {
  if (!reference || !classroomSlug) return null;

  const { referenceType, contentPath } = reference;
  const defaultPagesUrl = pagesUrl || process.env.PAGES_URL || 'http://localhost:7100';

  switch (referenceType) {
    case 'page': {
      // contentPath is the page UUID from query_available_content
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
      // contentPath is a doc identifier like "quizzes", "assignments", "getting-started"
      return `/docs/${contentPath}`;
    }

    // Deprecated: Keep for backwards compatibility with old references
    case 'assignment':
    case 'syllabus': {
      console.warn(`[contentReferenceUrl] Deprecated reference type: ${referenceType}, use 'page' instead`);
      return `${defaultPagesUrl}/${classroomSlug}?path=${encodeURIComponent(contentPath)}`;
    }

    default:
      console.warn('[contentReferenceUrl] Unknown reference type:', referenceType);
      return null;
  }
}

/**
 * Render a content reference as a markdown link
 *
 * @param {Object} reference - Content reference from syllabus bot
 * @param {string} classroomSlug - Classroom slug for URL routing
 * @param {string|null} slidesUrl - External slides URL
 * @returns {string} - Markdown link or plain text
 */
export function renderContentReferenceMarkdown(reference, classroomSlug, slidesUrl = null) {
  const url = buildContentReferenceUrl(reference, classroomSlug, slidesUrl);

  if (!url) {
    return reference.displayText || reference.contentPath;
  }

  return `[${reference.displayText}](${url})`;
}

/**
 * Process bot response text to replace content reference JSON with links
 *
 * @param {string} text - Bot response text (may contain JSON content references)
 * @param {Array} references - Parsed content references
 * @param {string} classroomSlug - Classroom slug for URL routing
 * @returns {string} - Text with references replaced by markdown links
 */
export function processResponseReferences(text, references, classroomSlug) {
  if (!references || references.length === 0) return text;

  let processedText = text;

  // Remove JSON content reference objects from the text
  // They appear as: {"type":"content_reference",...}
  const jsonRegex = /\{\"type\":\s*\"content_reference\"[^}]+\}/g;
  processedText = processedText.replace(jsonRegex, '').trim();

  // References are usually rendered separately in the UI,
  // so we just clean up the response text here

  return processedText;
}
