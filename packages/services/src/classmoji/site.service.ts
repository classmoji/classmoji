import getPrisma from '@classmoji/database';
import {
  normalizeSubdomain,
  isValidSubdomain,
  RESERVED_SUBDOMAINS,
  normalizeCustomDomain,
  isValidCustomDomain,
  isPlatformDomain,
} from '@classmoji/utils';
import { isItemPublished, isItemPubliclyVisible } from './module.service.ts';
import { getProStateForClassroomId } from './subscription.service.ts';
import { removeCert, isFlyCertsConfigured } from '../fly/index.ts';
import type { ModuleItemType, Prisma, Role } from '@prisma/client';

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
  /** Not a bare domain of two or more valid DNS labels. */
  DOMAIN_INVALID: 'DOMAIN_INVALID',
  /** A hostname Classmoji itself answers for (classmoji.io / lvh.me / fly.dev). */
  DOMAIN_RESERVED: 'DOMAIN_RESERVED',
  /** Another classroom already claims it. */
  DOMAIN_TAKEN: 'DOMAIN_TAKEN',
  /** Custom domains are a PRO feature and this classroom is not on PRO. */
  PRO_REQUIRED: 'PRO_REQUIRED',
  /** Not an IANA zone name this runtime's tz data knows. */
  TIMEZONE_INVALID: 'TIMEZONE_INVALID',
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
  /** IANA zone name; `null` clears it back to the UTC fallback. */
  timezone?: string | null;
};

/**
 * The canonical form of an IANA zone name, or null if this runtime has never
 * heard of it.
 *
 * Asks Intl to BUILD a formatter rather than checking membership in
 * `Intl.supportedValuesOf('timeZone')`, and the difference matters. The
 * schedule renders through `dayjs.utc(...).tz(zone)`, which is Intl underneath,
 * so "Intl can format with this" is precisely the invariant that has to hold —
 * whereas the supported-values list omits aliases (`Etc/UTC`, `US/Eastern`) and
 * its exact contents move with the ICU build. Validating against the list would
 * refuse zones that would have rendered perfectly well.
 *
 * The RESOLVED name is what comes back, not the caller's spelling. Intl accepts
 * zone names case-insensitively, so `america/new_york` from a script or a future
 * API caller is stored as `America/New_York` — one spelling per zone in the
 * column, which is what keeps the settings <select> able to show the stored
 * value as its selected option.
 */
function canonicalizeTimeZone(zone: string): string | null {
  const trimmed = zone.trim();
  if (!trimmed) return null;

  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    // RangeError is the documented rejection for an unknown zone. Caught
    // broadly anyway: this runs on an admin write path, and no Intl failure is
    // worth a 500 when the honest answer is "that is not a zone we can use".
    return null;
  }
}

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
 *
 * `timezone` follows the same three-state convention as every other key here:
 * absent means "leave it alone", `null` (or a blank string, which is what an
 * emptied form control submits) CLEARS it back to the UTC fallback, and a
 * non-blank string is validated against the runtime's tz data and stored
 * canonicalized. A bad zone is refused rather than silently dropped — writing
 * it would produce a public schedule that formats in a zone nobody chose.
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

  // Resolved before the write so a rejected zone costs nothing, and so the row
  // stores Intl's canonical spelling rather than the caller's.
  let nextTimezone: string | null | undefined;
  if (input.timezone !== undefined) {
    if (input.timezone === null || input.timezone.trim() === '') {
      nextTimezone = null;
    } else {
      const canonical = canonicalizeTimeZone(input.timezone);
      if (!canonical) {
        throw new SiteError(
          SITE_ERROR.TIMEZONE_INVALID,
          `'${input.timezone}' is not a time zone we recognize. Pick one from the list, or clear it to use UTC.`
        );
      }
      nextTimezone = canonical;
    }
  }

  return prisma.classroomSite.update({
    where: { classroom_id: classroomId },
    data: {
      ...(input.is_enabled === undefined ? {} : { is_enabled: input.is_enabled }),
      ...(input.home_page_id === undefined ? {} : { home_page_id: input.home_page_id }),
      ...(input.show_schedule === undefined ? {} : { show_schedule: input.show_schedule }),
      ...(nextTimezone === undefined ? {} : { timezone: nextTimezone }),
    },
  });
}

