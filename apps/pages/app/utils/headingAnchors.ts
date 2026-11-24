/**
 * The `#fragment` ids a page's headings get, one rule for every surface.
 *
 * The class site's static render stamps them on its h1-h3 after serializing
 * (`addHeadingAnchors` in `site/render.server.ts`), and the shared reader puts
 * the same ids on its headings with a ProseMirror decoration
 * (`components/viewer/headingAnchors.ts`). A link someone copied from one
 * surface must land on the same heading on the other, so both read the slug
 * and the duplicate rule from here.
 *
 * Pure and dependency-free: the server render, the browser and the unit suite
 * all import it.
 */

/** Slugify heading text into a stable, URL-safe fragment id. */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/&[a-z]+;/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

/** The heading levels that get an id (the site's `h1, h2, h3`). */
export const ANCHORED_HEADING_LEVELS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * Hands out ids in document order: the slug of the heading's text, and for a
 * repeat `-2`, `-3`, … (two "Grading" headings do not collide). A heading with
 * no text gets no id and uses up no slug.
 *
 * One allocator per document, so the numbering restarts for every render.
 */
export function createHeadingIdAllocator(): (text: string) => string | null {
  const used = new Map<string, number>();
  return (raw: string) => {
    const text = raw.trim();
    if (!text) return null;
    const base = slugifyHeading(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
}

/**
 * The element `location.hash` names, if any. Read-only lookup; the caller
 * scrolls. A hash that is not a valid id (or not URI-encoded) finds nothing.
 */
export function hashTarget(hash: string, root: Document = document): HTMLElement | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep it as typed.
  }
  return root.getElementById(id);
}
