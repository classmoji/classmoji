/**
 * Teaching-staff tools — staff_add / staff_update / staff_remove.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.assistants/action.ts, gated by
 * requireClassroomAdmin — OWNER only for all three. The web screen manages
 * ASSISTANTs; these tools cover the whole staff range (ASSISTANT / TEACHER /
 * OWNER), which is why granting OWNER carries its own confirm gate.
 *
 * Backbone: ClassmojiService.staff.* (extracted in phase A so the web route
 * and these tools take ONE code path — same precedent as roster.service.ts).
 * The service resolves the GitHub profile SERVER-SIDE from the login, so a tool
 * caller holding only a login works and no client can choose the provider_id
 * the account is keyed to.
 *
 * S1: classroomId is ALWAYS ctx.classroom.classroomId, never request input, so
 * every membership lookup inside the service is already classroom-scoped. A
 * login that names nobody, or someone who does not hold that role *here*, comes
 * back as the same `staff_not_found` → the uniform scopedNotFound, so a
 * cross-classroom probe cannot enumerate foreign staff.
 */

import { ClassmojiService, StaffServiceError, type StaffRole } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/** The three staff roles these tools manage; STUDENT belongs to the roster tools. */
const STAFF_ROLES = ['ASSISTANT', 'TEACHER', 'OWNER'] as const;

/**
 * Shared prose so all three tools describe the same model. The multi-role rule
 * is the one a caller is most likely to get wrong: roles ADD UP rather than
 * replace, because a membership is unique on (classroom, user, role).
 */
const ROLE_MODEL_NOTE =
  'ASSISTANT is the common case (TAs). Roles are additive: adding a role to someone who already ' +
  'holds another in this classroom GRANTS AN ADDITIONAL role and leaves the existing one in ' +
  'place (they are then treated at their highest role). All staff roles share one GitHub staff ' +
  'team, so the GitHub-side access is the same for all three. Use list_teaching_team to read the ' +
  'current staff and their roles.';

/**
 * Map the service's caller-fixable failures onto tool errors.
 *
 * - `git_user_not_found` → a PLAIN not_found: the miss is on GitHub's user
 *   lookup, not on a classroom-scoped record, so there is nothing to leak and
 *   the message should say what actually failed.
 * - `staff_not_found` → the uniform scopedNotFound (unknown login and "holds
 *   that role in another classroom" are indistinguishable to the caller).
 * - `no_org_configured` → invalid_params: the classroom is not linked to a git
 *   organization, so staff cannot be managed until that is fixed.
 * - `login_conflict` → invalid_params with a neutral message: the stored user
 *   record is keyed to a different account than this login resolves to, which
 *   only a human with both records in front of them can untangle.
 * - `last_owner` → invalid_params naming the reason: the classroom would be
 *   left with no owner, which is a fixable mistake (add another owner first).
 * - `grader_flag_invalid` → invalid_params: is_grader is meaningless on an
 *   OWNER membership.
 * - `classroom_not_found` is unreachable (the id comes from a resolved ctx) and
 *   anything else is returned unchanged for the registry's generic wrapper.
 */
function mapStaffError(error: unknown): unknown {
  if (!(error instanceof StaffServiceError)) return error;
  switch (error.code) {
    case 'git_user_not_found':
      return new ToolError('not_found', 'GitHub user not found');
    case 'staff_not_found':
      return scopedNotFound('Staff member');
    case 'no_org_configured':
      return new ToolError(
        'invalid_params',
        'This classroom has no linked GitHub organization — staff cannot be managed'
      );
    case 'login_conflict':
      return new ToolError(
        'invalid_params',
        'This login is associated with a different account — contact support'
      );
    case 'last_owner':
      return new ToolError(
        'invalid_params',
        'This is the only owner of the classroom — add another owner before removing this one'
      );
    case 'grader_flag_invalid':
      return new ToolError(
        'invalid_params',
        'is_grader applies to ASSISTANT and TEACHER only — owners do not join the grading pool'
      );
    default:
      return error;
  }
}

interface StaffAddArgs {
  classroom: string;
  login: string;
  role: StaffRole;
  name?: string;
  email?: string;
  confirm?: true;
}

/**
 * The raw shape registered with the MCP server (the registry takes a
 * ZodRawShape) and, below it, the same shape closed into an object with the
 * cross-field rule the raw shape cannot express: `confirm` is REQUIRED for
 * OWNER and irrelevant otherwise. Both surfaces are built from this one
 * constant so they cannot drift.
 */