/**
 * Delete a classroom's site row, releasing its subdomain for another class.
 *
 * Only the ClassroomSite row goes: pages, modules and their `is_public` flags
 * are the classroom's own content and survive. Re-claiming the same subdomain
 * later rebuilds the site from scratch (disabled, no home page) — which is the
 * point, since "remove" is how an instructor gives a name back.
 *
 * Absence is an ERROR, not a no-op. `prisma.delete` on a missing row throws an
 * opaque P2025; checking first turns a double-submit into a message the caller
 * can render, and matches upsertSiteSettings' SITE_NOT_FOUND contract.
 */
export async function deleteSiteForClassroom(classroomId: string) {
  const prisma = getPrisma();
  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroomId },
    select: { id: true, subdomain: true, custom_domain: true },
  });
  if (!existing) {
    throw new SiteError(SITE_ERROR.SITE_NOT_FOUND, 'This classroom has no site to remove.');
  }

  await prisma.classroomSite.delete({ where: { classroom_id: classroomId } });
  // The row is gone, so this is the LAST moment the hostname is knowable from
  // our side. Best-effort, after the delete: a Fly outage must not block an
  // instructor from removing their site, and the reconcile task
  // (packages/tasks/src/workflows/customDomains.ts) sweeps up whatever this
  // misses — including the classroom-delete cascade, which drops this row
  // inside the database with no application code on the path at all.
  await releaseCert(existing.custom_domain);
  return existing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom domains (PRO)
//
// A PRO classroom may point a hostname it owns at its site. The hostname lives
// on the SAME ClassroomSite row as the subdomain and serves the same content;
// nothing about visibility, publishing or membership changes. What does change
// is the trust model, and it is worth stating once here because three functions
// below only make sense in its light:
//
//   * The subdomain is ours and always resolves. A custom domain is the
//     instructor's, can be re-pointed or abandoned at any moment, and is only
//     ever reachable because a certificate we asked Fly to issue exists.
//   * Serving therefore gates on the DATABASE claim, never on "a certificate
//     exists for this hostname" — a stale certificate plus a dangling DNS
//     record is precisely how the next person to claim the name would take over
//     someone else's site.
//   * `custom_domain_verified_at` is per CLAIM and is cleared whenever the
//     domain changes. It records that THIS claim served over its own hostname,
//     which a completed TLS handshake proves; it gates the canonical/og:url
//     flip, and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort certificate teardown for a hostname we are giving up.
 *
 * Never throws. Every caller has already committed the database change that
 * makes the hostname ours-no-longer, so a Fly failure here is a leaked
 * certificate — annoying, swept up by the reconcile task — while a THROW here
 * would be a user-visible failure of an operation that already succeeded.
 */
async function releaseCert(domain: string | null | undefined): Promise<void> {
  if (!domain) return;
  if (!isFlyCertsConfigured()) return;

  try {
    await removeCert(domain);
  } catch (error: unknown) {
    console.error(`[site.service] could not remove the Fly certificate for ${domain}`, error);
  }
}

/** Does this P2002 name the classroom_sites.custom_domain unique index? */
const isCustomDomainConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const tokens = (
    Array.isArray(target) ? target : typeof target === 'string' ? target.split(',') : []
  ).map(t => String(t).trim().toLowerCase());
  return tokens.includes('custom_domain') || tokens.includes('classroom_sites_custom_domain_key');
};

