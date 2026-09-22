/**
 * The browser-facing origins a class site answers on, and the public URL a form
 * should be shared as.
 *
 * These started in `apps/pages` (`app/site/env.server.ts`, `app/site/tenant.server.ts`,
 * `app/forms/admin/adminLinks.server.ts`) and moved here when the webapp grew a
 * forms list of its own. The webapp must not import from another app, and the
 * link staff copy has to be the SAME link whichever list they copied it from —
 * a second implementation of "which hostname does this course call its own"
 * would drift the moment one of them learned about custom domains. apps/pages
 * re-exports these under their old names, so nothing there had to change.
 *
 * Every value is read from the environment at CALL time, never at module load:
 * the dev stack hot-reloads app files without restarting the process, and a
 * module-level snapshot would pin a stale value for the life of the server.
 */

import * as siteService from './site.service.ts';
import * as subscriptionService from './subscription.service.ts';
import type { SiteWithClassroom } from './site.service.ts';

/** The canonical pages host (the editor, and the canonical forms path). */
function pagesUrl(): string {
  return (process.env.PAGES_URL || 'http://localhost:7100').replace(/\/+$/, '');
}

/** Bare base domain for class sites, or null when the feature is inert. */
export function siteBaseDomain(): string | null {
  const raw = (process.env.SITE_BASE_DOMAIN || '').trim().toLowerCase();
  return raw || null;
}

/** Scheme and port for every site URL we mint, read off PAGES_URL. */
function schemeAndPort(): { scheme: string; port: string } {
  try {
    const parsed = new URL(pagesUrl());
    return {
      scheme: parsed.protocol.replace(':', ''),
      port: parsed.port ? `:${parsed.port}` : '',
    };
  } catch {
    // Keep the https/no-port default — a malformed PAGES_URL must not 500 a
    // page over a <link rel="canonical">.
    return { scheme: 'https', port: '' };
  }
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

  const { scheme, port } = schemeAndPort();
  return `${scheme}://${subdomain}.${base}${port}`;
}

/**
 * The public origin of an instructor-owned hostname.
 *
 * Separate from `siteOrigin` rather than an optional argument, because the two
 * take different inputs and one of them is dangerous to get wrong: this takes
 * the STORED `custom_domain`, never the inbound `Host` header. Building a
 * canonical URL or a redirect target out of the request's own Host is how a
 * `<link rel="canonical">` ends up naming whatever an attacker typed — on a
 * response that is shared-cacheable for sixty seconds.
 *
 * Scheme and port still come from PAGES_URL so a dev environment yields
 * something reachable, exactly as `siteOrigin` does.
 */
export function customDomainOrigin(domain: string): string {
  const { scheme, port } = schemeAndPort();
  return `${scheme}://${domain}${port}`;
}

/** Everything the canonical-hostname decision depends on. */
export type SeoOriginInput = {
  /** Origin of the canonical `{subdomain}.{SITE_BASE_DOMAIN}` host. */
  subdomainOrigin: string | null;
  /** The stored claim — never the inbound Host header. */
  customDomain: string | null;
  /** Has this claim served over its own hostname? */
  verified: boolean;
  /** Is the classroom's subscription active right now? */
  proActive: boolean;
  /** Is THIS request being served on the custom domain? */
  servingOnCustomDomain: boolean;
};

/**
 * Which hostname should `rel=canonical` and `og:url` name?
 *
 * Pulled out as a pure function because it is one decision that has to come out
 * the same in two places. If the custom host said "I am canonical" while the
 * subdomain also said "I am canonical", the two hostnames would be competing
 * copies of the same course — the duplicate-content split the flip exists to
 * prevent. Worse in the lapsed case: the custom host is 302ing visitors to the
 * subdomain, so a subdomain canonical pointing back at it would name a URL that
 * redirects away.
 *
 * Serving ON the custom domain is itself the verification — the request only
 * exists because a certificate for that hostname completed a handshake — so
 * that case does not wait for the stamp it is in the middle of writing.
 */
export function seoOriginFor(input: SeoOriginInput): string | null {
  const { subdomainOrigin, customDomain, verified, proActive, servingOnCustomDomain } = input;

  if (!customDomain || !proActive) return subdomainOrigin;
  if (servingOnCustomDomain || verified) return customDomainOrigin(customDomain);
  return subdomainOrigin;
}

/**
 * Which hostname does a site call its own, asked from anywhere but the custom
 * domain itself?
 *
 * The custom domain, once it is verified and the classroom is actually on PRO —
 * otherwise the two hostnames would disagree about which of them is canonical,
 * which is the duplicate-content split the flip exists to prevent. The lapsed
 * case matters most: the custom host is 302ing visitors here, so pointing
 * `rel=canonical` back at it would name a URL that redirects away.
 *
 * The subscription lookup runs ONLY for the handful of sites that have a domain
 * to flip to — the overwhelmingly common request reads `custom_domain === null`
 * and does no extra work at all.
 *
 * Two askers: the site's own `rel=canonical`, and the forms admin's copied link
 * (`publicFormUrlFor`) — a form shared on a course should be shared on the
 * address that course claims, and that address has to mean the same thing in
 * both. Its site row comes from `getSiteForClassroom` — the bare
 * `ClassroomSite`, with no `classroom` include — so the parameter names the
 * four columns this actually reads rather than `SiteWithClassroom`, which both
 * callers satisfy.
 */
