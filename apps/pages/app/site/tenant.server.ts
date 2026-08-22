import type { Role } from '@prisma/client';

import { prisma, ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { siteHeaders } from './headers.server.ts';

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

async function loadSiteContext(request: Request, rawSubdomain: string): Promise<SiteContext> {
  const lookup = await ClassmojiService.site.getSiteBySubdomain(rawSubdomain);

  if (lookup.state === 'not_found') throw siteNotFound(request, 'missing');
  // `disabled` and `unavailable` are deliberately indistinguishable from the
  // outside: both render "site unavailable" and neither confirms that the
  // subdomain is claimed. Only the copy in the error boundary differs, and it
  // is derived from the status text, not from the DB state.
  if (lookup.state !== 'active') throw siteNotFound(request, 'unavailable');

  const site = lookup.site;
  const viewer = await resolveViewer(request, site.classroom_id);

  return { subdomain: site.subdomain, site, viewer };
}

/**
 * Resolve (and memoize for this request) the site + viewer.
 *
 * Throws a branded 404 Response when the hostname resolves to nothing.
 */
export function resolveSiteContext(args: SiteLoaderArgs): Promise<SiteContext> {
  const key = memoKey(args);
  const cached = contextCache.get(key);
  if (cached) return cached;

  const pending = loadSiteContext(args.request, args.params.subdomain ?? '');
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