/**
 * Claim (or re-point) a classroom's custom domain.
 *
 * Four gates, in this order and for these reasons:
 *
 *  1. **The site row must already exist.** A classroom with no site has no
 *     subdomain to fall back to, and `prisma.update` on a missing row throws an
 *     opaque P2025 that no caller can render. SITE_NOT_FOUND matches what
 *     upsertSiteSettings and deleteSiteForClassroom already promise.
 *  2. **PRO, checked HERE.** The route will check too, but this is the gate
 *     that actually holds: MCP tools, a future API and any script reach this
 *     function without passing a loader. It asks
 *     `getProStateForClassroomId`, so a lapsed `{tier:'PRO', ends_at: past}`
 *     row is refused exactly as a FREE one is.
 *  3. **Shape, then platform domains.** Two different messages because they are
 *     two different mistakes: a typo, versus trying to claim a hostname we
 *     already answer for.
 *  4. **Uniqueness, at the index.** The pre-check is advisory and stale the
 *     moment it returns; the P2002 is the authority. Matched by target so an
 *     unrelated constraint added later surfaces as itself rather than as a
 *     misleading "that domain is taken".
 *
 * Re-pointing a domain CLEARS `custom_domain_verified_at` and releases the old
 * hostname's certificate. Both halves matter: an inherited verification stamp
 * would present an unproven hostname as verified, and an inherited certificate
 * is a live TLS endpoint for a domain this classroom no longer claims.
 *
 * Issuance is deliberately NOT done here. The caller claims, then calls
 * `FlyCertService.addCert(domain)` — so a Fly outage leaves a claimed domain
 * awaiting a certificate (retryable from the admin UI) rather than rolling back
 * a claim the instructor just made.
 */
export async function setCustomDomain(classroomId: string, domain: string) {
  const prisma = getPrisma();

  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroomId },
    select: { id: true, custom_domain: true },
  });
  if (!existing) {
    throw new SiteError(
      SITE_ERROR.SITE_NOT_FOUND,
      'This classroom has no site yet — claim a subdomain first.'
    );
  }

  const proState = await getProStateForClassroomId(classroomId);
  if (!proState.isPro) {
    throw new SiteError(
      SITE_ERROR.PRO_REQUIRED,
      'Custom domains require an active Pro subscription.'
    );
  }

  const normalized = normalizeCustomDomain(domain);
  if (!isValidCustomDomain(normalized)) {
    throw new SiteError(
      SITE_ERROR.DOMAIN_INVALID,
      `'${normalized}' is not a valid domain. Use a bare hostname like 'cs52.me' — no https://, no path, no port.`
    );
  }
  if (isPlatformDomain(normalized)) {
    throw new SiteError(
      SITE_ERROR.DOMAIN_RESERVED,
      `'${normalized}' belongs to Classmoji — your site already answers at its Classmoji address. Connect a domain you own.`
    );
  }

  // Re-claiming the same hostname is a no-op on the certificate but must still
  // clear the stamp: the admin is asking for re-verification, and a re-claim is
  // the one moment we can honestly say "prove it again".
  const previous = existing.custom_domain;

  let updated;
  try {
    updated = await prisma.classroomSite.update({
      where: { classroom_id: classroomId },
      data: { custom_domain: normalized, custom_domain_verified_at: null },
    });
  } catch (error: unknown) {
    if (isCustomDomainConflict(error)) {
      throw new SiteError(
        SITE_ERROR.DOMAIN_TAKEN,
        `'${normalized}' is already connected to another Classmoji site.`
      );
    }
    throw error;
  }

  if (previous && previous !== normalized) await releaseCert(previous);

  return updated;
}

/**
 * Drop a classroom's custom domain, releasing its certificate.
 *
 * Absence is a no-op rather than an error: "this site should not have a custom
 * domain" is already true, and a double-submitted Remove button is not
 * something to show an error for. Returns the hostname that was released (or
 * null), which is what the caller needs to tell the instructor their DNS record
 * can now come down.
 */
export async function clearCustomDomain(classroomId: string) {
  const prisma = getPrisma();

  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroomId },
    select: { id: true, custom_domain: true },
  });
  if (!existing) {
    throw new SiteError(SITE_ERROR.SITE_NOT_FOUND, 'This classroom has no site.');
  }
  if (!existing.custom_domain) return { released: null as string | null };

  await prisma.classroomSite.update({
    where: { classroom_id: classroomId },
    data: { custom_domain: null, custom_domain_verified_at: null },
  });

  await releaseCert(existing.custom_domain);
  return { released: existing.custom_domain };
}

/**
 * The fields a custom-domain request needs, and nothing else.
 *
 * Narrower than SITE_INCLUDE on purpose: this lookup runs on the anonymous hot
 * path and its only job is to answer "which tenant, and may it serve here?".
 * The full site + classroom record is loaded afterwards by the ordinary
 * subdomain path, which is the one place site content is assembled.
 */
