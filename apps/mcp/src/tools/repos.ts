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
 *   - INDIVIDUAL with no provisionable logins (empty roster / all invites still
 *     pending): flip only — publishing before students enrol is a supported
 *     pre-term state, and joiners are provisioned by activate_membership.
 *   - SELF_FORMED teams: flip only (repos created when students form teams).
 *   - instructor-assigned teams: trigger repo creation per tagged team, flip.
 *   - instructor-assigned teams with no teams yet: flip only.
 * The web additionally mints a Trigger.dev public token so its UI can render
 * a live progress bar — that is a web-UI session concern and is not exposed
 * here (counts are returned instead).
 *
 * S1: the Repository is loaded and its classroom_id compared to the authorized
 * classroom before anything runs, and the authorized classroom id is passed
 * into repository.setPublished so the write itself is scoped.
 *
 * repo_update / repo_delete (issue #457) — OWNER only, the tier of the web edit
 * form (admin.$class.repos_.form, requireClassroomAdmin) and delete intent.
 * Both go through the classroom-SCOPED service writes (repository.update /
 * deleteById with the authorized classroom id), never updateFromForm.
 *   - Structural fields (template, type, team_formation_mode, tag_id, project
 *     template) freeze once ANY GitRepo exists: provisioned copies already
 *     belong to a student or a team. The web freezes type + team formation on
 *     the same test (hasProvisionedRepos); it leaves the tag editable and locks
 *     the project template only once a repo HAS a project — MCP is stricter on
 *     both. The web also makes the template read-only on a PUBLISHED repo, and
 *     that is mirrored.
 *   - GROUP→INDIVIDUAL clears tag_id, team_formation_deadline, max_team_size
 *     (the web leaves them stale), and team fields on an INDIVIDUAL result are
 *     refused rather than written.
 *   - repo_delete refuses a published repo or one with GitRepo rows (the web's
 *     delete does neither); what remains to cascade is configuration only —
 *     assignments with no submissions, module items, page/slide links,
 *     autograding tests — and it is reported and audited.
 * Both refresh the content manifest AFTER the audit row, best-effort.
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
    'Works before anyone has enrolled — publishing an empty classroom marks the repo available ' +
    'and provisions nothing; students who join later get their repos on join. ' +
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
      await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
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
      const logins = students.map(user => user.login || '').filter(login => login !== '');

      // Nobody to provision for yet — empty roster (pre-term staging) or every
      // invite still pending, so there is no GitHub login to create a repo under.
      // Publish still succeeds (route parity): joining students are provisioned
      // on join, and Sync backfills anyone the join path missed.
      if (logins.length === 0) {
        await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
        await audit({ is_published: true, provisioning_triggered: false, repos_to_create: 0 });
        return ok({
          success: true,
          is_published: true,
          provisioning: { repos_to_create: 0 },
          message: 'Repository published. Student repositories are created as students join.',
        });
      }

      const sessionId = randomUUID();
      triggerRepoProvisioning(logins, repository.title, classroomSlug, sessionId);

      // Publish = "make available to students" — flip visibility immediately;
      // per-student GitHub repos provision in the background (route parity).
      await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
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
      await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
      await audit({ is_published: true, provisioning_triggered: false });
      return ok({
        success: true,
        is_published: true,
        message: 'Repository published! Students can now form teams.',
      });
    }

    // Instructor-assigned teams.
    const teams = await ClassmojiService.organizationTag.findTeamsByTag(repository.tag_id!);

    // No teams tagged yet — same pre-term staging case as INDIVIDUAL above.
    if (teams.length === 0) {
      await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
      await audit({ is_published: true, provisioning_triggered: false, repos_to_create: 0 });
      return ok({
        success: true,
        is_published: true,
        provisioning: { repos_to_create: 0 },
        message: 'Repository published. Team repositories are created once teams exist.',
      });
    }

    const sessionId = randomUUID();
    triggerRepoProvisioning(
      teams.map(team => team.slug),
      repository.title,
      classroomSlug,
      sessionId
    );

    await ClassmojiService.repository.setPublished(repository.id, true, classroom.classroomId);
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
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);

    await ClassmojiService.repository.setPublished(repository.id, false, classroom.classroomId);

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
  description?: string;
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
    'Creates an UNPUBLISHED repository (a GitHub template students are provisioned from). ' +
    'Owner only. A repository has no module: it is the submission target of REPO assignments, ' +
    'which live in modules. No student git repos are created — the repo starts hidden; attach ' +
    'assignments with assignment_create (module_id + repository_id), then provision student repos ' +
    'with repo_publish. Grading weight lives on assignments, not the repo. For a GROUP repo with instructor-assigned teams, ' +
    "pass tag_id (a team tag id from list_tags). Refreshes the classroom's content manifest on " +
    'GitHub (best-effort).',
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
    description: z.string().max(2000).optional(),
    tag_id: z
      .string()
      .uuid()
      .optional()
      .describe('Team tag id from list_tags (GROUP with instructor-assigned teams)'),
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

    // S1 for the other cross-record reference: a supplied tag must belong to THIS
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
        ...(args.description !== undefined ? { description: args.description } : {}),
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
      },
    });
  },
};

