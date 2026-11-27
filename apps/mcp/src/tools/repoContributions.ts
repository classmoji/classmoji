/**
 * Team repo contributions — MCP parity with the repository page's
 * Contributions column and its "Calculate contributions" action.
 *
 *   - repo_contributions (read, teaching team: the page is served to the
 *     whole team, owners at /admin, the rest at /assistant): every team repo
 *     of one GROUP repository with who wrote what, matched authors named only
 *     when they are a current member of this classroom. A staff read of
 *     students' work, so the registry writes a VIEW row (auditRead).
 *   - repo_contributions_commits (read, OWNER only: the web's "Export commits
 *     (CSV)" is behind requireClassroomAdmin): every student commit across the
 *     team repos, the rows the CSV carries (ClassmojiService.repoContributions).
 *     Audited like the download.
 *   - repo_contributions_calculate (write, OWNER only: the web action is
 *     behind requireClassroomAdmin): queues the same Trigger.dev runs
 *     (@classmoji/tasks/contributions). It overwrites the stored numbers and
 *     creates no record about a person, so it is not destructive, and
 *     repeating it recalculates the same thing.
 *
 * Both load the repository inside the authorized classroom first (S1), and the
 * git repos are read by that classroom id and repository id together.
 */
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { ContributionsNotTeamRepoError, queueContributions } from '@classmoji/tasks/contributions';
import { lineShare, readRepoContributions } from '@classmoji/utils/repo-contributions';
import { uuidString } from '@classmoji/utils/zod-formats';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { gitTermsFor } from '../resources/shape.ts';
import {
  loadRepositoryInClassroom,
  ok,
  OWNER_ONLY,
  requireClassroomCtx,
  TEACHING_TEAM,
  writeAudit,
} from './shared.ts';

interface RepoContributionsArgs {
  classroom: string;
  repository_id: string;
}

const inputSchema = {
  classroom: z.string().describe("Classroom reference as 'org/slug'"),
  repository_id: uuidString().describe('Repository (assignment container) id of a team repo'),
};

export const repoContributionsTool: ToolDefinition<RepoContributionsArgs> = {
  name: 'repo_contributions',
  title: 'Team repo contributions',
  description:
    'Who wrote what in each team repository of a group repo (assignment container), from the ' +
    'last "Calculate contributions" run: per contributor their lines of the current code ' +
    '(by who last changed each line, starter code excluded), commits, lines added and removed, ' +
    'and first and last commit dates. Contributors are matched to classroom members by git ' +
    'username or email; an unmatched one shows its git name. `calculated_at` says when the ' +
    'numbers were taken; run repo_contributions_calculate to refresh them. Teaching team.',
  scope: 'read',
  roles: TEACHING_TEAM,
  auditRead: {
    resourceType: 'REPOSITORIES',
    ids: args => ({ resourceId: String(args.repository_id) }),
  },
  inputSchema,
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);
    const terms = gitTermsFor(ctx);
    if (repository.type !== 'GROUP') {
      throw new ToolError(
        'invalid_params',
        `Contributions are calculated for team ${terms.repos} only; this ${terms.repo} is individual.`
      );
    }

    const prisma = getPrisma();
    const repos = await prisma.gitRepo.findMany({
      where: {
        classroom_id: classroom.classroomId,
        repository_id: repository.id,
        team_id: { not: null },
      },
      select: {
        id: true,
        name: true,
        contribution_stats: true,
        contributions_calculated_at: true,
        contributions_error: true,
        team: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    const stats = new Map(repos.map(r => [r.id, readRepoContributions(r.contribution_stats)]));
    const userIds = [
      ...new Set(
        [...stats.values()].flatMap(s => (s?.authors ?? []).map(a => a.user_id)).filter(Boolean)
      ),
    ] as string[];
    // Named only while a member of THIS classroom.
    const members = userIds.length
      ? await prisma.classroomMembership.findMany({
          where: { classroom_id: classroom.classroomId, user_id: { in: userIds } },
          select: { user: { select: { id: true, name: true } } },
        })
      : [];
    const names = new Map(members.map(m => [m.user.id, m.user.name]));

    return ok({
      repository: { id: repository.id, title: repository.title },
      team_repos: repos.map(r => {
        const s = stats.get(r.id) ?? null;
        return {
          repo: r.name,
          team: r.team ? { id: r.team.id, name: r.team.name } : null,
          calculated_at: r.contributions_calculated_at?.toISOString() ?? null,
          error: r.contributions_error,
          totals: s
            ? {
                lines: s.total_lines,
                starter_lines: s.starter_lines,
                commits: s.total_commits,
                head_sha: s.head_sha,
              }
            : null,
          contributors: (s?.authors ?? []).map(a => {
            const memberId = a.user_id && names.has(a.user_id) ? a.user_id : null;
            return {
              user_id: memberId,
              name: memberId ? (names.get(memberId) ?? null) : null,
              git_name: a.git_name,
              git_email: a.git_email,
              line_share_percent: lineShare(a, s?.total_lines ?? 0),
              lines: a.lines,
              commits: a.commits,
              additions: a.additions,
              deletions: a.deletions,
              first_commit_at: a.first_commit_at,
              last_commit_at: a.last_commit_at,
            };
          }),
        };
      }),
    });
  },
};

export const repoContributionsCalculateTool: ToolDefinition<RepoContributionsArgs> = {
  name: 'repo_contributions_calculate',
  title: 'Calculate team repo contributions',
  description:
    'Recalculates who wrote what in every team repository of a group repo (assignment ' +
    'container), as the web "Calculate contributions" action does: each team repository is ' +
    'cloned in the background and its lines and commits counted per contributor. Results ' +
    'replace the previous ones within a few minutes; read them with repo_contributions. ' +
    'Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  annotations: { destructive: false, idempotent: true, openWorld: true },
  inputSchema,
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);
    const terms = gitTermsFor(ctx);

    let numRepos: number;
    try {
      ({ numRepos } = await queueContributions({
        classroomId: classroom.classroomId,
        repositoryId: repository.id,
      }));
    } catch (error) {
      if (error instanceof ContributionsNotTeamRepoError) {
        throw new ToolError(
          'invalid_params',
          `Contributions are calculated for team ${terms.repos} only; this ${terms.repo} is individual.`
        );
      }
      console.error('[mcp] repo_contributions_calculate failed:', error);
      throw new ToolError('internal', 'The calculation could not be queued. Try again.');
    }

    await writeAudit(ctx, {
      resource_type: 'REPOSITORIES',
      resource_id: repository.id,
      action: 'UPDATE',
      data: { tool: 'repo_contributions_calculate', repos: numRepos },
    });

    return ok({
      success: true,
      team_repos_queued: numRepos,
      message:
        numRepos === 0
          ? `No team ${terms.repos} yet, so there is nothing to calculate.`
          : `Calculating contributions for ${numRepos} team ${numRepos === 1 ? terms.repo : terms.repos}. ` +
            'Read them with repo_contributions in a few minutes.',
    });
  },
};

