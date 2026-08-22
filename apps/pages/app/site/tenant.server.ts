import { redirect } from 'react-router';
import type { Role } from '@prisma/client';

import { prisma, ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { siteHeaders } from './headers.server.ts';
import { customDomainOrigin, siteOrigin } from './env.server.ts';

/**
 * Site types are derived from the service's own return type rather than
 * imported: `@classmoji/services` only exports its package root, and a
 * deep-path import into `src/` would be a build-order dependency that works in
 * dev and breaks somewhere else.
 */
type SiteLookup = Awaited<ReturnType<typeof ClassmojiService.site.getSiteBySubdomain>>;
export type SiteWithClassroom = Extract<SiteLookup, { state: 'active' }>['site'];
/** `null` = anonymous, or signed in but not a member of this classroom. */
export type SiteViewerRole = Role | null;

/**
 * THE request-scoped tenant + viewer resolver for class websites.
 *
 * React Router runs nested loaders in PARALLEL, and a child loader cannot read
 * its parent's result. Without memoization, `/{slug}` would run the site
 * lookup, the session read and the membership query twice — once in the layout
 * and once in the page — and the two copies could even disagree if a row
 * changed between them. Every loader therefore calls `resolveSiteContext(args)`
 * and the first caller's promise is memoized for the rest of the request, so a
 * page view resolves its tenant exactly once no matter how many loaders ask.
 *
 * The memo key is React Router's per-request `context` object, NOT the Request
 * — see `memoKey`, and note that keying on the Request was measured doing the
 * work twice. A WeakMap is the right cache here precisely because there is
 * nothing to invalidate: the key dies with the request.
 */

/** Role priority for multi-role members — `@@unique([classroom_id, user_id, role])` means one user really can hold several. */
const ROLE_PRIORITY: Record<Role, number> = {
  OWNER: 4,
  TEACHER: 3,
  ASSISTANT: 2,
  STUDENT: 1,
};

const STAFF_ROLES: ReadonlySet<string> = new Set(['OWNER', 'TEACHER']);

export type SiteViewer = {
  /** null = anonymous. Non-null with a null `role` = signed in, not a member. */
  userId: string | null;
  login: string | null;
  name: string | null;
  image: string | null;
  role: SiteViewerRole;
};

export type SiteContext = {
  subdomain: string;
  site: SiteWithClassroom;
  viewer: SiteViewer;
  /**
   * The instructor-owned hostname this request arrived on, or null for the
   * canonical `{subdomain}.{SITE_BASE_DOMAIN}` host.
   *
   * Comes from the trusted load context (stamped by the host middleware),
   * NEVER from a header — see CUSTOM_DOMAIN_REQUEST_KEY in server/siteHost.ts.
   */
  customDomain: string | null;
  /**
   * Prefix for links that must leave this host: `''` on the canonical
   * subdomain, an absolute origin on a custom domain.
   *
   * A custom domain has no session and cannot get one — cookies do not cross
   * registrable domains — so Sign in, the `/app` bridge and every members-only
   * destination have to be absolute URLs back to the cookie world. Concatenate
   * it with an ordinary path (`` `${memberLinkOrigin}/sign-in` ``) and the
   * subdomain case stays exactly the relative URL it is today.
   */
  memberLinkOrigin: string;
  /**
   * The origin `rel=canonical` and `og:url` must name.
   *
   * The point of a custom domain is that it becomes the address of the course,
   * so SEO signal has to consolidate on ONE hostname — and both hostnames have
   * to agree on which. When a claim is verified and the classroom is on PRO,
   * that is the custom domain, and the canonical subdomain says so too.
   * Otherwise both name the subdomain.
   */
  seoOrigin: string | null;
};

/** One row of the classroom's page index — everything a link or a gate needs. */
export type SitePageIndexEntry = {
  id: string;
  slug: string | null;
  title: string;
  is_public: boolean;
};

const ANONYMOUS: SiteViewer = {
  userId: null,
  login: null,
  name: null,
  image: null,
  role: null,
};

/**
 * The slice of React Router's loader args the resolver needs.
 *
 * Taken as a whole rather than as loose parameters so that `context` — the
 * memo key — cannot be forgotten at a call site. Forgetting it would not
 * break anything visibly; it would just quietly double the queries.
 */
export type SiteLoaderArgs = {
  request: Request;
  params: Record<string, string | undefined>;
  context?: unknown;
};

/**
 * The per-request identity to memoize against.
 *
 * NOT the Request: React Router hands each loader in the chain its own Request
 * instance (measured — a WeakMap keyed on it produced two tenant lookups for
 * one page view, one from the layout and one from the page). The `context`
 * object IS shared across every loader of a single request, which is exactly
 * the lifetime we want. The Request remains the fallback for any caller
 * without one, where the worst case is the duplicate work we started with.
 */
function memoKey(args: SiteLoaderArgs): object {
  return args.context && typeof args.context === 'object' ? (args.context as object) : args.request;
}

const contextCache = new WeakMap<object, Promise<SiteContext>>();
const pageIndexCache = new WeakMap<object, Promise<SitePageIndexEntry[]>>();

/** Is this viewer teaching staff (owner/teacher) for the site's classroom? */
export function isStaff(viewer: SiteViewer): boolean {
  return viewer.role !== null && STAFF_ROLES.has(viewer.role);
}

/** Is this viewer a member of the site's classroom at all? */
export function isMember(viewer: SiteViewer): boolean {
  return viewer.role !== null;
}

/**
 * The webapp path prefix a role's dashboard lives under.
 * Assistants have their own route tree; everyone else is admin or student.
 */
export function rolePrefix(role: SiteViewerRole): 'admin' | 'assistant' | 'student' | null {
  if (role === null) return null;
  if (role === 'ASSISTANT') return 'assistant';
  if (STAFF_ROLES.has(role)) return 'admin';
  return 'student';
}

/**
 * Resolve the signed-in viewer and their role in this classroom.
 *
 * `has_accepted_invite: false` is NOT membership — an invited-but-never-joined
 * user must see exactly what the anonymous web sees. That is the difference
 * between this and the app's `findByClassroomAndUser`, which is why site code
 * resolves the role itself instead of reusing that helper.
 */
async function resolveViewer(request: Request, classroomId: string): Promise<SiteViewer> {
  // A failed/absent session is the normal case on a public site, not an error.
  const authData = await getAuthSession(request).catch(() => null);
  if (!authData?.userId) return ANONYMOUS;

  const [user, memberships] = await Promise.all([
    prisma.user.findUnique({
      where: { id: authData.userId },
      select: { id: true, login: true, name: true, image: true },
    }),
    prisma.classroomMembership.findMany({
      where: {
        classroom_id: classroomId,
        user_id: authData.userId,
        has_accepted_invite: true,
      },
      select: { role: true },
    }),
  ]);

  if (!user) return ANONYMOUS;

  // Highest privilege wins: a TA who is also enrolled as a student sees the
  // staff view, never the narrower one.
  let role: SiteViewerRole = null;
  for (const membership of memberships) {
    if (role === null || ROLE_PRIORITY[membership.role] > ROLE_PRIORITY[role]) {
      role = membership.role;
    }
  }

  return { userId: user.id, login: user.login, name: user.name, image: user.image, role };
}

/**
 * A branded, script-less 404 for a hostname that resolves to nothing servable.
 *
 * Thrown (not returned) so it short-circuits every loader on the request. The
 * headers are attached here rather than left to a `headers` export because a
 * thrown Response is what actually reaches the client on the error path.
 */
function siteNotFound(request: Request, kind: 'missing' | 'unavailable'): Response {
  return new Response(kind, {
    status: 404,
    headers: siteHeaders({ request, cacheable: false, noindex: true }),
  });
}

/**
 * The visitor-facing path of the current request, prefix already removed.
 * Query string included — a redirect that drops `?page=2` is a broken link.
 */
function publicRequestPath(request: Request, subdomain: string): string {
  const url = new URL(request.url);
  return publicPathOf(url.pathname, subdomain) + url.search;
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
 * The response a custom domain gives once its subscription has lapsed.
 *
 * **302, never 301.** A lapse is a reversible billing state: the instructor can
 * re-subscribe this afternoon. Browsers and search engines cache a permanent
 * redirect indefinitely, so a 301 would make "upgrade restores it instantly"
 * false for everyone who already followed one — and `Cache-Control: no-store`
 * does not help, because it governs HTTP caches, not the permanence a 301
 * asserts. 301 is reserved for a genuine `clearCustomDomain`, where the
 * hostname really has been given up.
 *
 * `noindex` on top: while lapsed, this URL is not the course's address and
 * should not be collecting search results of its own.
 */
export function lapsedCustomDomainRedirect(
  request: Request,
  canonicalOrigin: string | null,
  publicPath: string
): Response {
  return redirect(`${canonicalOrigin ?? ''}${publicPath}`, {
    status: 302,
    headers: siteHeaders({ request, cacheable: false, noindex: true }),
  });
}

/**
 * Resolve a request that arrived on an instructor-owned hostname.
 *
 * The routing snapshot in the express layer already decided WHICH tenant this
 * hostname belongs to; everything here re-derives that from the database,
 * because the snapshot is allowed to be up to a refresh interval stale and a
 * re-pointed domain must never serve its previous owner's content.
 *
 * Two guards carry that weight:
 *
 *  - the claim is re-read by hostname, so a domain cleared or moved since the
 *    snapshot was taken resolves to nothing (or to somebody else), and
 *  - the subdomain it resolves to is compared against the one the middleware
 *    rewrote to. A mismatch means the map and the database disagree, which on
 *    this path can only mean the domain moved — and serving the rewritten
 *    tenant anyway would be a cross-tenant content leak with a cache TTL for a
 *    lifetime. It is a 404, not a redirect: the correct destination belongs to
 *    someone who did not ask us to advertise it.
 *
 * A custom domain NEVER reads the session. Cookies do not cross registrable
 * domains, so there is nothing to read — but "nothing to read" and "we do not
 * look" are different guarantees, and only the second one survives someone
 * later setting a wildcard cookie domain. Every visitor here is anonymous, and
 * members-only content is reached by an absolute link back to the subdomain.
 */
async function loadCustomDomainContext(
  request: Request,
  rawSubdomain: string,
  customDomain: string
): Promise<SiteContext> {
  const lookup = await ClassmojiService.site.getSiteByCustomDomain(customDomain);

  if (lookup.state === 'not_found') throw siteNotFound(request, 'missing');
  if (lookup.site.subdomain !== rawSubdomain) throw siteNotFound(request, 'missing');

  const canonicalOrigin = siteOrigin(lookup.site.subdomain);
  // Unreachable in practice — the middleware only resolves a custom host when
  // SITE_BASE_DOMAIN is set, which is the one thing siteOrigin needs. Guarded
  // anyway because the failure mode is not a broken link: every absolute URL on
  // this path (the lapse redirect, Sign in, the /app bridge) would collapse to a
  // relative one, pointing the custom domain at ITSELF. That is an infinite
  // redirect, and it is worth one branch to make it impossible.
  if (!canonicalOrigin) throw siteNotFound(request, 'unavailable');

  if (lookup.state === 'lapsed') {
    // The subscription that bought this hostname is no longer active. The site
    // itself is untouched and still live at its subdomain, so send visitors
    // there. See lapsedCustomDomainRedirect for why 302 and not 301.
    throw lapsedCustomDomainRedirect(
      request,
      canonicalOrigin,
      publicRequestPath(request, rawSubdomain)
    );
  }

  // Same as the subdomain path: `disabled` and `unavailable` are deliberately
  // indistinguishable from outside.
  if (lookup.state !== 'active') throw siteNotFound(request, 'unavailable');

  // The full site payload for rendering. A second read rather than widening the
  // hot-path select: this one is the same query every subdomain request makes,
  // and having one assembly path for site content is worth a round trip on a
  // route that serves tens of hostnames.
  const full = await ClassmojiService.site.getSiteBySubdomain(lookup.site.subdomain);
  if (full.state !== 'active') throw siteNotFound(request, 'unavailable');

  // Lazily record that this claim has served over its own hostname. Reaching
  // this line means a browser completed a TLS handshake against a certificate
  // Fly issued for this name, which is the only ownership proof in the system —
  // and it arrives whether or not an admin has the settings tab open. Written
  // once per claim (the service no-ops when the stamp is already set) and never
  // awaited: a verification stamp must not be able to delay, or fail, a page.
  if (!lookup.verifiedAt) {
    void ClassmojiService.site
      .markCustomDomainVerified(lookup.site.id, customDomain)
      .catch(() => {});
  }

  return {
    subdomain: full.site.subdomain,
    site: full.site,
    viewer: ANONYMOUS,
    customDomain,
    memberLinkOrigin: canonicalOrigin,
    seoOrigin: seoOriginFor({
      subdomainOrigin: canonicalOrigin,
      customDomain,
      // Serving this request IS the verification — see markCustomDomainVerified
      // — so the flip happens on the first hit rather than one page view later.
      verified: true,
      // `active` is only reachable past the `lapsed` branch above.
      proActive: true,
      servingOnCustomDomain: true,
    }),
  };
}

async function loadSiteContext(
  request: Request,
  rawSubdomain: string,
  customDomain: string | null
): Promise<SiteContext> {
  if (customDomain) return loadCustomDomainContext(request, rawSubdomain, customDomain);

  const lookup = await ClassmojiService.site.getSiteBySubdomain(rawSubdomain);

  if (lookup.state === 'not_found') throw siteNotFound(request, 'missing');
  // `disabled` and `unavailable` are deliberately indistinguishable from the
  // outside: both render "site unavailable" and neither confirms that the
  // subdomain is claimed. Only the copy in the error boundary differs, and it
  // is derived from the status text, not from the DB state.
  if (lookup.state !== 'active') throw siteNotFound(request, 'unavailable');

  const site = lookup.site;
  const viewer = await resolveViewer(request, site.classroom_id);

  return {
    subdomain: site.subdomain,
    site,
    viewer,
    customDomain: null,
    // Already on the host that owns the session; links stay relative.
    memberLinkOrigin: '',
    seoOrigin: await canonicalOriginForSite(site),
  };
}

/**
 * Which hostname should a request served on the SUBDOMAIN call canonical?
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
 */
async function canonicalOriginForSite(site: SiteWithClassroom): Promise<string | null> {
  const subdomainOrigin = siteOrigin(site.subdomain);
  if (!site.custom_domain || !site.custom_domain_verified_at) return subdomainOrigin;

  const proState = await ClassmojiService.subscription.getProStateForClassroomId(site.classroom_id);
  return seoOriginFor({
    subdomainOrigin,
    customDomain: site.custom_domain,
    verified: true,
    proActive: proState.isPro,
    servingOnCustomDomain: false,
  });
}

/**
 * The custom hostname this request arrived on, per the load context.
 *
 * The context is built by `buildSiteLoadContext` from a property the host
 * middleware stamped on the Express request — it is not derived from anything
 * the client sent, which is the entire reason it is trustworthy enough to flip
 * a canonical URL on a cacheable response.
 */
function customDomainOf(args: SiteLoaderArgs): string | null {
  const context = args.context as { customDomain?: unknown } | undefined;
  const value = context?.customDomain;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Resolve (and memoize for this request) the site + viewer.
 *
 * Throws a branded 404 Response when the hostname resolves to nothing, and a
 * 302 to the canonical subdomain when a custom domain's subscription has
 * lapsed.
 */
export function resolveSiteContext(args: SiteLoaderArgs): Promise<SiteContext> {
  const key = memoKey(args);
  const cached = contextCache.get(key);
  if (cached) return cached;

  const pending = loadSiteContext(args.request, args.params.subdomain ?? '', customDomainOf(args));
  contextCache.set(key, pending);
  // A rejected promise stays cached on purpose: every loader on this request
  // should fail identically, and re-running the lookup would only re-throw.
  return pending;
}

/**
 * Every non-draft page in the classroom: id, slug, title, public flag.
 *
 * ONE indexed query per request, shared by the id→slug link map (pageLink,
 * navGrid), the robots.txt decision and the "site has no public pages at all"
 * noindex rule. Drafts are excluded at the query, not filtered later, so a
 * draft title can never travel to a renderer that might print it.
 */
export function loadSitePageIndex(
  args: SiteLoaderArgs,
  classroomId: string
): Promise<SitePageIndexEntry[]> {
  const key = memoKey(args);
  const cached = pageIndexCache.get(key);
  if (cached) return cached;

  const pending = prisma.page
    .findMany({
      where: { classroom_id: classroomId, is_draft: false },
      select: { id: true, slug: true, title: true, is_public: true },
      orderBy: { title: 'asc' },
    })
    .then(rows => rows.map(row => ({ ...row, title: row.title ?? '' })));

  pageIndexCache.set(key, pending);
  return pending;
}

/** Does this site have at least one page an anonymous visitor may read? */
export function hasPublicPages(pages: SitePageIndexEntry[]): boolean {
  return pages.some(page => page.is_public);
}

/**
 * The link target for a page inside a site: its slug, or its id when the title
 * reduced to nothing. Mirrors `getPageBySlugForSite`'s slug-first resolution,
 * so every link this produces resolves back to the same row.
 */
export function sitePagePath(page: { slug: string | null; id: string }): string {
  return `/${page.slug || page.id}`;
}

/**
 * Strip the internal `/_site/{subdomain}` prefix back off a pathname.
 *
 * The host middleware rewrites `/syllabus` into `/_site/cs52/syllabus` before
 * React Router ever sees it. Every URL we emit — canonical tags, sign-in
 * return paths, redirect targets — has to be in the VISITOR's namespace, so
 * the prefix comes off exactly once, here. A `/_site/` URL escaping into a
 * `Location` header or a `<link rel="canonical">` would be both broken (the
 * middleware 404s that path on the canonical host) and a leak of internals.
 */
export function publicPathOf(pathname: string, subdomain: string): string {
  const prefix = `/_site/${subdomain}`;
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
  return pathname;
}
