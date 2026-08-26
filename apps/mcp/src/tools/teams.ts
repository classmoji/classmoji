/**
 * Team tools — team_create / team_delete / team_rename, team_members_add /
 * team_member_remove, team_tag_add / team_tag_remove.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.teams*, all gated by assertClassroomAccess
 * with allowedRoles ['OWNER'] — OWNER only for all seven.
 *
 * Backbone: ClassmojiService.teamAdmin.* (extracted so the web routes and these
 * tools take ONE code path — same precedent as roster.service.ts and
 * assistant.service.ts). Two properties of that service matter here:
 *
 *   1. RESOLVE FIRST. Every function looks the team up by (classroom_id,
 *      slug|id) BEFORE anything reaches GitHub, so `team_not_found` always beats
 *      a provider call, and the classroom's own `{slug}-students` /
 *      `-assistants` GitHub teams — which have no local Team row — are
 *      unreachable from this surface.
 *   2. PARTIAL WORK IS REPORTED, NOT SWALLOWED. The bulk operations hand back
 *      per-item `failed` lists; these tools surface every one of them.
 *
 * S1: classroomId is ALWAYS ctx.classroom.classroomId, never request input, so
 * every lookup inside the service is classroom-scoped already. A team ref that
 * names nothing and one that names another classroom's team both come back as
 * the same scopedNotFound('Team'), so a cross-classroom probe cannot enumerate
 * foreign teams. The same holds for tags (Tag is classroom-scoped) and for the
 * TeamTag rows team_tag_remove resolves.
 *
 * RESPONSES ARE ALLOW-LISTED: team.findByClassroomId returns memberships with
 * full User rows attached (contact PII included), so no service row is ever
 * spread into a response — every payload below is built field by field.
 */

import {
  ClassmojiService,
  TeamServiceError,
  describeTeamFailureReason,
  type TeamFailureReason,
} from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/**
 * Map the service's caller-fixable failures onto tool errors.
 *
 * - `team_not_found` / `tag_not_found` → the uniform scopedNotFound: an unknown
 *   ref and another classroom's record are indistinguishable to the caller.
 * - `user_not_found` → a PLAIN not_found: the miss is on a global user lookup,
 *   not on a classroom-scoped record, so there is nothing to leak.
 * - `no_org_configured` → invalid_params with a neutral message of our own; the
 *   service's message embeds the internal classroom id.
 * - `invalid_name` / `reserved_name` / `name_collision` / `provider_unsupported`
 *   → invalid_params carrying the service's own message (minus its log prefix):
 *   it names the offending team/organization, which is what the caller needs to
 *   fix the call, and every one of those checks already ran classroom-scoped.
 * - `classroom_not_found` is unreachable (the id comes from a resolved ctx) and
 *   anything else is returned unchanged for the registry's generic wrapper.
 */
function mapTeamError(error: unknown): unknown {
  if (!(error instanceof TeamServiceError)) return error;
  switch (error.code) {
    case 'team_not_found':
      return scopedNotFound('Team');
    case 'tag_not_found':
      return scopedNotFound('Tag');
    case 'user_not_found':
      return new ToolError('not_found', 'No Classmoji user with that login');
    case 'no_org_configured':
      return new ToolError(
        'invalid_params',
        'This classroom has no linked GitHub organization — teams cannot be managed'
      );
    case 'invalid_name':
    case 'reserved_name':
    case 'name_collision':
    case 'provider_unsupported':
      return new ToolError('invalid_params', error.message.replace(/^\[team\]\s*/, ''));
    default:
      return error;
  }
}

// ─── Shared shapes + helpers ────────────────────────────────────────────────

/** The subset of team.findByClassroomId we read (never the memberships). */
interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  is_visible: boolean;
  tags?: Array<{ id: string; tag_id: string; tag?: { id: string; name: string } | null }>;
}

/**
 * Resolve a team by slug OR id inside the authorized classroom (S1), the same
 * way the service does, and hand back its tag rows.
 *
 * Two tools need the team id for their audit row before the service call
 * (addTeamMembers/addTeamTags return only per-item results), and team_tag_remove
 * needs the TeamTag row id, which list_teams does not expose. The service still
 * re-resolves the team itself, so this stays a lookup — the mutation path is
 * unchanged. A team deleted between this lookup and the service call simply
 * surfaces as the mapped `team_not_found`.
 */
