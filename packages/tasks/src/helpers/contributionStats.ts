/**
 * The pure half of the `calculate_repo_contributions` task: parse what git
 * prints and add it up per author. No git, no database: tested on its own.
 */
import {
  MAX_STORED_COMMITS,
  REPO_CONTRIBUTIONS_VERSION,
  type RepoContributionAuthor,
  type RepoContributionCommit,
  type RepoContributions,
} from '@classmoji/utils/repo-contributions';

/** One line of the current code, by the commit that last changed it. */
export interface BlameLine {
  sha: string;
  name: string;
  email: string | null;
}

/** One commit of the default branch's history. */
export interface LogCommit {
  sha: string;
  name: string;
  email: string | null;
  /** ISO author date. */
  date: string;
  parents: string[];
  /** The subject line. */
  message: string;
  additions: number;
  deletions: number;
}

/** Field and record separators for `git log --format`; neither appears in a name or an email. */
export const LOG_FIELD = '\x1f';
export const LOG_RECORD = '\x1e';
// The subject last: whatever it contains, the fields before it are fixed.
export const LOG_FORMAT = `${LOG_RECORD}%H${LOG_FIELD}%an${LOG_FIELD}%ae${LOG_FIELD}%aI${LOG_FIELD}%P${LOG_FIELD}%s`;

const SHA = /^[0-9a-f]{40}(?: |$)/;

/** `<x@y>` → `x@y`; git prints `<>` for an author with no email. */
function unwrapMail(value: string): string | null {
  const email = value.replace(/^<|>$/g, '').trim();
  return email || null;
}

/**
 * Parse `git blame --line-porcelain` into one entry per line of the file.
 * Every line block repeats the commit's author fields, so no state carries
 * from one block to the next beyond the sha.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let sha = '';
  let name = '';
  let email: string | null = null;
  for (const raw of output.split('\n')) {
    if (raw.startsWith('\t')) {
      if (sha) lines.push({ sha, name, email });
      continue;
    }
    if (SHA.test(raw)) {
      sha = raw.slice(0, 40);
      name = '';
      email = null;
    } else if (raw.startsWith('author-mail ')) {
      email = unwrapMail(raw.slice('author-mail '.length));
    } else if (raw.startsWith('author ')) {
      name = raw.slice('author '.length);
    }
  }
  return lines;
}

/**
 * Parse `git log --format=<LOG_FORMAT> --numstat`. A binary file's numstat is
 * `-\t-\tpath`, counted as nothing.
 */
export function parseLog(output: string): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split(LOG_RECORD)) {
    if (!record.trim()) continue;
    const [header, ...rest] = record.split('\n');
    const [sha, name, email, date, parents, ...subject] = header.split(LOG_FIELD);
    if (!sha || !SHA.test(sha)) continue;
    let additions = 0;
    let deletions = 0;
    for (const row of rest) {
      const m = row.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      additions += m[1] === '-' ? 0 : Number(m[1]);
      deletions += m[2] === '-' ? 0 : Number(m[2]);
    }
    commits.push({
      sha,
      name: name ?? '',
      email: email?.trim() || null,
      date: date ?? '',
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      message: subject.join(LOG_FIELD),
      additions,
      deletions,
    });
  }
  return commits;
}

/** Lock files, build output and dependencies: generated, so they credit nobody. */
const SKIPPED_PATHS = [
  /(^|\/)(node_modules|dist|build|out|vendor|\.venv|venv|__pycache__|\.next|target|coverage)\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /\.(min\.js|min\.css|map)$/,
];

export function isCountedPath(path: string): boolean {
  return !SKIPPED_PATHS.some(re => re.test(path));
}

/** Who an author is: the classroom member it matched, else its email, else its name. */
function authorKey(userId: string | null, name: string, email: string | null): string {
  if (userId) return `u:${userId}`;
  if (email) return `e:${email.toLowerCase()}`;
  return `n:${name.trim().toLowerCase()}`;
}