// ─── repo_update / repo_delete (issue #457) ─────────────────────────────────

/**
 * Best-effort manifest refresh, run AFTER the audit row. saveManifest swallows
 * GitHub errors but not the database reads that precede them, and the write it
 * follows is already committed — nothing here may fail the call.
 */
async function refreshManifest(classroomId: string): Promise<void> {
  try {
    await ClassmojiService.contentManifest.saveManifest(classroomId);
  } catch (error) {
    console.error('[mcp] content manifest refresh failed:', error);
  }
}

/** Load the dependents of a repository already verified to be in the classroom. */
async function loadDependents(repositoryId: string, classroomId: string) {
  const dependents = await ClassmojiService.repository.findDependents(repositoryId, classroomId);
  // Only reachable if the row vanished between the S1 load and this read.
  if (!dependents) throw scopedNotFound('Repo');
  return dependents;
}

interface RepoUpdateArgs {
  classroom: string;
  repository_id: string;
  description?: string | null;
  template?: string;
  type?: 'INDIVIDUAL' | 'GROUP';
  tag_id?: string | null;
  team_formation_mode?: 'INSTRUCTOR' | 'SELF_FORMED';
  team_formation_deadline?: string | null;
  max_team_size?: number | null;
  project_template_id?: string | null;
  project_template_title?: string | null;
}

type RepoPatchField = Exclude<keyof RepoUpdateArgs, 'classroom' | 'repository_id'>;

const REPO_PATCH_FIELDS: readonly RepoPatchField[] = [
  'description',
  'template',
  'type',
  'tag_id',
  'team_formation_mode',
  'team_formation_deadline',
  'max_team_size',
  'project_template_id',
  'project_template_title',
];

/** Fields baked into provisioned copies: frozen once any GitRepo exists. */
const STRUCTURAL_FIELDS: ReadonlySet<RepoPatchField> = new Set<RepoPatchField>([
  'template',
  'type',
  'team_formation_mode',
  'tag_id',
  'project_template_id',
  'project_template_title',
]);

/** Team settings that mean nothing on an INDIVIDUAL repo; cleared on GROUP→INDIVIDUAL. */
const CLEARED_ON_INDIVIDUAL: readonly RepoPatchField[] = [
  'tag_id',
  'team_formation_deadline',
  'max_team_size',
];

type PatchValue = string | number | Date | null;

