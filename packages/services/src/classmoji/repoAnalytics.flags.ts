import type {
  CommitRecord,
  ContributorRecord,
} from './repoAnalytics.types.ts';

/**
 * Ratio of commits after deadline over total commits.
 * Returns 0 when there are no commits or no deadline.
 */
export function lateCommitRatio(
  commits: CommitRecord[],
  deadline: Date | null,
): number {
  if (!commits.length || !deadline) return 0;
  const cutoff = deadline.getTime();
  const late = commits.filter((c) => new Date(c.ts).getTime() > cutoff).length;
  return late / commits.length;
}

/**
 * True when a single commit's (additions + deletions) is more than 40%
 * of the total (additions + deletions) across all commits.
 */
export function isMegaCommit(
  commit: CommitRecord,
  totalAdditions: number,
  totalDeletions: number,
): boolean {
  const total = totalAdditions + totalDeletions;
  if (total <= 0) return false;
  const size = commit.additions + commit.deletions;
  return size / total > 0.4;
}

const FILLER = /^(update|fix|wip|stuff|changes?|tweak|small\s*fix)\.?$/i;

/**
 * Heuristic quality score in [0, 1] for a commit message.
 * - base 0.5
 * - penalize common filler verbs alone
 * - penalize length < 10 chars
 * - reward length >= 20 chars
 */
export function commitMessageQuality(message: string): number {
  const m = message.trim();
  if (!m) return 0;
  let score = 0.5;
  if (FILLER.test(m)) score -= 0.3;
  if (m.length < 10) score -= 0.2;
  if (m.length >= 20) score += 0.2;
  return Math.max(0, Math.min(1, score));
}

/**
 * Average commitMessageQuality across the given commits.
 * Returns 0 when there are no commits.
 */
export function averageCommitQuality(commits: CommitRecord[]): number {
  if (!commits.length) return 0;
  const sum = commits.reduce(
    (acc, c) => acc + commitMessageQuality(c.message),
    0,
  );
  return sum / commits.length;
}

/**
 * Returns null when there is one or zero contributors.
 * Otherwise returns the contributor with the largest commit share.
 */
export function busFactor(
  contributors: ContributorRecord[],
): { login: string; share: number } | null {
  if (contributors.length <= 1) return null;
  const total = contributors.reduce((acc, c) => acc + c.commits, 0);
  if (total <= 0) return null;
  let top = contributors[0]!;
  for (const c of contributors) {
    if (c.commits > top.commits) top = c;
  }
  return { login: top.login, share: top.commits / total };
}

/**
 * True when the first (earliest) commit is less than 24h before the deadline
 * AND at least 1 commit exists. Signals last-minute "dump and run" behavior.
 */
export function dumpAndRun(
  commits: CommitRecord[],
  deadline: Date | null,
): boolean {
  if (!commits.length || !deadline) return false;
  const earliest = commits.reduce((min, c) => {
    const t = new Date(c.ts).getTime();
    return t < min ? t : min;
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(earliest)) return false;
  const msBefore = deadline.getTime() - earliest;
  const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
  return msBefore < TWENTY_FOUR_H;
}

/**
 * Aggregate commits by contributor login.
 * Returns rows sorted descending by commit count.
 * Commits with null author_login are bucketed under 'unknown'.
 */
export function aggregateByContributor(commits: CommitRecord[]): Array<{
  login: string;
  commits: number;
  additions: number;
  deletions: number;
}> {
  const acc = new Map<
    string,
    { login: string; commits: number; additions: number; deletions: number }
  >();
  for (const c of commits) {
    const login = c.author_login ?? 'unknown';
    const existing = acc.get(login);
    if (existing) {
      existing.commits += 1;
      existing.additions += c.additions;
      existing.deletions += c.deletions;
    } else {
      acc.set(login, {
        login,
        commits: 1,
        additions: c.additions,
        deletions: c.deletions,
      });
    }
  }
  return Array.from(acc.values()).sort((a, b) => b.commits - a.commits);
}

/**
 * Per-day buckets stacked by contributor. Returns rows suitable for a
 * Recharts stacked BarChart: `{ day: '2026-04-15', alice: 2, bob: 1, ... }`.
 * - One row per UTC day between first and last commit (inclusive).
 * - Missing authors in a day are filled with 0.
 * - Day bucketing uses the ISO date slice (0,10) of `ts`.
 * - Returns [] when no commits.
 */
export function commitsPerDayByContributor(
  commits: CommitRecord[],
): Array<{ day: string } & Record<string, number>> {
  if (!commits.length) return [];

  const logins = new Set<string>();
  const counts = new Map<string, Map<string, number>>(); // day -> login -> count
  let minDay = '9999-99-99';
  let maxDay = '0000-00-00';

  for (const c of commits) {
    const day = c.ts.slice(0, 10);
    const login = c.author_login ?? 'unknown';
    logins.add(login);
    if (day < minDay) minDay = day;
    if (day > maxDay) maxDay = day;
    let dayMap = counts.get(day);
    if (!dayMap) {
      dayMap = new Map<string, number>();
      counts.set(day, dayMap);
    }
    dayMap.set(login, (dayMap.get(login) ?? 0) + 1);
  }

  // Iterate UTC days between minDay and maxDay.
  const toMs = (d: string): number => {
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, dd);
  };
  const fromMs = (ms: number): string => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const startMs = toMs(minDay);
  const endMs = toMs(maxDay);
  const DAY_MS = 86400000;

  const rows: Array<{ day: string } & Record<string, number>> = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const day = fromMs(ms);
    const dayMap = counts.get(day);
    const row: Record<string, string | number> = { day };
    for (const login of logins) {
      row[login] = dayMap?.get(login) ?? 0;
    }
    rows.push(row as { day: string } & Record<string, number>);
  }
  return rows;
}
