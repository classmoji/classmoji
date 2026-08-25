/**
 * The Website tab's decisions, as pure functions.
 *
 * The route is a form; these are the four judgements inside it that are worth
 * testing without a browser — what to pre-fill, when the enable switch may be
 * touched, what to warn about the chosen home page, and which time zones to
 * offer.
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

/**
 * A curated shortlist of IANA zones, NOT the ~450 `Intl.supportedValuesOf`
 * returns.
 *
 * The full list is unusable in a dropdown and mostly consists of aliases and
 * zones no course runs in; this covers the campuses Classmoji actually serves
 * plus one entry per major region, which is the difference between scrolling
 * and searching. `UTC` leads it because it is the fallback the schedule uses
 * when nothing is set, so choosing it deliberately is a real answer.
 *
 * Not a validation boundary. `upsertSiteSettings` validates against the
 * runtime's own tz data, so a zone reaching the column by any other route (an
 * MCP tool, a script, an import) is accepted on its own merits — which is why
 * `timezoneOptions` carries the stored value through rather than dropping it.
 *
 * Every entry must be the CANONICAL spelling for the server's tz data, because
 * that is what `upsertSiteSettings` writes: submit `Asia/Kolkata` and the
 * column ends up holding `Asia/Calcutta`, and the Select can no longer match
 * its own option against the saved value. Two entries therefore look dated —
 * `Asia/Calcutta` and `America/Buenos_Aires` — and they are correct anyway.
 * siteSettings.test.ts pins this against Intl, so an ICU update that changes a
 * canonical form fails loudly instead of quietly breaking one dropdown.
 *
 * Kept as literal strings rather than canonicalized at runtime for the same
 * reason: this function also runs in the BROWSER, whose ICU may not agree with
 * the server's, and a list that differs between the two renderings is a
 * hydration mismatch plus a control that cannot display its own value.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  'UTC',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'America/Buenos_Aires',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Zurich',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Africa/Casablanca',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Nairobi',
  'Africa/Johannesburg',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Calcutta',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** One `<Select>` option. */
export interface TimezoneOption {
  value: string;
  label: string;
}

/**
 * The zones to offer, with the site's stored value guaranteed to be among them.
 *
 * That guarantee is the whole reason this is a function. An antd `Select` whose
 * `value` matches no option renders the raw string with no label and looks
 * broken, so a site whose zone was set outside this list — by an MCP tool, by a
 * script, or simply by a later release trimming an entry — would show its
 * configuration as if it were corrupt. Carrying it through instead means the
 * control can always display what is actually stored, and the admin can still
 * change it.
 *
 * Labels swap underscores for spaces (`America/New_York` → `America/New York`)
 * rather than mapping each zone to a prettier name. A hand-written display name
 * per zone is a second list to keep in sync with the first, and the IANA name is
 * the thing being stored — showing it keeps the control honest about that.
 */
export function timezoneOptions(current: string | null | undefined): TimezoneOption[] {
  const zones = [...COMMON_TIMEZONES];
  const stored = (current ?? '').trim();
  if (stored && !zones.includes(stored)) zones.push(stored);

  return zones.map(zone => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}