async function resolveTeamInClassroom(ref: string, ctx: ToolContext): Promise<TeamRecord> {
  const classroom = requireClassroomCtx(ctx);
  const teams = (await ClassmojiService.team.findByClassroomId(
    classroom.classroomId
  )) as TeamRecord[];
  const team = teams.find(t => t.slug === ref || t.id === ref);
  if (!team) throw scopedNotFound('Team');
  return team;
}

/**
 * Per-item failures carry the service's CLOSED reason vocabulary, never the
 * raw provider/database message (which the service logs instead). Both the
 * code and its phrase are surfaced: the code is what a caller can branch on,
 * the phrase is what it can repeat to a user.
 */
const describeFailure = (reason: TeamFailureReason) => ({
  error: reason,
  error_description: describeTeamFailureReason(reason),
});

/** Per-tag failure in platform vocabulary (the service uses camelCase). */
const tagFailures = (failed: Array<{ tagId: string; error: TeamFailureReason }>) =>
  failed.map(f => ({ tag_id: f.tagId, ...describeFailure(f.error) }));

/**
 * Normalize a login the way teamAdmin.service does before its case-insensitive
 * lookup, so the membership pre-check accepts exactly what the service accepts.
 */
const normalizeLogin = (login: string) => login.replace('@', '').trim().toLowerCase();

/**
 * The normalized logins of everyone who belongs to the authorized classroom in
 * any role.
 *
 * DELIBERATELY STRICTER THAN THE WEB FORMS, which forward whatever logins they
 * are given: on this surface every login named by a team tool must belong to
 * THIS classroom, so an arbitrary GitHub account can neither be pulled into an
 * organization team nor probed against one.
 */
async function classroomMemberLogins(classroomId: string): Promise<Set<string>> {
  const memberships = (await ClassmojiService.classroomMembership.findByClassroomId(
    classroomId
  )) as Array<{ user?: { login?: string | null } | null }>;
  return new Set(
    memberships
      .map(m => m.user?.login)
      .filter((login): login is string => Boolean(login))
      .map(normalizeLogin)
  );
}

const teamRefSchema = z.string().min(1).describe("The team's slug or id (from list_teams)");

const tagIdsSchema = z
  .array(z.string().min(1))
  .max(20)
  .describe('Tag ids to attach (tags must belong to this classroom)');

// ─── team_create ────────────────────────────────────────────────────────────

interface TeamCreateArgs {
  classroom: string;
  name: string;
  is_visible?: boolean;
  tag_ids?: string[];
}

export const teamCreateTool: ToolDefinition<TeamCreateArgs> = {
  name: 'team_create',
  // Creates a REAL GitHub team (openWorld). Adds records only — nothing removed.
  annotations: { destructive: false, openWorld: true },
  title: 'Create a team',
  description:
    'Creates a team in the classroom: a real team in the classroom GitHub organization plus its ' +
    'Classmoji record. Owner only. GitHub derives the slug from the name. Names that would ' +
    "collide with an existing org team, or that end in '-students' / '-assistants' (reserved for " +
    "the classroom's own membership teams), are refused before anything is created. is_visible " +
    'is recorded on the team but no read path currently varies on it: in list_teams a student ' +
    'sees the teams they belong to and the teaching team sees them all, either way. tag_ids ' +
    'attach classroom tags at creation time; a tag id ' +
    'from another classroom is reported in tags_failed and the team is still created. Add members ' +
    'afterwards with team_members_add.',
  scope: 'write',
  roles: OWNER_ONLY,
  // Tighter than the default bucket: every call creates a real GitHub team —
  // a burst of 5, roughly 3 per minute sustained.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    name: z.string().trim().min(1).max(200).describe('Team name'),
    is_visible: z
      .boolean()
      .optional()
      .describe(
        'Stored on the team as a visibility hint (default false). No read path reads it today: ' +
          'list_teams shows a student their own teams regardless of this flag.'
      ),
    tag_ids: tagIdsSchema.optional(),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      // classroomId is ALWAYS the authorized classroom, never request input.
      result = await ClassmojiService.teamAdmin.createTeam({
        classroomId: classroom.classroomId,
        name: args.name,
        isVisible: args.is_visible ?? false,
        tagIds: args.tag_ids ?? [],
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    // Audit right after the service call: the GitHub team and the local row are
    // already committed, so nothing downstream may leave the mutation
    // un-audited. resource_id names the team — it is also part of the audit
    // dedup key, so two creates in the same window stay two rows.
    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: result.team.id,
      action: 'CREATE',
      data: {
        tool: 'team_create',
        team_id: result.team.id,
        slug: result.team.slug,
        is_visible: result.team.isVisible,
        tags_added: result.tagsAdded.length,
        tags_failed: result.tagsFailed.length,
      },
    });

    return ok({
      success: true,
      team: {
        id: result.team.id,
        name: result.team.name,
        slug: result.team.slug,
        is_visible: result.team.isVisible,
      },
      tags_added: result.tagsAdded,
      tags_failed: tagFailures(result.tagsFailed),
    });
  },
};

