/**
 * The Website tab's decisions, as pure functions.
 *
 * The route is a form; these are the three judgements inside it that are worth
 * testing without a browser — what to pre-fill, when the enable switch may be
 * touched, and what to warn about the chosen home page.
 */

import { isValidSubdomain, normalizeSubdomain, RESERVED_SUBDOMAINS } from '@classmoji/utils';

/** The page fields the Website tab reads. */
export interface SitePageOption {
  id: string;
  title: string;
  is_public: boolean;
}

/**
 * The subdomain to pre-fill the claim field with, or '' for "leave it blank".
 *
 * Classroom slugs are globally unique and already lowercase-and-hyphen, so the
 * common case is a one-click claim. But a slug is only DNS-shaped by
 * convention: it has no length ceiling of 63, and nothing stops a class being
 * slugged `api` or `docs`. Offering one of those would put a rejection in the
 * box before the instructor has typed anything, so both are filtered out here
 * rather than surfaced as an error later.
 *
 * NOT a claim of availability — that is the API route's job, and the field is
 * checked as soon as it renders.
 */
export function suggestSubdomainFromSlug(slug: string | null | undefined): string {
  const label = normalizeSubdomain(slug);
  if (!isValidSubdomain(label)) return '';
  if (RESERVED_SUBDOMAINS.has(label)) return '';
  return label;
}

/**
 * May the enable switch be operated?
 *
 * Mirrors the service's HOME_PAGE_REQUIRED invariant so the switch is disabled
 * rather than rejected — the same rule stated twice, deliberately: the service
 * check is the one that is true for every caller, this one is the one that
 * explains itself before the click. A site that is ALREADY enabled always
 * stays operable, so an admin can always switch it back off (upsertSiteSettings
 * permits disabling without a home page; it is only enabling that requires one).
 */
export function canToggleSiteEnabled(
  site: { is_enabled: boolean; home_page_id: string | null } | null
): boolean {
  if (!site) return false;
  return site.is_enabled || Boolean(site.home_page_id);
}

/**
 * The warning to show under the home page select, or null.
 *
 * A members-only home page is a legal, sometimes deliberate configuration — a
 * course can put its syllabus behind sign-in — so this is a hint, never an
 * error. An unknown id (the page was deleted out from under the site, FK SET
 * NULL not yet observed) says nothing rather than guessing.
 */
export function homePageNotice(
  pages: SitePageOption[],
  homePageId: string | null | undefined
): string | null {
  if (!homePageId) return null;
  const page = pages.find(option => option.id === homePageId);
  if (!page || page.is_public) return null;
  return 'This page is members-only — anonymous visitors will see a sign-in landing.';
}
