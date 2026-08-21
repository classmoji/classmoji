import getPrisma from '@classmoji/database';
import { normalizeSubdomain, isValidSubdomain, RESERVED_SUBDOMAINS } from '@classmoji/utils';
import { isItemPublished, isItemPubliclyVisible } from './module.service.ts';
import type { Prisma, Role } from '@prisma/client';

/**
 * Public course sites: subdomain claiming, site settings, and every visibility
 * decision the anonymous web makes.
 *
 * The rule this file exists to hold in one place: a classroom's in-app state
 * and its public state are SEPARATE. Publishing a page to students does not put
 * it on the web; enabling a site does not publish anything. Every read here
 * takes a viewer role — `null` meaning "not signed in, or signed in but not a
 * member of this classroom" — and narrows accordingly.
 */

/** `null` = anonymous, or a signed-in user who is not a member of this classroom. */
export type SiteViewerRole = Role | null;

export const SITE_ERROR = {
  /** Not a valid DNS label after normalization. */
  SUBDOMAIN_INVALID: 'SUBDOMAIN_INVALID',
  /** A platform-owned label (RESERVED_SUBDOMAINS). */
  SUBDOMAIN_RESERVED: 'SUBDOMAIN_RESERVED',
  /** Another classroom holds it. */
  SUBDOMAIN_TAKEN: 'SUBDOMAIN_TAKEN',
  /** Example/sandbox classrooms cannot have a public site. */
  CLASSROOM_NOT_ELIGIBLE: 'CLASSROOM_NOT_ELIGIBLE',
  /** No site row yet — claim a subdomain before configuring one. */
  SITE_NOT_FOUND: 'SITE_NOT_FOUND',
  /** Enabling (or staying enabled) without a home page. */
  HOME_PAGE_REQUIRED: 'HOME_PAGE_REQUIRED',
  /** Home page is a draft, or belongs to another classroom. */
  HOME_PAGE_INVALID: 'HOME_PAGE_INVALID',
} as const;

export type SiteErrorCode = (typeof SITE_ERROR)[keyof typeof SITE_ERROR];

/** Every rejection from this service carries a machine-readable `code`. */
export class SiteError extends Error {
  readonly code: SiteErrorCode;

  constructor(code: SiteErrorCode, message: string) {
    super(message);
    this.name = 'SiteError';
    this.code = code;
  }
}

/**
 * The classroom fields a public request is allowed to see.
 *
 * NARROW ON PURPOSE, and never `settings: true`. ClassroomSettings holds
 * `openai_api_key` and `anthropic_api_key`; a site loader's return value is one
 * `JSON.stringify` away from an anonymous browser, so the whole record must
 * never be in it. Only `theme` is pulled through, by explicit select.
 *
 * `git_organization` likewise selects identity only — `access_token` is a
 * GitLab/Gitea credential. Content reads on the public site go to the GitHub
 * Pages CDN (getContentUrl), which needs nothing but the login and repo name.
 */
const SITE_CLASSROOM_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  is_archived: true,
  content_namespace: true,
  content_repo: true,
  git_organization: { select: { id: true, login: true, provider: true } },
  settings: { select: { theme: true } },
} satisfies Prisma.ClassroomSelect;

const SITE_INCLUDE = {
  classroom: { select: SITE_CLASSROOM_SELECT },
} satisfies Prisma.ClassroomSiteInclude;

export type SiteWithClassroom = Prisma.ClassroomSiteGetPayload<{ include: typeof SITE_INCLUDE }>;

/**
 * Why a hostname did not resolve to a servable site — a discriminated state
 * rather than a bare null, because the four cases render differently and only
 * one of them is a 404. Collapsing them would either 404 a live classroom whose
 * instructor merely toggled the site off, or leak that a subdomain is claimed
 * when it should look unclaimed.
 */
export type SiteLookup =
  | { state: 'not_found' }
  | { state: 'disabled'; site: SiteWithClassroom }
  | { state: 'unavailable'; site: SiteWithClassroom }
  | { state: 'active'; site: SiteWithClassroom };

/**
 * Resolve a request hostname's leading label to a site.
 *
 * Precedence is not_found → disabled → unavailable → active. An archived
 * classroom whose site is also switched off reads as `disabled`: the nearer
 * cause is the one the instructor can act on.
 *
 * LOCKED classrooms keep serving. LOCKED means "the term is over, no more
 * writes", and a finished course's syllabus is exactly the thing that should
 * stay linkable. UNPUBLISHED (never opened) does not serve.
 */
