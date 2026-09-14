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

/** Count timestamps per bin. Anything outside the window is dropped. */
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