const CUSTOM_DOMAIN_SELECT = {
  id: true,
  classroom_id: true,
  subdomain: true,
  custom_domain: true,
  custom_domain_verified_at: true,
  is_enabled: true,
  classroom: { select: { id: true, is_archived: true, status: true } },
} satisfies Prisma.ClassroomSiteSelect;

export type CustomDomainSite = Prisma.ClassroomSiteGetPayload<{
  select: typeof CUSTOM_DOMAIN_SELECT;
}>;

/**
 * Why a custom hostname did not serve — a discriminated state, because the
 * caller renders four genuinely different responses and only one is a 404.
 *
 * `lapsed` is the interesting one: the classroom's PRO subscription is no
 * longer active, so the custom domain stops being an address we will serve on,
 * but the site itself is untouched and still live at its subdomain. That is a
 * REVERSIBLE billing state, which is why the caller answers it with a 302 (plus
 * `no-store`) and never a 301 — a permanent redirect is remembered by browsers
 * and search engines long after the instructor re-subscribes.
 */
export type CustomDomainLookup =
  | { state: 'not_found' }
  | { state: 'lapsed'; site: CustomDomainSite }
  | { state: 'disabled'; site: CustomDomainSite }
  | { state: 'unavailable'; site: CustomDomainSite }
  | { state: 'active'; site: CustomDomainSite; verifiedAt: Date | null };

/**
 * Resolve a request hostname to the site that claims it.
 *
 * Precedence is not_found → lapsed → disabled → unavailable → active. Billing
 * is tested BEFORE site state deliberately: a lapsed classroom gets one
 * consistent answer on its custom domain — "this lives at the canonical
 * subdomain" — whatever else is true of the site, and the subdomain then
 * remains the single place a visitor learns whether it is switched off or
 * archived. Splitting that decision across two hostnames is how you end up
 * telling someone "unavailable" on one and redirecting them on the other.
 *
 * This is called PER REQUEST, not read from the routing snapshot. The snapshot
 * is a hint that gets a hostname onto the right tenant subtree; this is the
 * check that makes it true. Without it, a domain re-pointed from one classroom
 * to another would keep serving the old classroom's content for as long as any
 * machine held the previous map — a cross-tenant content leak with a cache TTL
 * for a lifetime.
 */
export async function getSiteByCustomDomain(host: string): Promise<CustomDomainLookup> {
  const normalized = normalizeCustomDomain(host);
  // Shape-check before touching the database: `host` is an unauthenticated,
  // attacker-controlled header, and an indexed lookup per garbage Host is a
  // free amplification primitive.
  if (!isValidCustomDomain(normalized) || isPlatformDomain(normalized)) {
    return { state: 'not_found' };
  }

  const site = await getPrisma().classroomSite.findUnique({
    where: { custom_domain: normalized },
    select: CUSTOM_DOMAIN_SELECT,
  });
  if (!site) return { state: 'not_found' };

  const proState = await getProStateForClassroomId(site.classroom_id);
  if (!proState.isPro) return { state: 'lapsed', site };

  if (!site.is_enabled) return { state: 'disabled', site };
  if (site.classroom.is_archived || site.classroom.status === 'UNPUBLISHED') {
    return { state: 'unavailable', site };
  }

  return { state: 'active', site, verifiedAt: site.custom_domain_verified_at };
}

/**
 * Record that a claim has served over its own hostname.
 *
 * Called from the serving path on a successful custom-domain render, and
 * written ONLY when the stamp is currently null — so it is one UPDATE per
 * claim, not one per request. The `custom_domain` in the WHERE clause is what
 * makes it safe to fire from a hot path: if the domain changed between the read
 * and this write, zero rows match and the new claim keeps its unproven status.
 *
 * Why a completed request is proof at all: reaching this code means a browser
 * completed a TLS handshake for this hostname against a certificate Fly issued
 * to us, which required DNS the instructor controls to point here. Polling Fly
 * from an admin tab, the alternative, only advances while someone has the tab
 * open — a domain configured next week would stay unverified forever.
 */
