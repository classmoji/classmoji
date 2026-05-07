/**
 * RepoAnalytics Service
 *
 * Builds, links, and persists `RepoAnalyticsSnapshot` rows for a
 * `RepositoryAssignment`. A snapshot is a cached, authored summary of the
 * underlying repo's commits, contributors, languages, and PR counts — used by
 * the TA cockpit and owner dashboards.
 *
 * High-level flow (see `refreshOne`):
 *   1. Load the RepositoryAssignment → Repository → Classroom → GitOrganization.
 *   2. Build a GitProvider from the org's installation/credentials.
 *   3. Call `buildSnapshot` to fetch commits / contributors / languages / PR summary.
 *      GitHub's contributor-stats endpoint returns 202 while warming its cache; we
 *      surface that as `pending: true` and still write the row but mark it `stale`
 *      so the Trigger.dev task retries.
 *   4. Resolve GitHub logins → classroom User ids via ClassroomMembership.user.login,
 *      with `RepositoryContributorLink` rows taking precedence as manual overrides.
 *   5. Upsert the snapshot row (JSON columns + aggregate totals + stale/error flags).
 */
import getPrisma from '@classmoji/database';
import type { GitProvider } from '../git/GitProvider.ts';
import { getGitProvider } from '../git/index.ts';
import type {
  CommitRecord,
  ContributorRecord,
  LanguagesMap,
  PRSummary,
  SnapshotPayload,
} from './repoAnalytics.types.ts';

// Consider a classroom "active" if any of its assignments have a student_deadline
// within this window (past or future). Used by the cron to limit refresh scope.
const ACTIVE_WINDOW_DAYS = 30;

function pickLatestSnapshot<T, S extends { fetched_at: Date | string }>(
  items: T[],
  getSnap: (t: T) => S | null | undefined,
  decorate: (snap: S, item: T) => S = s => s
): S | null {
  let best: S | null = null;
  for (const item of items) {
    const s = getSnap(item);
    if (!s) continue;
    const t = new Date(s.fetched_at).getTime();
    if (!best || t > new Date(best.fetched_at).getTime()) best = decorate(s, item);
  }
  return best;
}

// Pure helpers (unit-tested)

/**
 * Re-map `author_login` → `author_user_id` on a list of commit records using
 * the provided lookup map. Pure; returns a new array, does not mutate input.
 */
export function linkAuthorsToUsers(
  commits: CommitRecord[],
  loginToUserId: Map<string, string>
): CommitRecord[] {
  return commits.map(c => ({
    ...c,
    author_user_id:
      c.author_login && loginToUserId.has(c.author_login)
        ? (loginToUserId.get(c.author_login) ?? null)
        : null,
  }));
}

/**
 * Re-map `login` → `user_id` on a list of contributor records. Pure.
 */
export function linkContributorsToUsers(
  contributors: ContributorRecord[],
  loginToUserId: Map<string, string>
): ContributorRecord[] {
  return contributors.map(c => ({
    ...c,
    user_id: loginToUserId.has(c.login) ? (loginToUserId.get(c.login) ?? null) : null,
  }));
}

// Snapshot building

/**
 * Fetch the four provider endpoints that compose a snapshot and normalize them
 * into `SnapshotPayload`. Returns `pending: true` when GitHub's
 * contributor-stats cache is still warming; callers should mark the row stale.
 */
export async function buildSnapshot(
  provider: GitProvider,
  orgLogin: string,
  repoName: string
): Promise<{ payload: SnapshotPayload; pending: boolean }> {
  const [commits, contributorsRes, languages, prSummary] = await Promise.all([
    provider.listCommits(orgLogin, repoName),
    provider.getContributorStats(orgLogin, repoName),
    provider.getLanguages(orgLogin, repoName),
    provider.listPulls(orgLogin, repoName),
  ]);

  let contributors: ContributorRecord[] = [];
  let pending = false;
  if (Array.isArray(contributorsRes)) {
    contributors = contributorsRes;
  } else if ((contributorsRes as { pending?: boolean })?.pending) {
    pending = true;
  }

  const payload: SnapshotPayload = {
    commits,
    contributors,
    languages: (languages ?? {}) as LanguagesMap,
    pr_summary: (prSummary ?? { open: 0, merged: 0, closed: 0 }) as PRSummary,
  };

  return { payload, pending };
}

// Upsert

/**
 * Upsert a snapshot row for a `RepositoryAssignment`. Safe to call with
 * `payload: null` when recording a hard error — in that case the JSON columns
 * are reset to their empty defaults, `stale: true` is forced, and the error
 * message is persisted.
 */