export async function getSiteBySubdomain(subdomain: string): Promise<SiteLookup> {
  // Hostnames are case-insensitive and arrive however the browser sent them;
  // the unique index is byte-comparing. Normalize before the lookup, not after.
  const normalized = normalizeSubdomain(subdomain);
  if (!isValidSubdomain(normalized)) return { state: 'not_found' };

  const site = await getPrisma().classroomSite.findUnique({
    where: { subdomain: normalized },
    include: SITE_INCLUDE,
  });

  if (!site) return { state: 'not_found' };
  if (!site.is_enabled) return { state: 'disabled', site };
  if (site.classroom.is_archived || site.classroom.status === 'UNPUBLISHED') {
    return { state: 'unavailable', site };
  }
  return { state: 'active', site };
}

/** The raw site row for a classroom (admin settings loader), or null. */
export async function getSiteForClassroom(classroomId: string) {
  return getPrisma().classroomSite.findUnique({ where: { classroom_id: classroomId } });
}

export type SubdomainAvailability = {
  available: boolean;
  /** The trimmed, lowercased label the caller would actually get. */
  normalized: string;
  reason?: Extract<SiteErrorCode, 'SUBDOMAIN_INVALID' | 'SUBDOMAIN_RESERVED' | 'SUBDOMAIN_TAKEN'>;
};

/**
 * Can this classroom claim this label? Advisory only — the answer is stale the
 * moment it returns, which is why validateAndClaimSubdomain also catches the
 * unique violation. Used to give the admin form a live yes/no.
 *
 * `excludeClassroomId` lets a classroom re-submit the subdomain it already
 * holds without being told it is taken by itself.
 */
export async function checkSubdomainAvailability(
  subdomain: string,
  excludeClassroomId?: string
): Promise<SubdomainAvailability> {
  const normalized = normalizeSubdomain(subdomain);

  if (!isValidSubdomain(normalized)) {
    return { available: false, normalized, reason: SITE_ERROR.SUBDOMAIN_INVALID };
  }
  if (RESERVED_SUBDOMAINS.has(normalized)) {
    return { available: false, normalized, reason: SITE_ERROR.SUBDOMAIN_RESERVED };
  }

  const holder = await getPrisma().classroomSite.findUnique({
    where: { subdomain: normalized },
    select: { classroom_id: true },
  });
  if (holder && holder.classroom_id !== excludeClassroomId) {
    return { available: false, normalized, reason: SITE_ERROR.SUBDOMAIN_TAKEN };
  }

  return { available: true, normalized };
}

/** Does this P2002 name the classroom_sites.subdomain unique index? */
const isSubdomainConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const tokens = (
    Array.isArray(target) ? target : typeof target === 'string' ? target.split(',') : []
  ).map(t => String(t).trim().toLowerCase());
  return tokens.includes('subdomain') || tokens.includes('classroom_sites_subdomain_key');
};

/**
 * Claim (or re-point) a classroom's subdomain, creating the site row on first
 * call.
 *
 * The site is NOT enabled here — a new row defaults to is_enabled = false and an
 * existing row's flag is untouched. Enabling is upsertSiteSettings' job and
 * requires a home page.
 */
export async function validateAndClaimSubdomain(classroomId: string, subdomain: string) {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: { id: true, is_example: true },
  });
  if (!classroom) {
    throw new SiteError(SITE_ERROR.CLASSROOM_NOT_ELIGIBLE, 'Classroom not found.');
  }
  // The per-user "Example Course" sandbox is backed by a mock git org with no
  // real content repo; a public site for it would render nothing and would burn
  // a subdomain per signup.
  if (classroom.is_example) {
    throw new SiteError(
      SITE_ERROR.CLASSROOM_NOT_ELIGIBLE,
      'Example classrooms cannot have a public course site.'
    );
  }

  const availability = await checkSubdomainAvailability(subdomain, classroomId);
  if (!availability.available) {
    const { normalized, reason } = availability;
    if (reason === SITE_ERROR.SUBDOMAIN_INVALID) {
      throw new SiteError(
        reason,
        `'${normalized}' is not a valid subdomain. Use 1-63 lowercase letters, numbers and hyphens, starting and ending with a letter or number.`
      );
    }
    if (reason === SITE_ERROR.SUBDOMAIN_RESERVED) {
      throw new SiteError(
        reason,
        `'${normalized}' is reserved by Classmoji. Pick another subdomain.`
      );
    }
    throw new SiteError(
      SITE_ERROR.SUBDOMAIN_TAKEN,
      `'${normalized}' is already taken by another classroom.`
    );
  }

  try {
    return await getPrisma().classroomSite.upsert({
      where: { classroom_id: classroomId },
      create: { classroom_id: classroomId, subdomain: availability.normalized },
      update: { subdomain: availability.normalized },
    });
  } catch (error: unknown) {
    // The check above is advisory; another classroom can claim the label in the
    // gap. The index is the authority. Keyed on classroom_id, this upsert can
    // only ever violate the subdomain unique — but match the target anyway, so
    // an unrelated constraint added later surfaces as itself.
    if (isSubdomainConflict(error)) {
      throw new SiteError(
        SITE_ERROR.SUBDOMAIN_TAKEN,
        `'${availability.normalized}' is already taken by another classroom.`
      );
    }
    throw error;
  }
}

