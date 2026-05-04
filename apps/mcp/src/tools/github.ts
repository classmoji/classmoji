import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import getPrisma from '@classmoji/database';
import { getValidGitHubToken } from '@classmoji/auth/server';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isTeachingInAny } from '../auth/roles.ts';
import { wrapToolHandler } from '../middleware/rateLimiter.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body?: string | null;
}

interface GhComment {
  id: number;
  user: { login: string } | null;
  created_at: string;
  body?: string | null;
}

async function getOctokit(userId: string): Promise<{ rest: unknown; graphql: unknown }> {
  const tokenResult = await getValidGitHubToken(userId);
  if (!tokenResult?.token)
    throw mcpError('GitHub token unavailable for this user', ErrorCode.InternalError);
  const { Octokit } = await import('octokit');
  return new Octokit({ auth: tokenResult.token });
}

/**
 * `github_feedback` — aggregate issue comments across the user's repositories
 * for the active classroom.
 */
export function registerGithubFeedback(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'github_feedback',
    {
      title: 'Aggregated GitHub feedback for your repos',
      description:
        'Aggregate GitHub issue comments across your repositories for a ' +
        'classroom. Returns issues with their comments, grouped by repo.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        studentId: z.string().uuid().optional().describe('Teaching team can pass a student ID; defaults to caller'),
      }).shape,
    },
    wrapToolHandler('github_feedback', ctx, async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      const targetStudent = args.studentId ?? ctx.userId;
      if (targetStudent !== ctx.userId && !isTeachingInAny(resolved.roles)) {
        throw mcpError(
          'Only teaching team can view another student\'s feedback',
          ErrorCode.InvalidRequest
        );
      }

      const prisma = getPrisma();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repos = (await prisma.repository.findMany({
        where: { classroom_id: resolved.classroom.id, student_id: targetStudent },
        include: {
          assignments: {
            include: { assignment: { include: { module: true } } },
          },
        },
      } as never)) as any[];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const octokit = (await getOctokit(targetStudent)) as any;
      const orgLogin = resolved.classroom.git_organization?.login;
      if (!orgLogin)
        throw mcpError('Classroom has no GitHub organization', ErrorCode.InternalError);

      const feedback: Array<Record<string, unknown>> = [];
      for (const repo of repos) {
        for (const ra of repo.assignments) {
          if (!ra.provider_issue_number) continue;
          try {
            const { data: issue } = await octokit.rest.issues.get({
              owner: orgLogin,
              repo: repo.name,
              issue_number: ra.provider_issue_number,
            });
            const { data: comments } = await octokit.rest.issues.listComments({
              owner: orgLogin,
              repo: repo.name,
              issue_number: ra.provider_issue_number,
            });
            const ghIssue = issue as GhIssue;
            feedback.push({
              repo: repo.name,
              module: ra.assignment.module?.title ?? null,
              assignment: ra.assignment.title,
              issue_number: ghIssue.number,
              issue_title: ghIssue.title,
              issue_state: ghIssue.state,
              issue_url: ghIssue.html_url,
              comments: (comments as GhComment[]).map(c => ({
                author: c.user?.login,
                created_at: c.created_at,
                body: c.body?.slice(0, 1500),
              })),
            });
          } catch (err) {
            feedback.push({
              repo: repo.name,
              assignment: ra.assignment.title,
              issue_number: ra.provider_issue_number,
              error: err instanceof Error ? err.message : 'fetch failed',
            });
          }
        }
      }

      return ok({ classroom: resolved.classroom.slug, total: feedback.length, feedback });
    })
  );
}

/**
 * `github_repo_issues` — list issues + comments for a specific repository.
 * Teaching team only.
 */
export function registerGithubRepoIssues(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'github_repo_issues',
    {
      title: 'List GitHub issues for a repository',
      description:
        'List issues + their comments for a specific repository in this ' +
        'classroom (teaching team only).',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        repositoryId: z.string().uuid(),
        state: z.enum(['open', 'closed', 'all']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isTeachingInAny(resolved.roles))
        throw mcpError('Teaching team role required', ErrorCode.InvalidRequest);

      const prisma = getPrisma();
      const repo = await prisma.repository.findUnique({ where: { id: args.repositoryId } });
      if (!repo || repo.classroom_id !== resolved.classroom.id) {
        throw mcpError('Repository not found in this classroom', ErrorCode.InvalidRequest);
      }
      const orgLogin = resolved.classroom.git_organization?.login;
      if (!orgLogin)
        throw mcpError('Classroom has no GitHub organization', ErrorCode.InternalError);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const octokit = (await getOctokit(ctx.userId)) as any;
      const { data: issues } = await octokit.rest.issues.listForRepo({
        owner: orgLogin,
        repo: repo.name,
        state: args.state ?? 'all',
        per_page: args.limit ?? 20,
      });

      return ok({
        repo: repo.name,
        issues: (issues as GhIssue[]).map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
        })),
      });
    }
  );
}