export async function markCustomDomainVerified(siteId: string, domain: string): Promise<void> {
  await getPrisma().classroomSite.updateMany({
    where: { id: siteId, custom_domain: domain, custom_domain_verified_at: null },
    data: { custom_domain_verified_at: new Date() },
  });
}

/** One row of the custom-domain routing map. */
export type CustomDomainRoute = {
  domain: string;
  subdomain: string;
  /** Servable right now: enabled, classroom live, PRO active. */
  active: boolean;
};

/**
 * Every custom domain and the tenant it points at.
 *
 * Feeds two consumers with different needs, which is why `active` is carried
 * rather than filtered on:
 *
 *  - the pages routing snapshot, which must route a LAPSED or disabled domain
 *    too (its request needs to reach a loader that can answer 302 or 404 —
 *    dropping it here would 404 at the edge and lose that distinction), and
 *  - the reconcile task, which diffs this against Fly's certificate list.
 *
 * One query, tens of rows. `custom_domain: { not: null }` rides the unique
 * index, and the owner subscriptions come along in the same round trip rather
 * than as one `getProStateForClassroomId` per row.
 */
export async function listCustomDomainRoutes(): Promise<CustomDomainRoute[]> {
  const sites = await getPrisma().classroomSite.findMany({
    where: { custom_domain: { not: null } },
    select: {
      subdomain: true,
      custom_domain: true,
      is_enabled: true,
      classroom: {
        select: {
          is_archived: true,
          status: true,
          memberships: {
            where: { role: 'OWNER', has_accepted_invite: true },
            select: {
              user: {
                select: { subscriptions: { orderBy: { created_at: 'desc' }, take: 1 } },
              },
            },
          },
        },
      },
    },
  });

  const now = Date.now();
  return sites.flatMap(site => {
    if (!site.custom_domain) return [];

    // Same rule as getProStateForClassroomId — any accepted owner with a live
    // PRO row wins — evaluated inline so this stays one query for the whole map.
    const proActive = site.classroom.memberships.some(membership => {
      const subscription = membership.user.subscriptions[0];
      if (!subscription || subscription.tier !== 'PRO') return false;
      return subscription.ends_at === null || new Date(subscription.ends_at).getTime() > now;
    });

    return [
      {
        domain: site.custom_domain,
        subdomain: site.subdomain,
        active:
          proActive &&
          site.is_enabled &&
          !site.classroom.is_archived &&
          site.classroom.status !== 'UNPUBLISHED',
      },
    ];
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

// Only the fields a visibility decision, a link, or a redacted placeholder's
// date needs. Notably absent: a repository's attached resources and quizzes,
// and — the point of the narrow `assignments` select — every assignment column
// except the deadline. An anonymous request loads DATES, never coursework text,
// so no query on this path can put an assignment title in the process at all.
const SITE_ITEM_INCLUDE = {
  page: { select: { id: true, title: true, slug: true, is_draft: true, is_public: true } },
  slide: { select: { id: true, title: true, slug: true, is_draft: true, is_public: true } },
  repository: {
    select: {
      id: true,
      title: true,
      is_published: true,
      // Published only, mirroring the student module tree: a placeholder must
      // never show a date off an assignment an enrolled student cannot see.
      assignments: { where: { is_published: true }, select: { student_deadline: true } },
    },
  },
  quiz: { select: { id: true, name: true, status: true, due_date: true } },
} satisfies Prisma.ModuleItemInclude;

type SiteModuleItem = Prisma.ModuleItemGetPayload<{ include: typeof SITE_ITEM_INCLUDE }>;
type SiteModule = Prisma.ModuleGetPayload<{
  include: { items: { include: typeof SITE_ITEM_INCLUDE } };
}>;

/** An item this viewer may open: carries its target, and renders as a link. */
export type SiteScheduleVisibleItem = SiteModuleItem & { kind: 'visible' };

/**
 * An item this viewer may NOT open, kept in place rather than deleted.
 *
 * Deliberately not a narrowed `SiteModuleItem`: it is BUILT from three fields
 * rather than derived by omitting the rest, so the only way a title, slug,
 * template or link could reach an anonymous renderer is if someone added it to
 * this type on purpose. `id` is the ModuleItem's own uuid — a React key, not a
 * content identifier, and it resolves to nothing without a session.
 */
export type SiteSchedulePlaceholderItem = {
  kind: 'placeholder';
  id: string;
  item_type: ModuleItemType;
  /** The item's deadline when it has one; null for pages and slides, which never do. */
  due_at: Date | null;
};

export type SiteScheduleItem = SiteScheduleVisibleItem | SiteSchedulePlaceholderItem;
export type SiteScheduleModule = Omit<SiteModule, 'items'> & { items: SiteScheduleItem[] };

/**
 * The date a placeholder is allowed to show.
 *
 * A deadline is not a content identifier — "something is due Sep 12" says the
 * course has a rhythm, not what the work is — and it is the one fact that makes
 * a redacted row useful to a prospective student reading the public schedule.
 *
 * Repositories reduce to their EARLIEST published assignment deadline, the same
 * reduction the admin repo summary makes ("earliest assignment deadline =
 * repository due date"). Quizzes carry their own. Pages and slides have no
 * date at all, and get a bare placeholder.
 */
function placeholderDueAt(item: SiteModuleItem): Date | null {
  if (item.item_type === 'QUIZ') return item.quiz?.due_date ?? null;
  if (item.item_type !== 'REPOSITORY') return null;

  const deadlines = (item.repository?.assignments ?? [])
    .map(assignment => assignment.student_deadline)
    .filter((deadline): deadline is Date => deadline !== null);

  if (deadlines.length === 0) return null;
  return deadlines.reduce((earliest, deadline) => (deadline < earliest ? deadline : earliest));
}

/**
 * The classroom's modules as this viewer may see them.
 *
 * A module reaches the site only when `is_published && is_public` — both flags,
 * so a public site can never expose coursework that was only ever meant for
 * enrolled students.
 *
 * Items are then resolved per viewer. Members get the app's ordinary
 * isItemPublished, and modules left with nothing are dropped, exactly as
 * before. An ANONYMOUS visitor gets a three-way split:
 *
 *   - isItemPubliclyVisible          → the item itself (a public page or deck)
 *   - published but not public       → a placeholder: type and date only
 *   - not published at all           → nothing
 *
 * That last line is the one worth stating out loud. A draft page, a DRAFT quiz
 * or an unpublished repo is invisible to enrolled students too, so a
 * placeholder for it would advertise unreleased coursework to the open web —
 * strictly worse than the leak this function exists to prevent.
 *
 * The middle case is a reversal of the old behaviour, which dropped
 * members-only items and then dropped any module they emptied. That hid the
 * course's SHAPE, not just its contents: a "Welcome" module holding one repo
 * rendered as "Nothing has been published yet", which is both wrong and
 * useless to the audience a public site is for. Structure — how many units,
 * what kinds of work, when things are due — is exactly what a prospective
 * student should see; the titles are what they should not.
 */
export async function listPublicModulesForViewer(
  classroomId: string,
  role: SiteViewerRole
): Promise<SiteScheduleModule[]> {
  const modules = await getPrisma().module.findMany({
    where: { classroom_id: classroomId, is_published: true, is_public: true },
    include: { items: { orderBy: { position: 'asc' }, include: SITE_ITEM_INCLUDE } },
    // Same ordering the app uses for modules everywhere else.
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });

  if (role !== null) {
    return modules
      .map(module => ({
        ...module,
        items: module.items
          .filter(isItemPublished)
          .map((item): SiteScheduleItem => ({ ...item, kind: 'visible' })),
      }))
      .filter(module => module.items.length > 0);
  }

  return modules.map(module => ({
    ...module,
    // flatMap, not filter+map: the empty array is how "not published, so not
    // even a placeholder" is expressed, and item ORDER is preserved throughout
    // so placeholders sit at the positions the instructor put them.
    items: module.items.flatMap((item): SiteScheduleItem[] => {
      if (isItemPubliclyVisible(item)) return [{ ...item, kind: 'visible' }];
      if (!isItemPublished(item)) return [];
      return [
        {
          kind: 'placeholder',
          id: item.id,
          item_type: item.item_type,
          due_at: placeholderDueAt(item),
        },
      ];
    }),
  }));
}