// ─── team_delete ────────────────────────────────────────────────────────────

interface TeamDeleteArgs {
  classroom: string;
  team: string;
  confirm: true;
}

export const teamDeleteTool: ToolDefinition<TeamDeleteArgs> = {
  name: 'team_delete',
  // Deletes the GitHub team AND local records that cascade from it → destructive
  // + openWorld. Requires confirm:true (enforced by the schema).
  annotations: { destructive: true, openWorld: true },
  title: 'Delete a team',
  description:
    'Deletes a team: the team in the classroom GitHub organization and its Classmoji record. ' +
    'Owner only, destructive, requires confirm:true. The GitHub REPOSITORIES themselves survive — ' +
    "they stay in the organization. Classmoji's RECORDS of them do not: every linked repo record " +
    'is permanently deleted along with the team, and that takes its submissions, grades, grader ' +
    'assignments, regrade requests, token transactions and analytics with it. That history cannot ' +
    'be restored from this surface or any other, so when the team has graded work use team_rename ' +
    '(or remove its members) instead. Team memberships and tag links go too. The response reports ' +
    'repos_deleted — check it against list_repos BEFORE confirming if you are unsure what the ' +
    'team owns. If the team is already gone on GitHub the local record is still removed and ' +
    'removed_from_provider comes back false.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    confirm: z
      .literal(true)
      .describe(
        'Must be true — acknowledges the GitHub team and the linked repo records (with their ' +
          'grading history) are permanently deleted'
      ),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      result = await ClassmojiService.teamAdmin.deleteTeam({
        classroomId: classroom.classroomId,
        slugOrId: args.team,
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: result.id,
      action: 'DELETE',
      data: {
        tool: 'team_delete',
        team_id: result.id,
        slug: result.slug,
        removed_from_provider: result.removedFromProvider,
        // Blast radius on the audit row: the repo records (and their grading
        // history) are gone, so the trail is the only place left that says
        // what the delete cost.
        repos_deleted: result.reposDeleted,
        deleted_repo_names: result.deletedRepoNames,
      },
    });

    const repoNote =
      result.reposDeleted > 0
        ? ` ${result.reposDeleted} linked repository record(s) were deleted with it, along with ` +
          'their submissions, grades and analytics; the GitHub repositories themselves remain.'
        : '';

    return ok({
      success: true,
      id: result.id,
      name: result.name,
      slug: result.slug,
      removed_from_provider: result.removedFromProvider,
      repos_deleted: result.reposDeleted,
      deleted_repo_names: result.deletedRepoNames,
      message:
        (result.removedFromProvider
          ? `Team '${result.slug}' was deleted on GitHub and removed from Classmoji.`
          : `Team '${result.slug}' was already gone on GitHub; the Classmoji record was removed.`) +
        repoNote,
    });
  },
};

// ─── team_rename ────────────────────────────────────────────────────────────

interface TeamRenameArgs {
  classroom: string;
  team: string;
  new_name: string;
}

