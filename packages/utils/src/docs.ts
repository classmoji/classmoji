/**
 * The product documentation's canonical origin and URL shape.
 *
 * ── Why this lives in `@classmoji/utils` and not in either caller ──────────
 * Two places build a link to the same documentation page, and they must not be
 * able to disagree:
 *
 *   - the MCP's `content_search` with `scope: 'docs'`, which puts a `url` on
 *     every hit the model reads;
 *   - the Ask Moji widget in the webapp, which turns a `platform_docs`
 *     reference into the chip a student actually clicks.
 *
 * If those two ever produce different strings for the same slug, the model
 * cites one link and the user is handed another. `@classmoji/utils` has zero
 * dependencies and is already imported by client components, so one definition
 * reaches both — which is why this is NOT an environment variable. A `SITE_URL`
 * would need plumbing into the widget's init payload, a turbo `globalEnv`
 * entry, an Infisical secret and a fallback for when it is missing, and the
 * fallback is the thing that would drift.
 *
 * The docs site is one public origin for the whole fleet. It does not vary by
 * deployment, and a staging build citing a staging docs site would be citing
 * pages that do not exist.
 */

/** Where `classmoji.io/docs` is served from. One origin, fleet-wide. */
export const DOCS_SITE_BASE_URL = 'https://classmoji.io';

/**
 * A documentation slug, as `docs_index` stores it and as search hands it back.
 *
 * `docs`, `docs/instructors`, `docs/instructors/roster`. No leading slash, no
 * `.mdx`, no trailing `/index` — the slug IS the path under the origin above.
 *
 * THIS IS A SHAPE GUARD, NOT AN EXISTENCE CHECK. It blocks traversal
 * (`docs/../admin`), absolute paths and anything outside the docs tree. It says
 * nothing about whether the page is real: `docs/instructors/made-up-feature`
 * passes, and so does the `/docs/docs/instructors` typo that exists in the
 * corpus today. Only the index knows what exists, and a caller that has a hit
 * from the index already knows.
 */
const DOCS_SLUG = /^docs(\/[a-z0-9][a-z0-9-]*)*$/;

export const isDocsSlug = (slug: unknown): slug is string =>
  typeof slug === 'string' && DOCS_SLUG.test(slug);

/**
 * The absolute URL for a documentation slug, or null when the slug is malformed.
 *
 * Returning null rather than a best-effort string is deliberate: the caller's
 * choice is then "render a link" or "render text", and neither of those is a
 * clickable link to nowhere.
 */
export function docsUrl(slug: unknown): string | null {
  if (!isDocsSlug(slug)) return null;
  return `${DOCS_SITE_BASE_URL}/${slug}`;
}
