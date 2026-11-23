/**
 * Team repo commits, one row per student commit across every team repo of a
 * repository: the repository page's "Export commits (CSV)" and the MCP
 * `repo_contributions_commits` tool read the same rows.
 *
 * The rows come from the last contributions calculation (the commits the
 * `calculate_repo_contributions` task stored with the summary), read by the
 * caller's classroom id AND the repository id. An author is named only while a
 * member of THAT classroom; anyone else shows by git name and email only.
 */
import getPrisma from '@classmoji/database';
import { toCsv } from '@classmoji/utils';
import {
  readContributionCommits,
  REPO_CONTRIBUTIONS_VERSION,
} from '@classmoji/utils/repo-contributions';

export interface ContributionCommitRow {
  team: string | null;
  repo: string;
  /** ISO author date. */
  date: string;
  /** Classmoji name, when the author is a member of this classroom. */
  student: string | null;
  user_id: string | null;
  github_login: string | null;
  git_name: string;
  git_email: string | null;
  sha: string;
  message: string;
  additions: number;
  deletions: number;
}

export interface ContributionCommitExport {
  rows: ContributionCommitRow[];
  /** Team repos of the repository. */
  repoCount: number;
  /** Team repos never calculated (no commits to give). */
  notCalculated: number;
  /** Team repos that had more commits than were stored. */
  truncatedRepos: string[];
  /** The oldest calculation the rows come from, ISO. */
  oldestCalculatedAt: string | null;
}

/** git prints the author's own offset (`2026-11-02T05:00:00-05:00`); rows are UTC. */
function toUtcIso(date: string): string {
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? date : new Date(t).toISOString();
}

export async function listCommits(args: {
  classroomId: string;
  repositoryId: string;
}): Promise<ContributionCommitExport> {
  const prisma = getPrisma();
  const repos = await prisma.gitRepo.findMany({
    where: {
      classroom_id: args.classroomId,
      repository_id: args.repositoryId,
      team_id: { not: null },
    },
    select: {
      name: true,
      contribution_stats: true,
      contributions_calculated_at: true,
      team: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  });

  const perRepo = repos.map(r => ({
    repo: r,
    commits: readContributionCommits(r.contribution_stats),
  }));
  const userIds = [
    ...new Set(perRepo.flatMap(p => p.commits.map(c => c.user_id)).filter(Boolean)),
  ] as string[];
  const members = userIds.length
    ? await prisma.classroomMembership.findMany({
        where: { classroom_id: args.classroomId, user_id: { in: userIds } },
        select: { user: { select: { id: true, name: true } } },
      })
    : [];
  const names = new Map(members.map(m => [m.user.id, m.user.name]));

  const rows: ContributionCommitRow[] = [];
  const truncatedRepos: string[] = [];
  let notCalculated = 0;
  let oldest: Date | null = null;
  for (const { repo, commits } of perRepo) {
    const stats = repo.contribution_stats as { version?: unknown; commits_truncated?: unknown };
    if (!stats || stats.version !== REPO_CONTRIBUTIONS_VERSION) {
      notCalculated += 1;
      continue;
    }
    if (stats.commits_truncated === true) truncatedRepos.push(repo.name);
    const at = repo.contributions_calculated_at;
    if (at && (!oldest || at < oldest)) oldest = at;
    for (const c of commits) {
      const memberId = c.user_id && names.has(c.user_id) ? c.user_id : null;
      rows.push({
        team: repo.team?.name ?? null,
        repo: repo.name,
        date: toUtcIso(c.date),
        student: memberId ? (names.get(memberId) ?? null) : null,
        user_id: memberId,
        github_login: c.login,
        git_name: c.git_name,
        git_email: c.git_email,
        sha: c.sha,
        message: c.message,
        additions: c.additions,
        deletions: c.deletions,
      });
    }
  }
  // Oldest first across teams: a timeline reads top to bottom.
  rows.sort((a, b) => a.team?.localeCompare(b.team ?? '') || a.date.localeCompare(b.date));

  return {
    rows,
    repoCount: repos.length,
    notCalculated,
    truncatedRepos,
    oldestCalculatedAt: oldest?.toISOString() ?? null,
  };
}

const HEADERS = [
  'Team',
  'Repository',
  'Date (UTC)',
  'Student',
  'Github',
  'Git author',
  'Git email',
  'Commit',
  'Message',
  'Lines added',
  'Lines removed',
];

/** The rows as CSV (formula-safe cells, CRLF), header first. */
export function commitsToCsv(rows: ContributionCommitRow[]): string {
  return toCsv([
    HEADERS,
    ...rows.map(r => [
      r.team ?? '',
      r.repo,
      r.date ? r.date.replace('T', ' ').replace(/(\.\d+)?Z$/, '') : '',
      r.student ?? '',
      r.github_login ?? '',
      r.git_name,
      r.git_email ?? '',
      r.sha.slice(0, 7),
      r.message,
      r.additions,
      r.deletions,
    ]),
  ]);
}