export const teamRenameTool: ToolDefinition<TeamRenameArgs> = {
  name: 'team_rename',
  // Renames the GitHub team and its repos — an update, nothing is deleted.
  annotations: { destructive: false, openWorld: true },
  title: 'Rename a team',
  description:
    'Renames a team on GitHub and in Classmoji, then renames every linked repository so it ' +
    'carries the new team slug. Owner only, GitHub organizations only. A name already used by ' +
    "another team in this classroom, or one ending in '-students' / '-assistants', is refused " +
    'before the rename runs. IMPORTANT: repositories are renamed one at a time and any that fail ' +
    'come back in `failed`. Those CANNOT be fixed by running team_rename again — the team already ' +
    'carries the new slug, so a second pass no longer matches the old repository names, and each ' +
    'listed repository has to be renamed by hand on GitHub. Always report `failed` to the user.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    new_name: z.string().trim().min(1).max(200).describe('The new team name'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      result = await ClassmojiService.teamAdmin.renameTeam({
        classroomId: classroom.classroomId,
        slugOrId: args.team,
        newName: args.new_name,
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: result.teamId,
      action: 'UPDATE',
      data: {
        tool: 'team_rename',
        team_id: result.teamId,
        new_slug: result.newSlug,
        renamed_repos: result.renamedRepos.length,
        failed_repos: result.failed.map(f => f.name),
      },
    });

    const failed = result.failed.map(f => ({ name: f.name, ...describeFailure(f.error) }));
    return ok({
      success: true,
      team_id: result.teamId,
      new_name: result.newName,
      new_slug: result.newSlug,
      renamed_repos: result.renamedRepos,
      renamed_repo_count: result.renamedRepos.length,
      failed,
      failed_count: failed.length,
      // Surfaced at the top level so a partial rename is not lost in the payload.
      ...(failed.length > 0
        ? {
            warning:
              `${failed.length} repository rename(s) FAILED and cannot be recovered by running ` +
              'team_rename again — rename them by hand on GitHub: ' +
              failed.map(f => f.name).join(', '),
          }
        : {}),
      message:
        failed.length > 0
          ? `Team renamed to '${result.newSlug}', but some repositories still carry the old name.`
          : `Team renamed to '${result.newSlug}'.`,
    });
  },
};

// ─── team_members_add ───────────────────────────────────────────────────────

interface TeamMembersAddArgs {
  classroom: string;
  team: string;
  logins: string[];
}