export async function upsertSnapshot(
  repositoryAssignmentId: string,
  payload: SnapshotPayload | null,
  opts: { stale?: boolean; error?: string } = {}
): Promise<void> {
  const prisma = getPrisma();
  const now = new Date();

  const commits = payload?.commits ?? [];
  const contributors = payload?.contributors ?? [];
  const languages = payload?.languages ?? {};
  const prSummary = payload?.pr_summary ?? { open: 0, merged: 0, closed: 0 };

  // Aggregate totals derived from commits list.
  let totalAdditions = 0;
  let totalDeletions = 0;
  let firstCommitAt: Date | null = null;
  let lastCommitAt: Date | null = null;
  for (const c of commits) {
    totalAdditions += c.additions ?? 0;
    totalDeletions += c.deletions ?? 0;
    const ts = new Date(c.ts);
    if (!Number.isNaN(ts.getTime())) {
      if (!firstCommitAt || ts < firstCommitAt) firstCommitAt = ts;
      if (!lastCommitAt || ts > lastCommitAt) lastCommitAt = ts;
    }
  }

  const stale = opts.stale ?? false;
  const error = opts.error ?? null;

  const data = {
    fetched_at: now,
    default_branch: null as string | null,
    total_commits: commits.length,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
    first_commit_at: firstCommitAt,
    last_commit_at: lastCommitAt,
    commits: commits as unknown as object,
    contributors: contributors as unknown as object,
    languages: languages as unknown as object,
    pr_summary: prSummary as unknown as object,
    stale,
    error,
  };

  await prisma.repoAnalyticsSnapshot.upsert({
    where: { repository_assignment_id: repositoryAssignmentId },
    create: {
      repository_assignment_id: repositoryAssignmentId,
      ...data,
    },
    update: data,
  });
}

// Link map builder

/**
 * Build a `githubLogin → userId` map for a repository. Starts with every
 * `ClassroomMembership.user.login` in the classroom, then overlays any
 * `RepositoryContributorLink` rows for this repo (manual overrides win).
 */
async function buildLoginToUserIdMap(
  classroomId: string,
  repositoryId: string
): Promise<Map<string, string>> {
  const prisma = getPrisma();
  const [memberships, links] = await Promise.all([
    prisma.classroomMembership.findMany({
      where: { classroom_id: classroomId },
      include: { user: { select: { id: true, login: true } } },
    }),
    prisma.repositoryContributorLink.findMany({
      where: { repository_id: repositoryId, user_id: { not: null } },
    }),
  ]);

  const map = new Map<string, string>();
  for (const m of memberships) {
    const login = m.user?.login;
    if (login && !map.has(login)) {
      map.set(login, m.user.id);
    }
  }
  // Overrides take precedence.
  for (const l of links) {
    if (l.user_id) map.set(l.github_login, l.user_id);
  }
  return map;
}

// Orchestrator

/**
 * End-to-end refresh for a single RepositoryAssignment. Intended to be called
 * by the Trigger.dev workflow (Task 7). Never throws — errors are persisted on
 * the snapshot row and returned via `{ stale: true, error }` so the task can
 * decide whether to retry.
 */
export async function refreshOne(
  repositoryAssignmentId: string
): Promise<{ stale: boolean; error?: string }> {
  const prisma = getPrisma();
  try {
    const ra = await prisma.repositoryAssignment.findUnique({
      where: { id: repositoryAssignmentId },
      include: {
        repository: {
          include: {
            classroom: {
              include: { git_organization: true },
            },
          },
        },
      },
    });

    if (!ra) throw new Error(`RepositoryAssignment ${repositoryAssignmentId} not found`);
    const repo = ra.repository;
    if (!repo) throw new Error('Repository not attached to RepositoryAssignment');
    const classroom = repo.classroom;
    if (!classroom) throw new Error('Classroom not attached to Repository');
    const gitOrg = classroom.git_organization;
    if (!gitOrg) throw new Error('GitOrganization not attached to Classroom');
    if (!gitOrg.login) throw new Error('GitOrganization.login is required');

    const provider = getGitProvider(gitOrg);

    const { payload, pending } = await buildSnapshot(provider, gitOrg.login, repo.name);

    const loginToUserId = await buildLoginToUserIdMap(classroom.id, repo.id);

    const linkedPayload: SnapshotPayload = {
      ...payload,
      commits: linkAuthorsToUsers(payload.commits, loginToUserId),
      contributors: linkContributorsToUsers(payload.contributors, loginToUserId),
    };

    await upsertSnapshot(repositoryAssignmentId, linkedPayload, { stale: pending });

    return { stale: pending };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await upsertSnapshot(repositoryAssignmentId, null, { stale: true, error: message });
    } catch (upsertErr) {
      console.error('[repoAnalytics] failed to persist error snapshot', upsertErr);
    }
    return { stale: true, error: message };
  }
}

// Manual contributor → user linking

