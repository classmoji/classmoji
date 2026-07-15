/**
 * Repo tools — repo_publish / repo_unpublish (plan §5.2 gap 1 — Phase 3).
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.repos/action.ts:
 * requireClassroomAdmin — OWNER only (both publish and unpublish intents).
 *
 * repo_publish mirrors admin.$class.repos/helpers.ts publishAssignment. The
 * publish flip is a plain service call (repository.setPublished — fires the
 * repository-published notification); git-repo PROVISIONING is already
 * orchestrated by the `create_git_repos` Trigger.dev pipeline, so per the
 * locked gap policy MCP triggers that task exactly as the route does (typed
 * Tasks.createRepositoriesTask.trigger, same payload, same concurrencyKey) —
 * provisioning is never reimplemented here. Branches mirrored:
 *   - repos already exist (re-publish after unpublish): flip only.
 *   - INDIVIDUAL: trigger repo creation for every enrolled student, flip.
 *   - SELF_FORMED teams: flip only (repos created when students form teams).
 *   - instructor-assigned teams: trigger repo creation per tagged team, flip.
 * The web additionally mints a Trigger.dev public token so its UI can render
 * a live progress bar — that is a web-UI session concern and is not exposed
 * here (counts are returned instead).
 *
 * S1: the web helper flips by repository id WITHOUT re-verifying the
 * repository's classroom (the URL-derived slug only scopes the git-repo
 * lookups); MCP does NOT mirror that hole — the Repository is loaded and its
 * classroom_id compared to the authorized classroom before anything runs.
 */

import { randomUUID } from 'node:crypto';
import { ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition, ToolContext } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

type RepositoryRecord = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.repository.findById>>
>;

/** Load a Repository (an assignment container) and verify its classroom_id. */
async function loadRepositoryInClassroom(id: string, ctx: ToolContext): Promise<RepositoryRecord> {
  const record = await ClassmojiService.repository.findById(id);
  if (!record || record.classroom_id !== requireClassroomCtx(ctx).classroomId) {
    throw scopedNotFound('Repo');
  }
  return record;
}

/** The classroom slug drives the task payload + concurrency key (route parity). */
function classroomSlugOf(ctx: ToolContext): string {
  const slug = requireClassroomCtx(ctx).classroom?.slug;
  if (typeof slug !== 'string' || !slug) {
    throw new ToolError('internal', 'Classroom slug unavailable');
  }
  return slug;
}

/**
 * Fire the create_git_repos pipeline exactly as publishAssignment does:
 * same payload shape, same per-classroom concurrency key, fire-and-forget
 * (the web flips visibility regardless — a slow/failed job is recovered via
 * Sync). The rejection handler only guards this long-lived process against
 * an unhandled rejection.
 */
function triggerRepoProvisioning(
  logins: string[],
  repositoryTitle: string,
  classroomSlug: string,
  sessionId: string
): void {
  void Tasks.createRepositoriesTask
    .trigger(
      {
        logins,
        assignmentTitle: repositoryTitle,
        org: classroomSlug,
        sessionId,
      },
      { concurrencyKey: classroomSlug }
    )
    .catch((error: unknown) => {
      console.error('[mcp] create_git_repos trigger failed:', error);
    });
}

interface RepoPublishArgs {
  classroom: string;
  repository_id: string;
}

export const repoPublishTool: ToolDefinition<RepoPublishArgs> = {
  name: 'repo_publish',
  title: 'Publish a repo',
  description:
    'Publishes a repo (assignment container) to students and provisions their git repositories ' +
    'in the background (per-student for individual repos, per-team for instructor-assigned ' +
    'teams; self-formed team repos are created when students form teams). Owner only. ' +
    'Re-publishing a previously published repo just restores visibility — use the web Sync to ' +
    'backfill missing repositories.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    repository_id: z.string().uuid().describe('Repository (assignment container) id'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);
    const classroomSlug = classroomSlugOf(ctx);

    const audit = (data: Record<string, unknown>) =>
      writeAudit(ctx, {
        resource_type: 'REPOSITORIES',
        resource_id: repository.id,
        action: 'UPDATE',
        data: { tool: 'repo_publish', ...data },
      });

    // If repos already exist (re-publish after unpublish), just flip the flag.
    const existingRepos = await ClassmojiService.gitRepo.findByRepository(
      classroomSlug,
      repository.id
    );
    if (existingRepos.length > 0) {
      await ClassmojiService.repository.setPublished(repository.id, true);
      await audit({ is_published: true, provisioning_triggered: false, republished: true });
      return ok({
        success: true,
        is_published: true,
        message: 'Repository re-published. Use Sync to update repositories.',
      });
    }

    if (repository.type === 'INDIVIDUAL') {
      const students = await ClassmojiService.classroomMembership.findUsersByRole(
        classroom.classroomId,
        'STUDENT'
      );
      if (students.length === 0) {
        throw new ToolError('invalid_params', 'No students found.');
      }
      const logins = students.map(user => user.login || '').filter(login => login !== '');

      const sessionId = randomUUID();
      triggerRepoProvisioning(logins, repository.title, classroomSlug, sessionId);

      // Publish = "make available to students" — flip visibility immediately;
      // per-student GitHub repos provision in the background (route parity).
      await ClassmojiService.repository.setPublished(repository.id, true);
      await audit({
        is_published: true,
        provisioning_triggered: true,
        repos_to_create: logins.length,
        session_id: sessionId,
      });
      return ok({
        success: true,
        is_published: true,
        provisioning: { repos_to_create: logins.length },
        message: 'Repository published. Student repositories are being created in the background.',
      });
    }

    if (repository.team_formation_mode === 'SELF_FORMED') {
      // For self-formed teams, just mark the repository as published — teams
      // and repos are created when students form their teams.
      await ClassmojiService.repository.setPublished(repository.id, true);
      await audit({ is_published: true, provisioning_triggered: false });
      return ok({
        success: true,
        is_published: true,
        message: 'Repository published! Students can now form teams.',
      });
    }

    // Instructor-assigned teams.
    const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);
    if (teams.length === 0) {
      throw new ToolError('invalid_params', 'No team(s) found.');
    }

    const sessionId = randomUUID();
    triggerRepoProvisioning(
      teams.map(team => team.slug),
      repository.title,
      classroomSlug,
      sessionId
    );

    await ClassmojiService.repository.setPublished(repository.id, true);
    await audit({
      is_published: true,
      provisioning_triggered: true,
      repos_to_create: teams.length,
      session_id: sessionId,
    });
    return ok({
      success: true,
      is_published: true,
      provisioning: { repos_to_create: teams.length },
      message: 'Repository published. Team repositories are being created in the background.',
    });
  },
};

interface RepoUnpublishArgs {
  classroom: string;
  repository_id: string;
}

export const repoUnpublishTool: ToolDefinition<RepoUnpublishArgs> = {
  name: 'repo_unpublish',
  title: 'Unpublish a repo',
  description:
    'Hides a repo (assignment container) from students. Owner only. Existing git repositories ' +
    'are kept; re-publish to restore visibility.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    repository_id: z.string().uuid().describe('Repository (assignment container) id'),
  },
  handler: async (args, ctx) => {
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);

    await ClassmojiService.repository.setPublished(repository.id, false);

    await writeAudit(ctx, {
      resource_type: 'REPOSITORIES',
      resource_id: repository.id,
      action: 'UPDATE',
      data: { tool: 'repo_unpublish', is_published: false },
    });

    return ok({ success: true, is_published: false, message: 'Repository unpublished' });
  },
};
