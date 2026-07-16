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
import {
  loadRepositoryInClassroom,
  ok,
  OWNER_ONLY,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
} from './shared.ts';

/** Prisma unique-violation (P2002) — Repository is @@unique([classroom_id, title]). */
function isUniqueTitleViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'P2002';
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
  annotations: { destructive: false, openWorld: true },
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
  // Reversible visibility flip in our DB (setPublished(false)); no rows removed,
  // no GitHub call — repo_publish flips it back. Not destructive, closed-world.
  annotations: { destructive: false },
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

interface RepoCreateArgs {
  classroom: string;
  title: string;
  template: string;
  type?: 'INDIVIDUAL' | 'GROUP';
  weight?: number;
  description?: string;
  is_extra_credit?: boolean;
  drop_lowest_count?: number;
  tag_id?: string;
  team_formation_mode?: 'INSTRUCTOR' | 'SELF_FORMED';
  team_formation_deadline?: string;
  max_team_size?: number;
  project_template_id?: string;
  project_template_title?: string;
}

export const repoCreateTool: ToolDefinition<RepoCreateArgs> = {
  name: 'repo_create',
  // Commits a content-manifest refresh to the GitHub content repo (best-effort,
  // failure-tolerant) → openWorld. No student repos are provisioned here (that
  // is repo_publish), and nothing is removed → not destructive.
  annotations: { destructive: false, openWorld: true },
  title: 'Create an assignment container (repo)',
  description:
    'Creates an UNPUBLISHED assignment container (a "repo"/lab) in the classroom. Owner only. No ' +
    'student git repos are created — the container starts empty and hidden; add assignments with ' +
    'assignment_create, then provision student repos with repo_publish. For a GROUP repo with ' +
    'instructor-assigned teams, pass tag_id (a team tag in this classroom). Refreshes the ' +
    "classroom's content manifest on GitHub (best-effort).",
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    title: z.string().min(1).max(200).describe('Repo/lab title (unique per classroom)'),
    template: z
      .string()
      .min(1)
      .max(200)
      .describe('GitHub template repo name students are provisioned from at publish'),
    type: z
      .enum(['INDIVIDUAL', 'GROUP'])
      .optional()
      .describe('Individual or group repo (default INDIVIDUAL)'),
    weight: z.number().int().min(0).max(10000).optional().describe('Grading weight (default 100)'),
    description: z.string().max(2000).optional(),
    is_extra_credit: z.boolean().optional().describe('default false'),
    drop_lowest_count: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Drop the N lowest assignments (default 0)'),
    tag_id: z
      .string()
      .uuid()
      .optional()
      .describe('Team tag id (GROUP with instructor-assigned teams)'),
    team_formation_mode: z
      .enum(['INSTRUCTOR', 'SELF_FORMED'])
      .optional()
      .describe('GROUP only (default INSTRUCTOR)'),
    team_formation_deadline: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('GROUP only (ISO 8601)'),
    max_team_size: z.number().int().positive().optional().describe('GROUP only'),
    project_template_id: z.string().optional().describe('GitHub Projects V2 template node_id'),
    project_template_title: z.string().optional().describe('Human-readable project template name'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const type = args.type ?? 'INDIVIDUAL';
    const teamMode = args.team_formation_mode ?? 'INSTRUCTOR';

    // S1 for the one cross-record reference: a supplied tag must belong to THIS
    // classroom (Tag has no findById — validate via the classroom-scoped list).
    if (args.tag_id) {
      const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.classroomId);
      if (!tags.some(t => t.id === args.tag_id)) {
        throw scopedNotFound('Tag');
      }
    }

    // Mirror the web superRefine: instructor-assigned GROUP teams need a tag.
    if (type === 'GROUP' && teamMode === 'INSTRUCTOR' && !args.tag_id) {
      throw new ToolError(
        'invalid_params',
        'A GROUP repo with instructor-assigned teams requires tag_id'
      );
    }

    let created;
    try {
      created = await ClassmojiService.repository.create({
        // classroom_id is ALWAYS the authorized classroom, never request input.
        classroom_id: classroom.classroomId,
        title: args.title,
        template: args.template,
        type,
        ...(args.weight !== undefined ? { weight: args.weight } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.is_extra_credit !== undefined ? { is_extra_credit: args.is_extra_credit } : {}),
        ...(args.drop_lowest_count !== undefined
          ? { drop_lowest_count: args.drop_lowest_count }
          : {}),
        ...(args.tag_id !== undefined ? { tag_id: args.tag_id } : {}),
        ...(type === 'GROUP'
          ? {
              team_formation_mode: teamMode,
              ...(args.team_formation_deadline !== undefined
                ? { team_formation_deadline: new Date(args.team_formation_deadline) }
                : {}),
              ...(args.max_team_size !== undefined ? { max_team_size: args.max_team_size } : {}),
            }
          : {}),
        ...(args.project_template_id !== undefined
          ? { project_template_id: args.project_template_id }
          : {}),
        ...(args.project_template_title !== undefined
          ? { project_template_title: args.project_template_title }
          : {}),
      });
    } catch (error) {
      if (isUniqueTitleViolation(error)) {
        throw new ToolError(
          'invalid_params',
          'A repo with this title already exists in this classroom.'
        );
      }
      throw error;
    }

    // Mirror the web create flow: refresh the content manifest (best-effort —
    // saveManifest swallows GitHub errors internally, so this never throws).
    await ClassmojiService.contentManifest.saveManifest(classroom.classroomId);

    await writeAudit(ctx, {
      resource_type: 'REPOSITORIES',
      resource_id: created.id,
      action: 'CREATE',
      data: { tool: 'repo_create', title: args.title, type },
    });

    return ok({
      success: true,
      repository: {
        id: created.id,
        title: created.title,
        slug: created.slug,
        type: created.type,
        is_published: created.is_published,
        weight: created.weight,
      },
    });
  },
};