/**
 * Upsert a `RepositoryContributorLink` for the given `(repository_id, github_login)`.
 * Passing `userId: null` unlinks (records the mapping with no user). When a
 * `userId` is supplied, the user MUST be a member of the classroom that owns
 * the repo — otherwise this throws.
 *
 * Callers: the API route backing ContributorBreakdown's "Link to student"
 * modal. The stored link is consumed by `buildLoginToUserIdMap` on the next
 * refresh, so newly-linked contributors are attributed correctly.
 */
export async function linkContributor(
  repositoryId: string,
  githubLogin: string,
  userId: string | null
): Promise<void> {
  const prisma = getPrisma();

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, classroom_id: true },
  });
  if (!repo) throw new Error(`Repository ${repositoryId} not found`);

  if (userId) {
    const membership = await prisma.classroomMembership.findFirst({
      where: { classroom_id: repo.classroom_id, user_id: userId },
      select: { id: true },
    });
    if (!membership) {
      throw new Error(`User ${userId} is not a member of the classroom that owns this repository`);
    }
  }

  await prisma.repositoryContributorLink.upsert({
    where: {
      repository_id_github_login: {
        repository_id: repositoryId,
        github_login: githubLogin,
      },
    },
    create: {
      repository_id: repositoryId,
      github_login: githubLogin,
      user_id: userId,
    },
    update: { user_id: userId },
  });
}

// Cron helper

// Team aggregation

/**
 * Shape of a stored snapshot row plus its associated repository name/id — the
 * subset we expose to the Team Contributions view. Keeps `repoAnalytics.types`
 * Prisma-free; we redeclare here rather than importing Prisma types.
 */
export type TeamRepoSnapshot = {
  repository_id: string;
  repository_name: string;
  repository_assignment_id: string;
  fetched_at: string;
  stale: boolean;
  error: string | null;
  total_commits: number;
  total_additions: number;
  total_deletions: number;
  first_commit_at: string | null;
  last_commit_at: string | null;
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  languages: LanguagesMap;
  pr_summary: PRSummary;
};

export type TeamAggregate = {
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  total_additions: number;
  total_deletions: number;
  snapshotsByRepoId: Record<string, TeamRepoSnapshot>;
};

/**
 * Aggregate the latest analytics snapshot across every repository owned by a
 * team. For each repo we pick its most recent `RepoAnalyticsSnapshot` (ordered
 * by `fetched_at`) and merge:
 *   - `commits` via simple concatenation
 *   - `contributors` summed by `login` (commits/additions/deletions); `user_id`
 *     preserved from the first snapshot that had one.
 *
 * Returns `null` when the team owns no repositories with any snapshots.
 */
export async function aggregateForTeam(teamId: string): Promise<TeamAggregate | null> {
  const prisma = getPrisma();

  const repos = await prisma.repository.findMany({
    where: { team_id: teamId },
    select: {
      id: true,
      name: true,
      assignments: {
        select: {
          id: true,
          analytics_snapshot: true,
        },
      },
    },
  });

  if (repos.length === 0) return null;

  const snapshotsByRepoId: Record<string, TeamRepoSnapshot> = {};
  const commits: CommitRecord[] = [];
  const contributorMap = new Map<string, ContributorRecord>();
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const repo of repos) {
    const latestSnapshot = pickLatestSnapshot(
      repo.assignments,
      ra => ra.analytics_snapshot,
      (snap, ra) => ({ ...snap, repository_assignment_id: ra.id })
    );

    if (!latestSnapshot) continue;

    const repoCommits = (latestSnapshot.commits ?? []) as unknown as CommitRecord[];
    const repoContribs = (latestSnapshot.contributors ?? []) as unknown as ContributorRecord[];
    const repoLangs = (latestSnapshot.languages ?? {}) as unknown as LanguagesMap;
    const repoPr = (latestSnapshot.pr_summary ?? {
      open: 0,
      merged: 0,
      closed: 0,
    }) as unknown as PRSummary;

    snapshotsByRepoId[repo.id] = {
      repository_id: repo.id,
      repository_name: repo.name,
      repository_assignment_id: latestSnapshot.repository_assignment_id,
      fetched_at: latestSnapshot.fetched_at.toISOString(),
      stale: latestSnapshot.stale,
      error: latestSnapshot.error,
      total_commits: latestSnapshot.total_commits,
      total_additions: latestSnapshot.total_additions,
      total_deletions: latestSnapshot.total_deletions,
      first_commit_at: latestSnapshot.first_commit_at
        ? latestSnapshot.first_commit_at.toISOString()
        : null,
      last_commit_at: latestSnapshot.last_commit_at
        ? latestSnapshot.last_commit_at.toISOString()
        : null,
      commits: repoCommits,
      contributors: repoContribs,
      languages: repoLangs,
      pr_summary: repoPr,
    };

    commits.push(...repoCommits);
    totalAdditions += latestSnapshot.total_additions;
    totalDeletions += latestSnapshot.total_deletions;

    for (const c of repoContribs) {
      const existing = contributorMap.get(c.login);
      if (existing) {
        existing.commits += c.commits;
        existing.additions += c.additions;
        existing.deletions += c.deletions;
        if (!existing.user_id && c.user_id) existing.user_id = c.user_id;
      } else {
        contributorMap.set(c.login, { ...c });
      }
    }
  }

  if (Object.keys(snapshotsByRepoId).length === 0) return null;

  const contributors = Array.from(contributorMap.values()).sort((a, b) => b.commits - a.commits);

  return {
    commits,
    contributors,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
    snapshotsByRepoId,
  };
}

