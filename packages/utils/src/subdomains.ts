/**
 * Public course sites: subdomain shape and the two reserved-name registries
 * (browser-safe — no Prisma, no Node built-ins).
 *
 * A course site lives at `{subdomain}.classmoji.io` and addresses its pages as
 * `{subdomain}.classmoji.io/{page slug}`. Those are two separate namespaces
 * with two separate reserved lists, and conflating them is the mistake this
 * module exists to prevent:
 *
 *   RESERVED_SUBDOMAINS  — labels an instructor may not CLAIM, because we
 *                          already serve (or intend to serve) something there.
 *   RESERVED_PAGE_SLUGS  — first path segments inside a live site that belong
 *                          to the platform, not to authored content.
 */

/**
 * One RFC 1123 DNS label: alphanumeric at both ends, hyphens allowed inside,
 * 1-63 characters, lowercase only.
 *
 * Byte-identical to the `classroom_sites_subdomain_check` CHECK constraint in
 * packages/database/migrations/20260821003200_add_classroom_sites/migration.sql
 * — edit one and you MUST edit the other. This one produces a friendly error;
 * the CHECK is what makes it true for writes that never reach this code.
 *
 * Uppercase is rejected rather than tolerated: hostnames are case-insensitive
 * but the unique index on `subdomain` is byte-comparing, so `CS52` and `cs52`
 * would be two rows for one site. Normalize first (see normalizeSubdomain).
 */
export const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Trim and lowercase. Everything else about the label — length, character set,
 * hyphen placement — is a validation question, not a normalization one: silently
 * repairing a typo'd subdomain would hand the instructor an address they did not
 * ask for and cannot predict.
 */
export function normalizeSubdomain(input: string | null | undefined): string {
  return String(input ?? '')
    .trim()
    .toLowerCase();
}

/** Does this string, as given, satisfy SUBDOMAIN_REGEX? Does not normalize. */
export function isValidSubdomain(subdomain: string | null | undefined): boolean {
  return typeof subdomain === 'string' && SUBDOMAIN_REGEX.test(subdomain);
}

/**
 * DNS labels no classroom may claim.
 *
 * Three kinds, deliberately in one list because the failure is the same
 * whichever kind gets claimed — a request that should have reached the platform
 * reaches a course site instead:
 *   - live or planned Classmoji hosts (app, www, slides, pages, mcp, api, docs,
 *     demo, staging, dev, site, sites, test)
 *   - infrastructure conventions attackers and mail providers assume exist
 *     (mail, admin, auth, login, assets, cdn, static, status)
 *   - the brand and its support surfaces (classmoji, help, support, blog, about)
 *
 * NOT enforced by a CHECK constraint: this is product policy that grows every
 * time we add a host, and a DB constraint would mean a migration each time.
 * Existing rows are never retroactively evicted by an addition here — that
 * needs a migration.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'app',
  'www',
  'slides',
  'pages',
  'mcp',
  'api',
  'docs',
  'demo',
  'staging',
  'dev',
  'mail',
  'admin',
  'auth',
  'login',
  'assets',
  'cdn',
  'static',
  'status',
  'help',
  'support',
  'blog',
  'about',
  'classmoji',
  'site',
  'sites',
  'test',
]);

/**
 * THE authoritative registry of first path segments reserved inside a live
 * course site — a page whose slug is one of these could never be reached,
 * because the platform answers that path first.
 *
 * Two other places must agree with this set and cannot import it:
 *   - packages/database/migrations/20260821003300_page_slug_backfill_and_unique/migration.sql
 *     re-lists it (SQL has no imports) to evict pages already squatting on one.
 *   - the site route table, which is what actually claims these paths.
 * page.service's create() DOES import it, so new pages can never land here.
 *
 * `robots.txt` cannot currently be produced by titleToIdentifier (the dot is
 * stripped) and is listed anyway: the registry describes the URL namespace, not
 * the slug generator, and the generator is free to change.
 */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  'app',
  'classmoji',
  'sign-in',
  'schedule',
  'robots.txt',
]);

/** Is this label one we refuse to hand out? Expects an already-normalized label. */
export function isReservedSubdomain(subdomain: string | null | undefined): boolean {
  return RESERVED_SUBDOMAINS.has(String(subdomain ?? ''));
}

/** Is this page slug a platform-owned path inside a course site? */
export function isReservedPageSlug(slug: string | null | undefined): boolean {
  return RESERVED_PAGE_SLUGS.has(String(slug ?? ''));
}