export interface AggregateInput {
  headSha: string | null;
  blame: BlameLine[];
  commits: LogCommit[];
  filesCounted: number;
  filesSkipped: number;
  /** The classroom member a commit's author is (by sha, then name and email), or null. */
  resolveUser: (commit: { sha: string; name: string; email: string | null }) => string | null;
  /**
   * Starter code besides the root commit: the template's history pushed with
   * it, and Classmoji's own commits (see `isStudentCommit`).
   */
  isStarterCommit?: (commit: LogCommit) => boolean;
  /** The author's Github login for a commit, when Github knew it. */
  loginFor?: (sha: string) => string | null;
}

/**
 * Add lines and commits up per author. Starter code (the root commit, and
 * whatever `isStarterCommit` says) is no one's: its lines are
 * `starter_lines` and its commits are not counted. Merge commits are no one's
 * commit either; the work in them is counted on the commits they merge.
 */
export function aggregateContributions(input: AggregateInput): RepoContributions {
  const starter = new Set(
    input.commits.filter(c => c.parents.length === 0 || input.isStarterCommit?.(c)).map(c => c.sha)
  );
  const userBySha = new Map<string, string | null>();
  const userFor = (c: { sha: string; name: string; email: string | null }) => {
    if (!userBySha.has(c.sha)) userBySha.set(c.sha, input.resolveUser(c));
    return userBySha.get(c.sha) ?? null;
  };

  const authors = new Map<string, RepoContributionAuthor>();
  const authorFor = (c: { sha: string; name: string; email: string | null }) => {
    const userId = userFor(c);
    const key = authorKey(userId, c.name, c.email);
    let row = authors.get(key);
    if (!row) {
      row = {
        user_id: userId,
        git_name: c.name || 'unknown',
        git_email: c.email,
        lines: 0,
        commits: 0,
        additions: 0,
        deletions: 0,
        first_commit_at: null,
        last_commit_at: null,
      };
      authors.set(key, row);
    }
    return row;
  };

  let starterLines = 0;
  let totalLines = 0;
  for (const line of input.blame) {
    if (starter.has(line.sha)) {
      starterLines += 1;
      continue;
    }
    authorFor(line).lines += 1;
    totalLines += 1;
  }

  let totalCommits = 0;
  const commits: RepoContributionCommit[] = [];
  for (const c of input.commits) {
    if (starter.has(c.sha) || c.parents.length !== 1) continue; // starter code, or a merge
    const row = authorFor(c);
    // git log lists newest first, so the cap keeps the most recent work.
    if (commits.length < MAX_STORED_COMMITS) {
      commits.push({
        sha: c.sha,
        date: c.date,
        user_id: row.user_id,
        login: input.loginFor?.(c.sha) ?? null,
        git_name: c.name || 'unknown',
        git_email: c.email,
        message: c.message.slice(0, 300),
        additions: c.additions,
        deletions: c.deletions,
      });
    }
    row.commits += 1;
    row.additions += c.additions;
    row.deletions += c.deletions;
    totalCommits += 1;
    const at = new Date(c.date);
    if (Number.isNaN(at.getTime())) continue;
    const iso = at.toISOString();
    if (!row.first_commit_at || iso < row.first_commit_at) row.first_commit_at = iso;
    if (!row.last_commit_at || iso > row.last_commit_at) row.last_commit_at = iso;
  }

  return {
    version: REPO_CONTRIBUTIONS_VERSION,
    head_sha: input.headSha,
    total_lines: totalLines,
    starter_lines: starterLines,
    total_commits: totalCommits,
    files_counted: input.filesCounted,
    files_skipped: input.filesSkipped,
    authors: [...authors.values()]
      .filter(a => a.lines > 0 || a.commits > 0)
      .sort((a, b) => b.lines - a.lines || b.commits - a.commits),
    commits,
    commits_truncated: totalCommits > commits.length,
  };
}
