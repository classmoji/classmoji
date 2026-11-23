/**
 * Team repo contributions: what the `calculate_repo_contributions` Trigger task
 * stores in `git_repos.contribution_stats`, read by the repository page and the
 * MCP `repo_contributions` tool.
 *
 * Lines are the repo's current code by who last wrote each line (`git blame`
 * on the default branch); commits, additions and deletions come from its
 * history. The repo's root commit is the starter code a teacher's template put
 * there, so its lines and its commit are counted apart as `starter_lines` and
 * never credited to anyone.
 */

export const REPO_CONTRIBUTIONS_VERSION = 1;

export interface RepoContributionAuthor {
  /** The classroom member the author was matched to (git username or email), else null. */
  user_id: string | null;
  /** The git author name, as the commits give it. */
  git_name: string;
  /** The git author email, as the commits give it. */
  git_email: string | null;
  /** Lines of the current code this author last wrote. */
  lines: number;
  commits: number;
  additions: number;
  deletions: number;
  /** ISO timestamps of the author's first and last commit (author date). */
  first_commit_at: string | null;
  last_commit_at: string | null;
}

/** One student commit, for the CSV export and the MCP commit list. */
export interface RepoContributionCommit {
  sha: string;
  /** ISO author date. */
  date: string;
  /** The classroom member the author was matched to, else null. */
  user_id: string | null;
  /** The author's Github login when Github knew it. */
  login: string | null;
  git_name: string;
  git_email: string | null;
  /** The commit's subject line. */
  message: string;
  additions: number;
  deletions: number;
}

/** At most this many commits are kept per repo (newest first). */
export const MAX_STORED_COMMITS = 5000;

export interface RepoContributions {
  version: typeof REPO_CONTRIBUTIONS_VERSION;
  /** The commit the numbers describe. */
  head_sha: string | null;
  /** Lines credited to authors (starter lines excluded). */
  total_lines: number;
  /** Lines still unchanged from the starter code (the root commit). */
  starter_lines: number;
  /** Commits excluding the starter commit and merges. */
  total_commits: number;
  /** Text files read for lines; files over the cap were left out. */
  files_counted: number;
  files_skipped: number;
  /** Most lines first. */
  authors: RepoContributionAuthor[];
  /**
   * Student commits, newest first (starter code and merges left out), at most
   * MAX_STORED_COMMITS. Stored with the summary but read separately
   * (`readContributionCommits`): pages never carry them.
   */
  commits?: RepoContributionCommit[];
  /** True when the repo had more commits than were kept. */
  commits_truncated?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * The stored JSON as a `RepoContributions`, or null for anything else (an
 * unknown version, a hand-edited row). Readers never trust the column's shape.
 */
export function readRepoContributions(value: unknown): RepoContributions | null {
  if (!isObject(value) || value.version !== REPO_CONTRIBUTIONS_VERSION) return null;
  if (!Array.isArray(value.authors)) return null;
  const authors: RepoContributionAuthor[] = value.authors.filter(isObject).map(a => ({
    user_id: str(a.user_id),
    git_name: str(a.git_name) ?? 'unknown',
    git_email: str(a.git_email),
    lines: num(a.lines),
    commits: num(a.commits),
    additions: num(a.additions),
    deletions: num(a.deletions),
    first_commit_at: str(a.first_commit_at),
    last_commit_at: str(a.last_commit_at),
  }));
  return {
    version: REPO_CONTRIBUTIONS_VERSION,
    head_sha: str(value.head_sha),
    total_lines: num(value.total_lines),
    starter_lines: num(value.starter_lines),
    total_commits: num(value.total_commits),
    files_counted: num(value.files_counted),
    files_skipped: num(value.files_skipped),
    authors,
  };
}

/** An author's share of the credited lines, 0 to 100, rounded. */
export function lineShare(author: Pick<RepoContributionAuthor, 'lines'>, totalLines: number) {
  return totalLines > 0 ? Math.round((author.lines / totalLines) * 100) : 0;
}

/**
 * The stored commit list, or [] when the row has none (calculated before
 * commits were kept, or another version). Like `readRepoContributions`, it
 * never trusts the column's shape.
 */
export function readContributionCommits(value: unknown): RepoContributionCommit[] {
  if (!isObject(value) || value.version !== REPO_CONTRIBUTIONS_VERSION) return [];
  if (!Array.isArray(value.commits)) return [];
  return value.commits.filter(isObject).map(c => ({
    sha: str(c.sha) ?? '',
    date: str(c.date) ?? '',
    user_id: str(c.user_id),
    login: str(c.login),
    git_name: str(c.git_name) ?? 'unknown',
    git_email: str(c.git_email),
    message: str(c.message) ?? '',
    additions: num(c.additions),
    deletions: num(c.deletions),
  }));
}
