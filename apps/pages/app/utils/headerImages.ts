/**
 * Header images on a page LIST.
 *
 * `pages.header_image_url` is a legacy DB column — the cover moved into
 * `content.json` for the page itself, but the column is still what the list
 * views render a thumbnail from, and it holds a stored reference exactly like
 * any block does. Rendering it straight from the row asks the browser to fetch
 * `pages/lab-1/assets/hero.png` relative to the pages origin, which is a 404 the
 * moment a classroom is on the delivery layer.
 *
 * Pure and dependency-free on purpose: the tier decision and the resolve belong
 * to the loader, and what lives here is the collect-and-swap, which is the part
 * worth testing without a database.
 */

/** The row shape a list renders a thumbnail from. */
export type PageWithHeaderImage = { header_image_url?: string | null };

/** Every header image reference in a list, duplicates removed. */
export function headerImageRefs(pages: readonly PageWithHeaderImage[]): string[] {
  const refs = new Set<string>();
  for (const page of pages) {
    const ref = page.header_image_url;
    if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
  }
  return [...refs];
}

/**
 * The same list with every header image swapped for its resolved URL.
 *
 * A miss leaves the stored reference in place — the correct answer for an
 * external image, for a `data:` URI, and for a classroom the delivery layer is
 * switched off for. Rows with no change are returned by identity, so a list of
 * pages with no thumbnails costs no allocation.
 */
export function withResolvedHeaderImages<T extends PageWithHeaderImage>(
  pages: readonly T[],
  resolved: ReadonlyMap<string, string>
): T[] {
  return pages.map(page => {
    const ref = page.header_image_url;
    if (typeof ref !== 'string' || ref.length === 0) return page;
    const url = resolved.get(ref);
    return url === undefined || url === ref ? page : { ...page, header_image_url: url };
  });
}
