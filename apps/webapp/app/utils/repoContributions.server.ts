import { auth } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import { ContributionsNotTeamRepoError, queueContributions } from '@classmoji/tasks/contributions';
import { ClassmojiService } from '@classmoji/services';
import { readRepoContributions } from '@classmoji/utils/repo-contributions';
import { addClassroomAuditLog } from '~/utils/helpers';

/**
 * "Calculate contributions", from the Repositories list and the repository
 * page: queue one Trigger.dev run per team repo, hand the browser a token that
 * reads only those runs (the progress bar), and write the audit row.
 *
 * `repositoryId` must already be loaded inside `classroom` by the caller; the
 * queue re-checks it there anyway.
 */
export async function startContributionsCalculation(args: {
  classroom: { id: string };
  repositoryId: string;
  userId: string;
  role: string;
}) {
  const sessionId = nanoid();
  let numRepos: number;
  try {
    ({ numRepos } = await queueContributions({
      classroomId: args.classroom.id,
      repositoryId: args.repositoryId,
      tags: [`session_${sessionId}`],
    }));
  } catch (error) {
    if (error instanceof ContributionsNotTeamRepoError) {
      return { action: 'CALCULATE_REPO_CONTRIBUTIONS', error: error.message };
    }
    throw error;
  }

  await addClassroomAuditLog({
    classroomId: args.classroom.id,
    userId: args.userId,
    role: args.role,
    action: 'UPDATE',
    resourceType: 'REPOSITORIES',
    resourceId: args.repositoryId,
    metadata: { tool: 'web:repos.contributions.calculate', repos: numRepos },
    dedupe: false,
  });

  if (numRepos === 0) {
    return { action: 'CALCULATE_REPO_CONTRIBUTIONS', info: 'No team repositories yet.' };
  }

  const accessToken = await auth.createPublicToken({
    scopes: { read: { tags: [`session_${sessionId}`] } },
  });
  return { triggerSession: { accessToken, id: sessionId, numRepos } };
}

type WithContributionColumns = { contributions?: unknown; contribution_stats?: unknown };

/**
 * What a page showing team repos' contributions needs from its git repo rows:
 * the stats read through the shape check (never the raw column, and never the
 * stored commit list, which only the CSV and the MCP read), the Classmoji
 * names of matched authors, and the staff-view audit row. Shared by the
 * repository page and the assignment page.
 *
 * Names come only from current members of `classroom`: a stored id that is no
 * longer a member there shows as its git name.
 */
export async function withContributions<R extends WithContributionColumns>(args: {
  classroom: { id: string };
  userId: string;
  role: string | undefined;
  repository: { id: string; type: string };
  repos: R[];
}) {
  const isTeamRepository = args.repository.type === 'GROUP';
  const repos = args.repos.map(({ contributions: _retired, contribution_stats, ...r }) => ({
    ...(r as Omit<R, 'contributions' | 'contribution_stats'>),
    contribution_stats: isTeamRepository ? readRepoContributions(contribution_stats) : null,
  }));

  const ids = new Set(
    repos.flatMap(r => (r.contribution_stats?.authors ?? []).map(a => a.user_id)).filter(Boolean)
  ) as Set<string>;
  const contributors: Record<string, { name: string | null; login: string | null }> = {};
  if (ids.size > 0) {
    const members = await ClassmojiService.classroomMembership.findUsersByRoles(args.classroom.id, [
      'OWNER',
      'TEACHER',
      'ASSISTANT',
      'STUDENT',
    ]);
    for (const m of members) {
      if (ids.has(m.id)) contributors[m.id] = { name: m.name, login: m.login };
    }
  }

  // Staff reading who did what in students' repos (CLAUDE.md rule 2).
  if (repos.some(r => r.contribution_stats)) {
    await addClassroomAuditLog({
      classroomId: args.classroom.id,
      userId: args.userId,
      role: args.role,
      action: 'VIEW',
      resourceType: 'REPOSITORIES',
      resourceId: args.repository.id,
      metadata: { tool: 'web:repos.contributions' },
    });
  }

  return { repos, contributors };
}
