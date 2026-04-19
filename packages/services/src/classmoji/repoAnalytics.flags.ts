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