const staffAddShape = {
  classroom: z.string().describe("Classroom reference as 'org/slug'"),
  login: z.string().min(1).max(100).describe('The staff member GitHub username'),
  role: z
    .enum(STAFF_ROLES)
    .describe(
      'ASSISTANT (TA — the usual choice), TEACHER (co-instructor), or OWNER (co-owner: full ' +
        'control, requires confirm:true)'
    ),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Display name override (defaults to their GitHub profile name)'),
  email: z.string().email().optional().describe('Contact email override'),
  confirm: z
    .literal(true)
    .optional()
    .describe(
      'Required ONLY when role is OWNER — acknowledges handing over full control of the ' +
        'classroom, including the ability to delete it'
    ),
};

/** staffAddShape + the OWNER-only confirm rule. Exported so tests pin the gate. */
export const staffAddArgsSchema = z.object(staffAddShape).superRefine((args, ctx) => {
  if (args.role === 'OWNER' && args.confirm !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['confirm'],
      message:
        'confirm:true is required when role is OWNER — a co-owner gains full control of the ' +
        'classroom, including deleting it',
    });
  }
});

export const staffAddTool: ToolDefinition<StaffAddArgs> = {
  name: 'staff_add',
  // Sends a REAL GitHub org invite (openWorld). Adds a membership only —
  // nothing is removed, so not destructive.
  annotations: { destructive: false, openWorld: true },
  title: 'Add a teaching-staff member',
  description:
    "Adds someone to the classroom's teaching team by GitHub username at the given role, and " +
    'invites them to the classroom GitHub organization if they are not already a member (someone ' +
    'already in the org is added straight to the staff team instead). Owner only. Idempotent per ' +
    'role: if they already hold that role here it reports already_exists and changes nothing. New ' +
    'members must accept the GitHub org invite before their access is live. ' +
    ROLE_MODEL_NOTE +
    ' Use staff_update to make an assistant or teacher a grader. OWNER requires confirm:true: a ' +
    'co-owner gains full control of the classroom, including deleting it. Note that a co-owner ' +
    'added here holds a Classmoji role, NOT GitHub organization admin — operations that act with ' +
    "the requesting person's own GitHub credentials (notably the danger-zone GitHub cleanup when " +
    'deleting a classroom) will fail for a co-owner who is not a GitHub org admin.',
  scope: 'write',
  roles: OWNER_ONLY,
  // Tighter than the default bucket: every call can send a real GitHub org
  // invitation, so cap it at a burst of 5 and roughly 3 per minute sustained.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  inputSchema: staffAddShape,
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // The OWNER-only confirm rule lives in the schema; the raw shape the
    // registry hands the SDK cannot carry a cross-field refinement, so it is
    // applied here before anything else runs.
    const parsed = staffAddArgsSchema.safeParse(args);
    if (!parsed.success) {
      throw new ToolError('invalid_params', parsed.error.issues[0]?.message ?? 'Invalid arguments');
    }

    let result;
    try {
      // classroomId is ALWAYS the authorized classroom, never request input.
      result = await ClassmojiService.staff.addStaff({
        classroomId: classroom.classroomId,
        login: parsed.data.login,
        role: parsed.data.role,
        name: parsed.data.name,
        email: parsed.data.email,
      });
    } catch (error) {
      throw mapStaffError(error);
    }

    // An already-existing membership at this role short-circuits inside the
    // service BEFORE any GitHub or DB write — no mutation to audit in that case.
    if (!result.created) {
      return ok({
        success: true,
        created: false,
        already_exists: true,
        login: result.login,
        user_id: result.userId,
        role: result.role,
        message: `${result.login} already holds the ${result.role} role in this classroom — nothing changed.`,
      });
    }

    // Audit right after the service call: the membership (and the GitHub team
    // add / org invite) is already committed, so nothing downstream may leave
    // the mutation un-audited (plan §5.1). The ROLE is the point of the record.
    await writeAudit(ctx, {
      resource_type: 'STAFF',
      resource_id: result.userId,
      action: 'CREATE',
      data: {
        tool: 'staff_add',
        user_id: result.userId,
        login: result.login,
        role: result.role,
        already_org_member: result.alreadyOrgMember,
      },
    });

    return ok({
      success: true,
      created: true,
      already_exists: false,
      login: result.login,
      user_id: result.userId,
      name: result.name,
      role: result.role,
      // Already-in-org staff are added straight to the staff team; everyone
      // else gets an org invite they must accept before access is live.
      github: result.alreadyOrgMember ? 'team_added' : 'invited',
      invite_pending: !result.alreadyOrgMember,
      message: result.alreadyOrgMember
        ? `${result.login} was already in the GitHub org and has been added to the staff team as ${result.role}.`
        : `${result.login} has been invited to the GitHub organization as ${result.role} — their access goes live once they accept the invite.`,
    });
  },
};

