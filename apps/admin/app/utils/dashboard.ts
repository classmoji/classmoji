/**
 * Pure helpers behind the platform dashboard. No Prisma here so they can be
 * unit-tested; the loader in routes/_shell._index/route.server.ts does the
 * queries and hands rows to these.
 */

export interface WeekBin {
  start: Date;
  end: Date;
}

/** `weeks` consecutive 7-day bins ending now, oldest first. */
export const buildWeeklyBins = (now: Date, weeks: number): WeekBin[] => {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const bins: WeekBin[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(now.getTime() - i * weekMs);
    bins.push({ start: new Date(end.getTime() - weekMs), end });
  }
  return bins;
};

/** `days` consecutive 24-hour bins ending now, oldest first. */
export const buildDailyBins = (now: Date, days: number): WeekBin[] => {
  const dayMs = 24 * 60 * 60 * 1000;
  const bins: WeekBin[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const end = new Date(now.getTime() - i * dayMs);
    bins.push({ start: new Date(end.getTime() - dayMs), end });
  }
  return bins;
};

/** Count timestamps per bin (weekly or daily). Anything outside the window is dropped. */
export const countByWeek = (timestamps: Date[], bins: WeekBin[]): number[] => {
  const counts = new Array<number>(bins.length).fill(0);
  for (const ts of timestamps) {
    const t = ts.getTime();
    const idx = bins.findIndex(b => t >= b.start.getTime() && t < b.end.getTime());
    if (idx >= 0) counts[idx] += 1;
  }
  return counts;
};

/** Mailbox providers: real people, but not a school. */
const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

/** Second labels under which a two-letter TLD is itself a registry (ox.ac.uk). */
const PUBLIC_SECOND_LABELS = new Set(['ac', 'edu', 'co', 'com', 'org', 'gov', 'net']);

/**
 * The part of a mail domain that names the institution: `ift.ulaval.ca` and
 * `ulaval.ca` are one school, and so are `cs.ox.ac.uk` and `ox.ac.uk`.
 */
export const registrableDomain = (domain: string): string => {
  const labels = domain.trim().toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const [tld, second] = [labels[labels.length - 1], labels[labels.length - 2]];
  const keep = tld.length === 2 && PUBLIC_SECOND_LABELS.has(second) ? 3 : 2;
  return labels.slice(-keep).join('.');
};

export const PERSONAL_EMAIL_LABEL = 'Personal email';

export interface SchoolRow {
  school: string;
  users: number;
  instructors: number;
}

/**
 * Fold raw per-domain counts into per-school rows, largest first, with every
 * mailbox provider merged into one trailing "Personal email" row.
 */
export const collapseSchools = (
  rows: Array<{ domain: string; users: number; instructors: number }>,
  limit: number
): SchoolRow[] => {
  const bySchool = new Map<string, SchoolRow>();
  let personal: SchoolRow | null = null;

  for (const row of rows) {
    const school = registrableDomain(row.domain);
    if (!school) continue;
    if (PERSONAL_DOMAINS.has(school)) {
      personal ??= { school: PERSONAL_EMAIL_LABEL, users: 0, instructors: 0 };
      personal.users += row.users;
      personal.instructors += row.instructors;
      continue;
    }
    const acc = bySchool.get(school) ?? { school, users: 0, instructors: 0 };
    acc.users += row.users;
    acc.instructors += row.instructors;
    bySchool.set(school, acc);
  }

  const schools = [...bySchool.values()]
    .sort((a, b) => b.users - a.users || a.school.localeCompare(b.school))
    .slice(0, limit);
  return personal ? [...schools, personal] : schools;
};

// ───────── countries ─────────

/**
 * Country-code TLDs to names. Not exhaustive; anything missing renders as the
 * upper-cased code, which is still more useful than "Unknown".
 */