export async function canonicalOriginForSite(
  site: Pick<
    SiteWithClassroom,
    'subdomain' | 'classroom_id' | 'custom_domain' | 'custom_domain_verified_at'
  >
): Promise<string | null> {
  const subdomainOrigin = siteOrigin(site.subdomain);
  if (!site.custom_domain || !site.custom_domain_verified_at) return subdomainOrigin;

  const proState = await subscriptionService.getProStateForClassroomId(site.classroom_id);
  return seoOriginFor({
    subdomainOrigin,
    customDomain: site.custom_domain,
    verified: true,
    proActive: proState.isPro,
    servingOnCustomDomain: false,
  });
}

/**
 * The class site's canonical origin, or null when no site serves this
 * classroom's forms.
 *
 * The three conditions under which the site does not serve mirror
 * `getSiteBySubdomain` — which is what the bridge resolves through, so a short
 * link built past any of them would 404 while the canonical one works. A link
 * that works beats a link that is shorter.
 *
 * BOTH classroom conditions, not just the status one: `is_archived` is a
 * separate boolean from ClassroomStatus, and the staff gate does not consider
 * it, so staff of an archived classroom do reach this screen.
 */
async function servingSiteOrigin(classroom: {
  id: string;
  status?: string;
  is_archived?: boolean;
}): Promise<string | null> {
  if (classroom.is_archived || classroom.status === 'UNPUBLISHED') return null;

  const site = await siteService.getSiteForClassroom(classroom.id);
  if (!site || !site.is_enabled) return null;
  return await canonicalOriginForSite(site);
}

/**
 * The public URL a form should be shared as — the origin AND the path, from one
 * place.
 *
 * ONE function for both halves, deliberately, because splitting them is what
 * broke this. An earlier `publicFormOrigin` answered only "which hostname", and
 * each caller appended the pages-shaped `/{classroomSlug}/forms/{formSlug}` to
 * whatever came back. On a class-site host that path does not exist: the site
 * tree serves the SHORT bridge path `/forms/{formSlug}` and nothing else (see
 * `apps/pages/app/site/forms.ts`), so every link copied for a classroom with a
 * site was a 404. The two decisions are one decision, and they have one home.
 *
 * ── Which hostname ─────────────────────────────────────────────────────────
 * The SHORT class-site link when the classroom has a site — `cs52.classmoji.io`,
 * or `cs52.dartmouth.edu` once the instructor connects their own domain —
 * because that is the address of the course, and a link that fits on a slide is
 * the whole point of the bridge. Every one of those hostnames serves the same
 * form; the site ones just 302 across.
 *
 * The deliberate consequence is the lapsed case. When PRO lapses the custom
 * domain stops being canonical and the copied link goes back to the subdomain —
 * a longer URL, but the custom host is 302ing visitors to that subdomain
 * anyway, and a link that keeps working beats a link that is shorter.
 *
 * `fallbackOrigin` is the host that serves the canonical `/{class}/forms/{slug}`
 * path when there is no site. The pages list passes the origin that served ITS
 * request rather than PAGES_URL, which is what keeps the link right on a
 * devport, in a tunnel, and anywhere else the configured URL is not the one the
 * instructor is looking at. The webapp list is on a DIFFERENT origin from the
 * one that serves forms, so it passes PAGES_URL — the same value its Edit and
 * Responses links are built from.
 *
 * The canonical origin is null when SITE_BASE_DOMAIN is unset, so an
 * environment with the site feature off keeps the canonical link with no branch
 * of its own.
 *
 * ── Why it returns a builder ───────────────────────────────────────────────
 * The list renders every form in the classroom, and the hostname is a property
 * of the CLASSROOM, not of the form: resolving it per row would run the site
 * read and the subscription read once per form. One await, then a pure function
 * the caller maps over its rows — and because the caller is handed a finished
 * URL rather than a base to append to, there is no seam left for a path shape
 * to disagree across again.
 */
export async function publicFormUrlFor(
  classroom: { id: string; status?: string; is_archived?: boolean },
  fallbackOrigin: string,
  classroomSlug: string
): Promise<(formSlug: string) => string> {
  const origin = await servingSiteOrigin(classroom);
  // The site bridge's own shape, and the only forms path a site host serves.
  if (origin) return formSlug => `${origin}/forms/${formSlug}`;
  // The canonical pages route, which is where the bridge redirects to anyway.
  return formSlug => `${fallbackOrigin}/${classroomSlug}/forms/${formSlug}`;
}