interface StaffUpdateArgs {
  classroom: string;
  login: string;
  role: StaffRole;
  is_grader: boolean;
}

export const staffUpdateTool: ToolDefinition<StaffUpdateArgs> = {
  name: 'staff_update',
  // Flips one flag on our own DB row: no deletion, no GitHub call, and setting
  // the same value twice is a no-op → idempotent.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Update a teaching-staff member',
  description:
    'Sets whether a staff member is a grader (is_grader) on their membership at the given role in ' +
    'this classroom. Owner only. Only grader-flagged ASSISTANT and TEACHER members take part in ' +
    'grader_assign_bulk RANDOM distribution; owners do not join the grading pool, so role:OWNER ' +
    'is refused here. Because roles are additive, the role argument picks WHICH membership to ' +
    'update for someone who holds more than one. Identify them by GitHub username; ' +
    'list_teaching_team shows the current staff and their roles.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    login: z.string().min(1).max(100).describe('The staff member GitHub username'),
    role: z
      .enum(STAFF_ROLES)
      .describe('Which membership to update — ASSISTANT or TEACHER (OWNER has no grader flag)'),
    is_grader: z.boolean().describe('Whether this staff member grades submissions'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let membership;
    try {
      // Role-scoped inside the service: a user who is both OWNER and ASSISTANT
      // here has two membership rows and only the named one is touched.
      membership = await ClassmojiService.staff.updateStaff({
        classroomId: classroom.classroomId,
        login: args.login,
        role: args.role,
        isGrader: args.is_grader,
      });
    } catch (error) {
      throw mapStaffError(error);
    }

    // resource_id identifies WHICH staff member was updated. It is also what
    // keeps back-to-back updates to different people as separate audit rows:
    // the audit dedup key includes it, so without it two flips inside the dedup
    // window would collapse into one record.
    await writeAudit(ctx, {
      resource_type: 'STAFF',
      resource_id: membership.user_id,
      action: 'UPDATE',
      data: {
        tool: 'staff_update',
        user_id: membership.user_id,
        login: args.login,
        role: args.role,
        is_grader: args.is_grader,
      },
    });

    return ok({ success: true, login: args.login, role: args.role, is_grader: args.is_grader });
  },
};

interface StaffRemoveArgs {
  classroom: string;
  login: string;
  role: StaffRole;
  confirm: true;
}

export const staffRemoveTool: ToolDefinition<StaffRemoveArgs> = {
  name: 'staff_remove',
  // Can remove the user from the GitHub org entirely → destructive + openWorld.
  // Requires confirm:true (enforced by the schema).
  annotations: { destructive: true, openWorld: true },
  title: 'Remove a teaching-staff member from the classroom',
  description:
    'Removes one role from a member of the classroom teaching team. Owner only, destructive, ' +
    'requires confirm:true. Because roles are additive, this deletes ONLY the membership row at ' +
    'the given role — someone who also holds another role here keeps it. Triggers the standard ' +
    'removal workflow: it removes them from the classroom staff team on GitHub and, IF they hold ' +
    'no other role in that GitHub organization, removes them from the org entirely (revoking ' +
    'their access) — the workflow is role-aware, so another membership (e.g. they also take a ' +
    'class in the same org) keeps them in the org. Removing the LAST remaining owner is refused: ' +
    'add another owner first. Runs in the background. Because the removal is processed ' +
    'asynchronously it can still fail after this call reports success — check list_teaching_team ' +
    'afterwards to confirm they are gone.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    login: z.string().min(1).max(100).describe('The staff member GitHub username'),
    role: z.enum(STAFF_ROLES).describe('Which role to remove — the other roles they hold survive'),
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges this can remove the user from the GitHub org'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      // The service resolves the target from the DB by (classroom, login, role)
      // and builds the removal-task payload ENTIRELY server-side. It awaits the
      // ENQUEUE only and hands back the run id; unlike the web route we do not
      // waitForRunCompletion — the removal finishes in the background. The
      // last-owner guard runs BEFORE the enqueue for exactly that reason.
      result = await ClassmojiService.staff.removeStaff({
        classroomId: classroom.classroomId,
        login: args.login,
        role: args.role,
      });
    } catch (error) {
      throw mapStaffError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'STAFF',
      resource_id: result.userId,
      action: 'DELETE',
      data: {
        tool: 'staff_remove',
        user_id: result.userId,
        login: result.login,
        role: result.role,
      },
    });

    return ok({
      success: true,
      queued: true,
      login: result.login,
      user_id: result.userId,
      role: result.role,
      message: `Removal of the ${result.role} role queued — removing the GitHub staff team membership (and org access if they hold no other role there) in the background.`,
    });
  },
};
