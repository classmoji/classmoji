/**
 * How wide the class site's article column is, from the page's own width
 * setting. Pure, so the site routes and the unit suite import it directly.
 *
 * The same map the editor route uses, restated rather than imported: that map
 * lives in a client route module and the site's server-rendered pages have no
 * business pulling one in. The two must stay in step — a page authored in a
 * `max-w-5xl` editor and served in a hardcoded `max-w-3xl` article is the same
 * content in a narrower column, which is what made side-by-side blocks (two
 * profile cards, a page directory) wrap on the site and not in the app.
 *
 * A missing or unrecognized width keeps the width the site has always used, so
 * nothing moves for a row this cannot read.
 */
const SITE_WIDTH_CLASSES: Record<number, string> = {
  1: 'max-w-2xl',
  2: 'max-w-4xl',
  3: 'max-w-5xl',
  4: 'max-w-7xl',
};

export function siteArticleWidthClass(width: number | null | undefined): string {
  return (typeof width === 'number' && SITE_WIDTH_CLASSES[width]) || 'max-w-3xl';
}
