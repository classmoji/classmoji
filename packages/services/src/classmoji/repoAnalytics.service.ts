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

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Re-map `author_login` → `author_user_id` on a list of commit records using
 * the provided lookup map. Pure; returns a new array, does not mutate input.
 */
export function linkAuthorsToUsers(
  commits: CommitRecord[],
  loginToUserId: Map<string, string>
): CommitRecord[] {
  return commits.map((c) => ({
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
  return contributors.map((c) => ({
    ...c,
    user_id: loginToUserId.has(c.login) ? (loginToUserId.get(c.login) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Link map builder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

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
    } catch {
      // Swallow — we're already in an error path; don't mask the original cause.
    }
    return { stale: true, error: message };
  }
}

// ---------------------------------------------------------------------------
// Cron helper
// ---------------------------------------------------------------------------

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
  return rows.map((r) => r.id);
}
