/**
 * The handful of environment values the class-site routes need, read in ONE
 * place so no loader has to remember a fallback.
 *
 * Read at call time, never at module load: the dev stack hot-reloads app files
 * without restarting the process, and a module-level snapshot would pin a stale
 * value for the life of the server.
 */

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

/** The Classmoji webapp (sign-in, dashboards, member-only resources). */
export function webappUrl(): string {
  return trimSlash(process.env.WEBAPP_URL || 'http://localhost:3000');
}

/** The canonical pages host (the editor) — also the "Edit page" link target. */
export function pagesUrl(): string {
  return trimSlash(process.env.PAGES_URL || 'http://localhost:7100');
}

/** The slides app (schedule items of type SLIDE link here). */
export function slidesUrl(): string {
  return trimSlash(process.env.SLIDES_URL || 'http://localhost:6500');
}

/** Bare base domain for class sites, or null when the feature is inert. */
export function siteBaseDomain(): string | null {
  const raw = (process.env.SITE_BASE_DOMAIN || '').trim().toLowerCase();
  return raw || null;
}

/**
 * The public origin a site is served from — the base for canonical/og URLs.
 *
 * Scheme and port come from PAGES_URL because that is the same server: in dev
 * that yields `http://cs52.lvh.me:7140`, in prod `https://cs52.classmoji.io`.
 * A canonical URL that silently dropped the dev port would point at nothing,
 * which is exactly the kind of thing that only breaks in production.
 */
export function siteOrigin(subdomain: string): string | null {
  const base = siteBaseDomain();
  if (!base) return null;

  let scheme = 'https';
  let port = '';
  try {
    const parsed = new URL(pagesUrl());
    scheme = parsed.protocol.replace(':', '');
    port = parsed.port ? `:${parsed.port}` : '';
  } catch {
    // Keep the https/no-port default — a malformed PAGES_URL must not 500 a
    // page over a <link rel="canonical">.
  }

  return `${scheme}://${subdomain}.${base}${port}`;
}

/**
 * Origins allowed to frame a site page (`frame-ancestors`).
 *
 * The webapp and the editor host embed site pages in preview panels. Tenant
 * origins are deliberately NOT included: `*.classmoji.io` would let any
 * instructor's site frame any other's, which is the setup for a clickjacking
 * proxy between two courses.
 */
export function frameAncestorOrigins(): string[] {
  const origins = new Set<string>();
  for (const url of [webappUrl(), pagesUrl()]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // Skip a malformed value rather than emitting a broken CSP token.
    }
  }
  return [...origins];
}