/** Equal as stored values — dates by instant, absent and null alike. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const instant = (v: unknown) => (v instanceof Date ? v.getTime() : v == null ? null : NaN);
    return instant(a) === instant(b);
  }
  return (a ?? null) === (b ?? null);
}

export const repoUpdateTool: ToolDefinition<RepoUpdateArgs> = {
  name: 'repo_update',
  // Commits a content-manifest refresh to GitHub (best-effort) → openWorld. An
  // edit in place; the only values it clears are team fields a GROUP→INDIVIDUAL
  // switch makes meaningless → not destructive.
  annotations: { destructive: false, openWorld: true },
  title: 'Update a repo (assignment container)',
  description:
    'Edits a repository (assignment container). Owner only. Pass only the fields to change; ' +
    'null clears a nullable field. The title is fixed (git repo names derive from it) and grading ' +
    'weight lives on assignments. description, team_formation_deadline and max_team_size are ' +
    'always editable. template, type, team_formation_mode, tag_id and the project template are ' +
    'refused once student/team git repos exist, and template also while published. A GROUP repo ' +
    'with instructor-assigned teams needs a tag_id (ids from list_tags). Switching to INDIVIDUAL ' +
    "clears tag_id, team_formation_deadline and max_team_size. Refreshes the classroom's content " +
    'manifest on GitHub (best-effort).',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    repository_id: z.string().uuid().describe('Repository (assignment container) id'),
    description: z.string().max(2000).nullable().optional(),
    template: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('GitHub template repo name students are provisioned from'),
    type: z.enum(['INDIVIDUAL', 'GROUP']).optional(),
    tag_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe('Team tag id from list_tags (GROUP only)'),
    team_formation_mode: z.enum(['INSTRUCTOR', 'SELF_FORMED']).optional().describe('GROUP only'),
    team_formation_deadline: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe('GROUP only (ISO 8601); null clears it'),
    max_team_size: z.number().int().positive().nullable().optional().describe('GROUP only'),
    project_template_id: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub Projects V2 template node_id'),
    project_template_title: z
      .string()
      .nullable()
      .optional()
      .describe('Human-readable project template name'),
  },
  handler: async (args, ctx) => {
    const supplied = REPO_PATCH_FIELDS.filter(field => args[field] !== undefined);
    if (supplied.length === 0) {
      throw new ToolError(
        'invalid_params',
        `Provide at least one of: ${REPO_PATCH_FIELDS.join(', ')}`
      );
    }

    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);

    // S1 for the cross-record reference, exactly as repo_create checks it.
    if (args.tag_id) {
      const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.classroomId);
      if (!tags.some(t => t.id === args.tag_id)) {
        throw scopedNotFound('Tag');
      }
    }

    const patch: Partial<Record<RepoPatchField, PatchValue>> = {};
    for (const field of supplied) {
      const value = args[field];
      patch[field] =
        field === 'team_formation_deadline' && typeof value === 'string'
          ? new Date(value)
          : (value as PatchValue);
    }
    const current = repository as unknown as Record<RepoPatchField, unknown>;

    // Structural fields freeze once copies exist. Re-sending a field's current
    // value is not a change, so it passes.
    const structuralChanges = supplied.filter(
      field => STRUCTURAL_FIELDS.has(field) && !sameValue(patch[field], current[field])
    );
    if (structuralChanges.length > 0) {
      const dependents = await loadDependents(repository.id, classroom.classroomId);
      const provisioned = dependents._count.git_repos;
      if (provisioned > 0) {
        throw new ToolError(
          'invalid_params',
          `${provisioned} student/team git repo(s) already exist for this repo, so ` +
            `${structuralChanges.join(', ')} can no longer change. Only description, ` +
            'team_formation_deadline and max_team_size stay editable.',
          'REPOS_PROVISIONED',
          { fields: structuralChanges }
        );
      }
      // Web parity: the edit form makes the template read-only once published.
      if (structuralChanges.includes('template') && repository.is_published) {
        throw new ToolError(
          'invalid_params',
          'The template of a published repo cannot change — unpublish it first (repo_unpublish).',
          'REPO_PUBLISHED'
        );
      }
    }

    const mergedType = (patch.type ?? repository.type) as 'INDIVIDUAL' | 'GROUP';
    if (mergedType === 'INDIVIDUAL') {
      const groupOnly = supplied.filter(
        field =>
          (field === 'team_formation_mode' || CLEARED_ON_INDIVIDUAL.includes(field)) &&
          patch[field] !== null
      );
      if (groupOnly.length > 0) {
        throw new ToolError('invalid_params', `${groupOnly.join(', ')} apply to GROUP repos only`);
      }
      // GROUP→INDIVIDUAL: clear the team settings rather than leave them behind
      // as the web form does. Only on the flip itself (which the structural
      // lock has already vetted) — an edit to a row that is already INDIVIDUAL
      // never writes a field the caller did not name.
      if (repository.type === 'GROUP') {
        for (const field of CLEARED_ON_INDIVIDUAL) {
          if (patch[field] === undefined && current[field] != null) patch[field] = null;
        }
      }
    }

    // Validate the MERGED row — the web superRefine: instructor-assigned GROUP
    // teams need a tag.
    const mergedMode = patch.team_formation_mode ?? repository.team_formation_mode ?? 'INSTRUCTOR';
    const mergedTag = patch.tag_id !== undefined ? patch.tag_id : repository.tag_id;
    if (mergedType === 'GROUP' && mergedMode === 'INSTRUCTOR' && !mergedTag) {
      throw new ToolError(
        'invalid_params',
        'A GROUP repo with instructor-assigned teams requires tag_id (see list_tags)'
      );
    }

    // The patch keys are the validated field names above; the values are the
    // zod-checked enums/strings/numbers, and the deadline is already a Date.
    const updated = await ClassmojiService.repository.update(
      repository.id,
      patch as Parameters<typeof ClassmojiService.repository.update>[1],
      classroom.classroomId
    );
    if (!updated) throw scopedNotFound('Repo');

    // Every written key, auto-cleared team fields included, with its new value.
    const fields = Object.keys(patch);
    const values: Record<string, string | number | null> = {};
    for (const [field, value] of Object.entries(patch)) {
      values[field] = value instanceof Date ? value.toISOString() : (value ?? null);
    }

    await writeAudit(ctx, {
      resource_type: 'REPOSITORIES',
      resource_id: repository.id,
      action: 'UPDATE',
      // `value` is what keeps two different edits inside audit's 5s dedup window
      // from collapsing into one row; an identical re-send still dedups.
      data: { tool: 'repo_update', fields, values, value: JSON.stringify(values) },
    });

    await refreshManifest(classroom.classroomId);

    return ok({
      success: true,
      repository: {
        id: updated.id,
        title: updated.title,
        slug: updated.slug,
        type: updated.type,
        is_published: updated.is_published,
        template: updated.template,
        tag: updated.tag ? { id: updated.tag.id, name: updated.tag.name } : null,
        team_formation_mode: updated.team_formation_mode,
        team_formation_deadline: updated.team_formation_deadline?.toISOString() ?? null,
        max_team_size: updated.max_team_size,
        project_template_id: updated.project_template_id,
        project_template_title: updated.project_template_title,
        description: updated.description,
      },
    });
  },
};

interface RepoDeleteArgs {
  classroom: string;
  repository_id: string;
  confirm: true;
}

export const repoDeleteTool: ToolDefinition<RepoDeleteArgs> = {
  name: 'repo_delete',
  // Removes the repository and cascades its assignments → destructive,
  // confirm-gated by the schema. The manifest refresh commits to GitHub →
  // openWorld.
  annotations: { destructive: true, openWorld: true },
  title: 'Delete a repo (assignment container)',
  description:
    'Permanently deletes an UNPUBLISHED repository (assignment container) that has no student or ' +
    'team git repos yet. Owner only, destructive, requires confirm:true. A published repo is ' +
    'refused (unpublish it first); one whose student repos were already created is refused too — ' +
    'delete that from the web app. THIS CANNOT BE UNDONE and cascades: every assignment that ' +
    'submits through it, its module items, page/slide links and autograding tests go with it ' +
    '(all reported back); linked quizzes are kept but unlinked. Nothing on GitHub is deleted. ' +
    "Refreshes the classroom's content manifest (best-effort).",
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    repository_id: z.string().uuid().describe('Repository (assignment container) id'),
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges its assignments are deleted with it'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const repository = await loadRepositoryInClassroom(args.repository_id, ctx);

    if (repository.is_published) {
      throw new ToolError(
        'invalid_params',
        'This repo is published — unpublish it first (repo_unpublish). A repo whose student ' +
          'repositories were already created can only be deleted from the web app.',
        'REPO_PUBLISHED'
      );
    }

    const dependents = await loadDependents(repository.id, classroom.classroomId);
    if (dependents._count.git_repos > 0) {
      throw new ToolError(
        'invalid_params',
        `${dependents._count.git_repos} student/team git repo(s) were already created from this ` +
          'repo — delete it from the web app instead.',
        'REPOS_PROVISIONED'
      );
    }

    await ClassmojiService.repository.deleteById(repository.id, classroom.classroomId);

    // The cascade's blast radius, for the audit trail and the response.
    const assignmentsDeleted = dependents.assignments.map(a => ({ id: a.id, title: a.title }));
    const cascade = {
      module_items_removed: dependents._count.module_items,
      page_links_removed: dependents._count.pages,
      slide_links_removed: dependents._count.slides,
      autograding_tests_deleted: dependents._count.autograding_tests,
      quizzes_unlinked: dependents._count.quizzes,
    };

    await writeAudit(ctx, {
      resource_type: 'REPOSITORIES',
      resource_id: repository.id,
      action: 'DELETE',
      data: {
        tool: 'repo_delete',
        title: repository.title,
        slug: repository.slug,
        assignments_deleted: assignmentsDeleted,
        ...cascade,
      },
    });

    await refreshManifest(classroom.classroomId);

    return ok({
      success: true,
      deleted_repository_id: repository.id,
      title: repository.title,
      assignments_deleted: assignmentsDeleted,
      assignments_deleted_count: assignmentsDeleted.length,
      ...cascade,
    });
  },
};