export type SiteSettingsInput = {
  is_enabled?: boolean;
  home_page_id?: string | null;
  show_schedule?: boolean;
};

/**
 * Update a site's settings, enforcing the invariant the schema cannot: an
 * enabled site always has a home page, and that home page is a published page
 * of THIS classroom.
 *
 * Both halves are evaluated on the RESULTING row, not on the patch, so every
 * way of breaking them is caught by one check apiece — enabling without a home
 * page, enabling while simultaneously clearing it, clearing it on a site that
 * is already live, and enabling a site onto a stored home page that has since
 * become a draft or left the classroom. There is no "it was already true"
 * escape hatch: a live site whose home page is removed would serve a blank
 * root, and one pointed at a draft would publish unfinished work.
 *
 * (Deleting the home page itself is a different path — the FK is ON DELETE SET
 * NULL, which leaves an enabled site with a null home page. That is deliberate:
 * losing a page must not delete the site row and release its subdomain. PR2's
 * serving code has to treat that shape as a repairable landing state.)
 */
export async function upsertSiteSettings(classroomId: string, input: SiteSettingsInput) {
  const prisma = getPrisma();
  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroomId },
  });
  if (!existing) {
    throw new SiteError(
      SITE_ERROR.SITE_NOT_FOUND,
      'This classroom has no site yet — claim a subdomain first.'
    );
  }

  const nextHomePageId =
    input.home_page_id === undefined ? existing.home_page_id : input.home_page_id;
  const nextEnabled = input.is_enabled === undefined ? existing.is_enabled : input.is_enabled;

  // Validated on the RESULTING home page, not on the patch — same discipline as
  // HOME_PAGE_REQUIRED below, and for the same reason. Keying this off
  // `input.home_page_id` alone left one hole wide open: `{ is_enabled: true }`
  // by itself never mentions a home page, so a site whose STORED home page had
  // since been unpublished (or moved to another classroom) could be switched on
  // and immediately serve a draft at its front door. The page is only ever
  // vetted when it was chosen, never when it is merely inherited.
  //
  // So the check runs in two cases:
  //   • the caller named a page — vet what they picked, enabled or not, because
  //     storing a draft now is storing a landmine for the next enable; and
  //   • the site ends up enabled — vet whatever it ends up pointing at,
  //     however it got there.
  // A patch that leaves a DISABLED site disabled skips it: nothing is public,
  // and refusing `{ show_schedule: false }` because of an unrelated stale home
  // page would be an error the admin cannot act on from that form.
  if (nextHomePageId && (input.home_page_id !== undefined || nextEnabled)) {
    // Scoped query, not the FK: `home_page_id` references `pages(id)` globally,
    // so the constraint happily accepts another classroom's page. Only a
    // classroom-scoped read can refuse it — and a draft, which must never be
    // the front door of a public site.
    const page = await prisma.page.findFirst({
      where: { id: nextHomePageId, classroom_id: classroomId },
      select: { id: true, is_draft: true },
    });
    if (!page) {
      throw new SiteError(
        SITE_ERROR.HOME_PAGE_INVALID,
        'That page does not belong to this classroom.'
      );
    }
    if (page.is_draft) {
      throw new SiteError(
        SITE_ERROR.HOME_PAGE_INVALID,
        'A draft page cannot be the site home page. Publish it first.'
      );
    }
  }

  if (nextEnabled && !nextHomePageId) {
    throw new SiteError(
      SITE_ERROR.HOME_PAGE_REQUIRED,
      'A published site needs a home page. Choose one, or turn the site off first.'
    );
  }

  return prisma.classroomSite.update({
    where: { classroom_id: classroomId },
    data: {
      ...(input.is_enabled === undefined ? {} : { is_enabled: input.is_enabled }),
      ...(input.home_page_id === undefined ? {} : { home_page_id: input.home_page_id }),
      ...(input.show_schedule === undefined ? {} : { show_schedule: input.show_schedule }),
    },
  });
}