// Classroom-wide repo health

export interface ClassroomRepoHealthRepo {
  name: string;
  langs: Record<string, number>;
  commits: number;
  fetchedAt: string;
  status: 'fresh' | 'stale';
}

export interface ClassroomRepoUnmatchedContributor {
  login: string;
  repo: string;
  commits: number;
  firstSeen: string;
}

export interface ClassroomRepoHealth {
  repos: ClassroomRepoHealthRepo[];
  unmatched: ClassroomRepoUnmatchedContributor[];
  /** ISO timestamp of the next 4h boundary from "now" (UTC). */
  nextScheduledAt: string;
  autoRefreshEvery: '4h';
}

/**
 * Classroom-wide repo analytics overview for the admin Repo Health page.
 * Returns all latest snapshots, a list of GitHub logins that appear in
 * contributor payloads but are not linked to a classroom user, and a
 * human-readable "next scheduled refresh" timestamp anchored to 4h boundaries.
 */
export async function classroomRepoHealth(classroomId: string): Promise<ClassroomRepoHealth> {
  const prisma = getPrisma();

  const reposRaw = await prisma.repository.findMany({
    where: { classroom_id: classroomId },
    select: {
      id: true,
      name: true,
      assignments: {
        select: {
          id: true,
          analytics_snapshot: {
            select: {
              fetched_at: true,
              stale: true,
              total_commits: true,
              languages: true,
              contributors: true,
            },
          },
        },
      },
      contributor_links: { select: { github_login: true, user_id: true } },
    },
  });

  const repos: ClassroomRepoHealthRepo[] = [];
  const unmatched: ClassroomRepoUnmatchedContributor[] = [];

  for (const r of reposRaw) {
    // Latest snapshot across this repo's assignments.
    const latest = pickLatestSnapshot(r.assignments, a => a.analytics_snapshot);
    if (!latest) continue;

    const langs = (latest.languages ?? {}) as Record<string, number>;
    repos.push({
      name: r.name,
      langs,
      commits: latest.total_commits,
      fetchedAt: latest.fetched_at.toISOString(),
      status: latest.stale ? 'stale' : 'fresh',
    });

    // Unmatched contributors: appear in payload, are not linked (by membership
    // login match already baked into user_id), and have no manual link row.
    const linkedLogins = new Set(
      r.contributor_links.filter(l => l.user_id !== null).map(l => l.github_login)
    );
    const rawContribs = (latest.contributors ?? []) as Array<{
      login: string;
      user_id: string | null;
      commits: number;
    }>;
    for (const c of rawContribs) {
      if (!c || !c.login) continue;
      if (c.user_id) continue;
      if (linkedLogins.has(c.login)) continue;
      unmatched.push({
        login: c.login,
        repo: r.name,
        commits: c.commits,
        firstSeen: latest.fetched_at.toISOString(),
      });
    }
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  unmatched.sort((a, b) => b.commits - a.commits);

  // Next scheduled at = next 4h boundary in UTC.
  const now = new Date();
  const FOUR_H = 4 * 60 * 60 * 1000;
  const nextMs = Math.ceil(now.getTime() / FOUR_H) * FOUR_H;
  const nextScheduledAt = new Date(nextMs).toISOString();

  return {
    repos,
    unmatched,
    nextScheduledAt,
    autoRefreshEvery: '4h',
  };
}

/**
 * Return RepositoryAssignment IDs for assignments whose `student_deadline` is
 * within the last {@link ACTIVE_WINDOW_DAYS} days or in the future. Used by
 * the 6-hour refresh cron to bound its work.
 */
export async function listActiveAssignmentIds(): Promise<string[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.repositoryAssignment.findMany({
    where: {
      assignment: {
        OR: [{ student_deadline: null }, { student_deadline: { gte: cutoff } }],
      },
    },
    select: { id: true },
  });
  return rows.map(r => r.id);
}