interface RepoContributionsCommitsArgs extends RepoContributionsArgs {
  team_repo?: string;
  limit?: number;
}

export const repoContributionsCommitsTool: ToolDefinition<RepoContributionsCommitsArgs> = {
  name: 'repo_contributions_commits',
  title: 'Team repo commits',
  description:
    'Every student commit in the team repositories of a group repo (assignment container), ' +
    'oldest first per team: date (UTC), the student it was matched to (Classmoji name), Github ' +
    'login, git author, commit, subject line, lines added and removed. The same rows as the web ' +
    '"Export commits (CSV)". From the last "Calculate contributions" run (starter code, merges ' +
    'and Classmoji commits left out); run repo_contributions_calculate first to refresh. ' +
    'Owner only.',
  scope: 'read',
  roles: OWNER_ONLY,
  auditRead: {
    resourceType: 'REPOSITORIES',
    ids: args => ({
      resourceId: String(args.repository_id),
      data: (typeof args.team_repo === 'string' ? { team_repo: args.team_repo } : {}) as Record<
        string,
        string
      >,
    }),
  },
  inputSchema: {
    ...inputSchema,
    team_repo: z
      .string()
      .max(200)
      .optional()
      .describe('Only this team repository (its git repo name, e.g. project1-bestteam)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe('At most this many commits (default 1000)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);
    const terms = gitTermsFor(ctx);
    if (repository.type !== 'GROUP') {
      throw new ToolError(
        'invalid_params',
        `Commits are listed for team ${terms.repos} only; this ${terms.repo} is individual.`
      );
    }

    const result = await ClassmojiService.repoContributions.listCommits({
      classroomId: classroom.classroomId,
      repositoryId: repository.id,
    });
    const filtered = args.team_repo
      ? result.rows.filter(r => r.repo === args.team_repo)
      : result.rows;
    const limit = args.limit ?? 1000;

    return ok({
      repository: { id: repository.id, title: repository.title },
      team_repos: result.repoCount,
      team_repos_not_calculated: result.notCalculated,
      calculated_at_oldest: result.oldestCalculatedAt,
      total_commits: filtered.length,
      truncated: filtered.length > limit,
      // Repos with more commits than a calculation keeps (the newest are kept).
      team_repos_with_older_commits_left_out: result.truncatedRepos,
      commits: filtered.slice(0, limit),
    });
  },
};
