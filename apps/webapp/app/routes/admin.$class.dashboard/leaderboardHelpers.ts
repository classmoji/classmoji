export interface LeaderboardEntry {
  name?: string | null;
  login?: string | null;
}

/**
 * Two-letter initials for a leaderboard avatar fallback.
 * Null-safe: name and login may be null/undefined; defaults to '?'.
 */
export const initialsFor = (entry: LeaderboardEntry): string => {
  const base = (entry.name || entry.login || '?').trim();
  const parts = base.split(/\s+/);
  return (parts[0]?.[0] || '?') + (parts[1]?.[0] || '');
};

const TINTS = [
  'bg-stone-900 text-white',
  'bg-emerald-100 text-emerald-700',
  'bg-violet-100 text-violet-700',
  'bg-rose-100 text-rose-700',
  'bg-sky-100 text-sky-700',
  'bg-amber-100 text-amber-700',
];

export const avatarTintFor = (i: number): string => TINTS[i % TINTS.length];