/** The two page flags every site visibility decision reads. */
type PageVisibility = { is_draft: boolean; is_public: boolean };

/**
 * May this viewer see this page on the public site?
 *
 * Drafts NEVER serve here, not even to the owner. The site is the published
 * artifact; staff preview drafts in the app, where the URL is unmistakably
 * internal. Serving a draft on the public host — even behind a role check —
 * makes it one accidental sign-out from being indexed and, worse, makes the
 * public site an unreliable answer to "is this live yet?".
 *
 * Beyond that, `is_public` is what opens a published page to anonymous readers;
 * any member (student included) sees every published page.
 */
export function isPageVisibleOnSite(page: PageVisibility, role: SiteViewerRole): boolean {
  return !page.is_draft && (page.is_public || role !== null);
}

/**
 * The site's home page, if this viewer may see it.
 *
 * There is deliberately NO fallback to "the first public page": enabling a site
 * requires choosing a home page, so a null here means either the page was
 * deleted (FK SET NULL) or it is members-only and the visitor is anonymous.
 * Both want the same minimal landing page from the caller — guessing a
 * substitute would publish a page the instructor never nominated.
 */
export async function getHomePageForViewer(
  site: { classroom_id: string; home_page_id: string | null },
  role: SiteViewerRole
) {
  if (!site.home_page_id) return null;

  // Scoped to the classroom for the same reason upsertSiteSettings is: the FK
  // alone cannot guarantee the row it points at belongs here.
  const page = await getPrisma().page.findFirst({
    where: { id: site.home_page_id, classroom_id: site.classroom_id },
  });
  if (!page) return null;

  return isPageVisibleOnSite(page, role) ? page : null;
}

/**
 * Resolve one URL segment to a page: SLUG FIRST, then id.
 *
 * The order is the whole point. A page's slug is author-controlled text, so
 * nothing stops someone titling a page after another page's uuid; if ids were
 * tried first, that page would shadow the slug and the same URL would resolve
 * differently depending on which rows exist. Slug wins, always; the id lookup
 * is the fallback for pages whose title reduced to nothing (slug NULL) and for
 * links minted before slugs existed.
 */
export async function getPageBySlugForSite(classroomId: string, slugOrId: string) {
  const prisma = getPrisma();

  const bySlug = await prisma.page.findFirst({
    where: { classroom_id: classroomId, slug: slugOrId },
  });
  if (bySlug) return bySlug;

  return prisma.page.findFirst({ where: { classroom_id: classroomId, id: slugOrId } });
}

// Only the fields a visibility decision or a link needs. Notably absent: a
// repository's assignments, attached resources and quizzes — the in-app module
// tree pulls those, and an anonymous request has no business loading them.
const SITE_ITEM_INCLUDE = {
  page: { select: { id: true, title: true, slug: true, is_draft: true, is_public: true } },
  slide: { select: { id: true, title: true, slug: true, is_draft: true, is_public: true } },
  repository: { select: { id: true, title: true, is_published: true } },
  quiz: { select: { id: true, name: true, status: true } },
} satisfies Prisma.ModuleItemInclude;

/**
 * The classroom's modules as this viewer may see them.
 *
 * A module reaches the site only when `is_published && is_public` — both flags,
 * so a public site can never expose coursework that was only ever meant for
 * enrolled students.
 *
 * Items are then filtered per viewer: anonymous visitors get
 * isItemPubliclyVisible (published-AND-public pages and slides only;
 * repositories and quizzes dropped entirely, titles included), members get the
 * app's ordinary isItemPublished. Modules left with no visible items are
 * dropped rather than rendered empty — an empty shell still leaks the module
 * title and, by its position, that something is hidden there.
 */
export async function listPublicModulesForViewer(classroomId: string, role: SiteViewerRole) {
  const modules = await getPrisma().module.findMany({
    where: { classroom_id: classroomId, is_published: true, is_public: true },
    include: { items: { orderBy: { position: 'asc' }, include: SITE_ITEM_INCLUDE } },
    // Same ordering the app uses for modules everywhere else.
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });

  const visible = role === null ? isItemPubliclyVisible : isItemPublished;

  return modules
    .map(module => ({ ...module, items: module.items.filter(visible) }))
    .filter(module => module.items.length > 0);
}