const CC_TLD: Record<string, string> = {
  ar: 'Argentina',
  at: 'Austria',
  au: 'Australia',
  be: 'Belgium',
  br: 'Brazil',
  ca: 'Canada',
  ch: 'Switzerland',
  cl: 'Chile',
  cn: 'China',
  co: 'Colombia',
  cz: 'Czechia',
  de: 'Germany',
  dk: 'Denmark',
  eg: 'Egypt',
  es: 'Spain',
  fi: 'Finland',
  fr: 'France',
  gh: 'Ghana',
  gr: 'Greece',
  hk: 'Hong Kong',
  hu: 'Hungary',
  id: 'Indonesia',
  ie: 'Ireland',
  il: 'Israel',
  in: 'India',
  it: 'Italy',
  jp: 'Japan',
  ke: 'Kenya',
  kr: 'South Korea',
  ma: 'Morocco',
  mx: 'Mexico',
  my: 'Malaysia',
  ng: 'Nigeria',
  nl: 'Netherlands',
  no: 'Norway',
  nz: 'New Zealand',
  pe: 'Peru',
  ph: 'Philippines',
  pk: 'Pakistan',
  pl: 'Poland',
  pt: 'Portugal',
  ro: 'Romania',
  rw: 'Rwanda',
  sa: 'Saudi Arabia',
  se: 'Sweden',
  sg: 'Singapore',
  sn: 'Senegal',
  th: 'Thailand',
  tn: 'Tunisia',
  tr: 'Turkey',
  tw: 'Taiwan',
  ua: 'Ukraine',
  uk: 'United Kingdom',
  us: 'United States',
  vn: 'Vietnam',
  za: 'South Africa',
};

/** US-administered generic TLDs: an .edu is a US school in practice. */
const US_TLDS = new Set(['edu', 'gov', 'mil']);

export const UNKNOWN_COUNTRY = 'Unknown';

/** Best-effort country for a mail domain from its TLD alone. */
export const countryForDomain = (domain: string): string => {
  const tld = domain.trim().toLowerCase().split('.').filter(Boolean).at(-1) ?? '';
  if (US_TLDS.has(tld)) return CC_TLD.us;
  if (tld.length === 2) return CC_TLD[tld] ?? tld.toUpperCase();
  return UNKNOWN_COUNTRY;
};

export interface CountryRow {
  country: string;
  users: number;
  instructors: number;
}

/** Per-country totals, largest first, mailbox providers excluded, Unknown last. */
export const rollupCountries = (
  rows: Array<{ domain: string; users: number; instructors: number }>
): CountryRow[] => {
  const byCountry = new Map<string, CountryRow>();
  for (const row of rows) {
    const school = registrableDomain(row.domain);
    if (!school || PERSONAL_DOMAINS.has(school)) continue;
    const country = countryForDomain(school);
    const acc = byCountry.get(country) ?? { country, users: 0, instructors: 0 };
    acc.users += row.users;
    acc.instructors += row.instructors;
    byCountry.set(country, acc);
  }
  return [...byCountry.values()].sort((a, b) => {
    if (a.country === UNKNOWN_COUNTRY) return 1;
    if (b.country === UNKNOWN_COUNTRY) return -1;
    return b.users - a.users || a.country.localeCompare(b.country);
  });
};

// ───────── class sizes ─────────

export const SIZE_BUCKETS = [
  { label: '0', min: 0, max: 0 },
  { label: '1–10', min: 1, max: 10 },
  { label: '11–30', min: 11, max: 30 },
  { label: '31–100', min: 31, max: 100 },
  { label: '100+', min: 101, max: Infinity },
] as const;

/** Count classrooms per student-count bucket, in SIZE_BUCKETS order. */
export const bucketClassSizes = (sizes: number[]): number[] =>
  SIZE_BUCKETS.map(b => sizes.filter(n => n >= b.min && n <= b.max).length);

// ───────── medians ─────────

/** Median of a list, or null when empty. Interpolates between the two middles. */
export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** "3.5h", "2d", "3w": a duration in hours as one short unit. */
export const formatHours = (hours: number | null): string => {
  if (hours === null) return '—';
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 21) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
};