export const teamMembersAddTool: ToolDefinition<TeamMembersAddArgs> = {
  name: 'team_members_add',
  // Adds people to a real GitHub team (openWorld); nothing is removed.
  annotations: { destructive: false, openWorld: true },
  title: 'Add members to a team',
  description:
    'Adds people to a team by GitHub username, on GitHub and in Classmoji. Owner only. Every ' +
    'login must already be a member of THIS classroom in some role — the whole call is refused, ' +
    'with the offending logins named, if any is not (get_roster and list_teaching_team show who ' +
    'is). Members are added one at a time and throttled, so a large list takes a while; each ' +
    'login is reported in succeeded or failed and one failure does not stop the rest. Re-adding ' +
    'an existing member is a no-op.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    logins: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(100)
      .describe('GitHub usernames to add (1–100); each must be a member of this classroom'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // S1 + audit: resolve the team inside the authorized classroom first, so an
    // unknown/foreign ref is the uniform not_found before anything else runs and
    // the audit row can name the team (addTeamMembers returns no team id).
    const team = await resolveTeamInClassroom(args.team, ctx);

    // Every login must resolve to a member of THIS classroom (any role) or the
    // whole call is refused — see classroomMemberLogins.
    const classroomLogins = await classroomMemberLogins(classroom.classroomId);

    // Dedupe on the same normalized key the service matches on, so 'Ada' and
    // '@ada' do not cost two throttled provider calls.
    const requested = new Map<string, string>();
    for (const login of args.logins) {
      const key = normalizeLogin(login);
      if (key && !requested.has(key)) requested.set(key, login);
    }

    const notMembers = [...requested].filter(([key]) => !classroomLogins.has(key));
    if (notMembers.length > 0) {
      const logins = notMembers.map(([, original]) => original);
      throw new ToolError(
        'invalid_params',
        `Not a member of this classroom: ${logins.join(', ')} — add them to the classroom first ` +
          '(roster_add_student or assistant_add). No one was added to the team.',
        undefined,
        { logins }
      );
    }

    let result;
    try {
      result = await ClassmojiService.teamAdmin.addTeamMembers({
        classroomId: classroom.classroomId,
        slugOrId: args.team,
        logins: [...requested.values()],
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: team.id,
      action: 'UPDATE',
      data: {
        tool: 'team_members_add',
        team_id: team.id,
        slug: team.slug,
        succeeded: result.succeeded.map(s => s.login),
        failed: result.failed.map(f => f.login),
      },
    });

    return ok({
      success: true,
      team_id: team.id,
      team_slug: team.slug,
      succeeded: result.succeeded.map(s => s.login),
      succeeded_count: result.succeeded.length,
      failed: result.failed.map(f => ({ login: f.login, ...describeFailure(f.error) })),
      failed_count: result.failed.length,
    });
  },
};

// ─── team_member_remove ─────────────────────────────────────────────────────

interface TeamMemberRemoveArgs {
  classroom: string;
  team: string;
  login: string;
}

export const teamMemberRemoveTool: ToolDefinition<TeamMemberRemoveArgs> = {
  name: 'team_member_remove',
  // Removes a membership on GitHub and locally → destructive + openWorld, but
  // repeating the call changes nothing further → idempotent.
  annotations: { destructive: true, idempotent: true, openWorld: true },
  title: 'Remove a member from a team',
  description:
    'Removes one person from a team, on GitHub and in Classmoji. Owner only. The login must be a ' +
    'member of THIS classroom in some role (get_roster and list_teaching_team show who is); any ' +
    'other login is refused. This only drops the team membership — it does not remove them from ' +
    'the classroom or the GitHub organization, and no repository is deleted; they simply lose the ' +
    'access the team granted. Idempotent: if they were not a member of the team, the call still ' +
    'succeeds and reports removed:false.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    login: z
      .string()
      .min(1)
      .max(100)
      .describe('The member GitHub username; must be a member of this classroom'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Same order as team_members_add: the team is resolved inside the
    // authorized classroom first (S1), then the login is checked against
    // classroom membership.
    await resolveTeamInClassroom(args.team, ctx);

    // ONE uniform refusal for both "no such Classmoji user" and "not in this
    // classroom": without it the tool's two error shapes would differ, and the
    // service's own user_not_found would answer a question about who exists on
    // the platform. That branch of mapTeamError stays as a backstop.
    const classroomLogins = await classroomMemberLogins(classroom.classroomId);
    if (!classroomLogins.has(normalizeLogin(args.login))) {
      throw new ToolError(
        'invalid_params',
        `Not a member of this classroom: ${args.login} — nobody was removed from the team.`,
        undefined,
        { logins: [args.login] }
      );
    }

    let result;
    try {
      result = await ClassmojiService.teamAdmin.removeTeamMember({
        classroomId: classroom.classroomId,
        slugOrId: args.team,
        login: args.login,
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: result.teamId,
      action: 'UPDATE',
      data: {
        tool: 'team_member_remove',
        team_id: result.teamId,
        login: result.login,
        removed: result.removed,
      },
    });

    return ok({
      success: true,
      team_id: result.teamId,
      login: result.login,
      removed: result.removed,
      message: result.removed
        ? `${result.login} was removed from the team.`
        : `${result.login} held no membership row on this team — the GitHub team membership was cleared anyway.`,
    });
  },
};

// ─── team_tag_add ───────────────────────────────────────────────────────────

interface TeamTagAddArgs {
  classroom: string;
  team: string;
  tag_ids: string[];
}

export const teamTagAddTool: ToolDefinition<TeamTagAddArgs> = {
  name: 'team_tag_add',
  // Database-only link rows: no provider call, and re-attaching an already
  // attached tag is a no-op that still reports it as added → idempotent.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Attach tags to a team',
  description:
    'Attaches classroom tags to a team (Classmoji only — nothing is written to GitHub). Owner ' +
    'only. Tags group teams for assignment distribution. Tag ids must belong to this classroom; ' +
    'ones that do not are reported in failed while the rest are still attached. Attaching a tag ' +
    'the team already has is a no-op and counts as added.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    tag_ids: tagIdsSchema.min(1),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // S1 + audit: same reason as team_members_add — addTeamTags returns per-tag
    // results only, with no team id for the audit row.
    const team = await resolveTeamInClassroom(args.team, ctx);

    let result;
    try {
      result = await ClassmojiService.teamAdmin.addTeamTags({
        classroomId: classroom.classroomId,
        slugOrId: args.team,
        tagIds: args.tag_ids,
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: team.id,
      action: 'UPDATE',
      data: {
        tool: 'team_tag_add',
        team_id: team.id,
        added: result.added,
        failed: result.failed.map(f => f.tagId),
      },
    });

    return ok({
      success: true,
      team_id: team.id,
      team_slug: team.slug,
      added: result.added,
      added_count: result.added.length,
      failed: tagFailures(result.failed),
      failed_count: result.failed.length,
    });
  },
};

// ─── team_tag_remove ────────────────────────────────────────────────────────

interface TeamTagRemoveArgs {
  classroom: string;
  team: string;
  tag_name?: string;
  tag_id?: string;
}

export const teamTagRemoveTool: ToolDefinition<TeamTagRemoveArgs> = {
  name: 'team_tag_remove',
  // Deletes the link row (a removal), database only, and a second call errors
  // rather than repeating cleanly → not idempotent.
  annotations: { destructive: true, openWorld: false },
  title: 'Detach a tag from a team',
  description:
    'Detaches a tag from a team (Classmoji only — nothing is written to GitHub). Owner only. ' +
    'Identify the tag by tag_name (as shown in list_teams) or tag_id; the tag itself is not ' +
    'deleted, only its link to this team. A tag that is not on this team is reported as not ' +
    'found.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    team: teamRefSchema,
    tag_name: z.string().min(1).optional().describe('Tag name as shown in list_teams'),
    tag_id: z.string().min(1).optional().describe('Tag id (alternative to tag_name)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    if (!args.tag_name && !args.tag_id) {
      throw new ToolError('invalid_params', 'Provide tag_name or tag_id');
    }

    // list_teams exposes tag NAMES only — no TeamTag row ids — so the row the
    // service deletes is resolved here, inside the authorized classroom (S1),
    // from the team's own tag list. The service remains the single mutation
    // path and re-checks the row against the classroom itself.
    const team = await resolveTeamInClassroom(args.team, ctx);
    const tags = team.tags ?? [];

    let matches;
    if (args.tag_id) {
      matches = tags.filter(tt => tt.tag_id === args.tag_id);
    } else {
      const wanted = (args.tag_name ?? '').trim();
      // Tag is unique on (classroom_id, name) CASE-SENSITIVELY, so 'Frontend'
      // and 'frontend' can both exist: match exactly first, and only fall back
      // to a case-insensitive match when it is unambiguous.
      matches = tags.filter(tt => tt.tag?.name === wanted);
      if (matches.length === 0) {
        matches = tags.filter(tt => tt.tag?.name?.toLowerCase() === wanted.toLowerCase());
      }
    }

    if (matches.length === 0) throw scopedNotFound('Tag');
    if (matches.length > 1) {
      throw new ToolError(
        'invalid_params',
        `Several tags on this team match that name (${matches
          .map(m => m.tag?.name)
          .join(', ')}) — pass tag_id instead`
      );
    }

    let result;
    try {
      result = await ClassmojiService.teamAdmin.removeTeamTag({
        classroomId: classroom.classroomId,
        teamTagId: matches[0].id,
      });
    } catch (error) {
      throw mapTeamError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'TEAMS',
      resource_id: result.teamId,
      action: 'UPDATE',
      data: {
        tool: 'team_tag_remove',
        team_id: result.teamId,
        tag_id: result.tagId,
        team_tag_id: result.teamTagId,
      },
    });

    return ok({
      success: true,
      team_id: result.teamId,
      team_slug: team.slug,
      tag_id: result.tagId,
      tag_name: matches[0].tag?.name ?? null,
      team_tag_id: result.teamTagId,
    });
  },
};
