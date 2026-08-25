/**
 * Assistant (TA) tools — assistant_add / assistant_update / assistant_remove.
 *
 * ROUTE-DERIVED TIER: the web actions live in
 * apps/webapp/app/routes/admin.$class.assistants/action.ts, gated by
 * requireClassroomAdmin — OWNER only for all three.
 *
 * Backbone: ClassmojiService.assistant.* (extracted in phase A so the web route
 * and these tools take ONE code path — same precedent as roster.service.ts).
 * The service resolves the GitHub profile SERVER-SIDE from the login, so a tool
 * caller holding only a login works and no client can choose the provider_id
 * the account is keyed to.
 *
 * S1: classroomId is ALWAYS ctx.classroom.classroomId, never request input, so
 * every membership lookup inside the service is already classroom-scoped. A
 * login that names nobody, or someone who is not an ASSISTANT *here*, comes
 * back as the same `assistant_not_found` → the uniform scopedNotFound, so a
 * cross-classroom probe cannot enumerate foreign staff.
 */

import { AssistantServiceError, ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/**
 * Map the service's caller-fixable failures onto tool errors.
 *
 * - `git_user_not_found` → a PLAIN not_found: the miss is on GitHub's user
 *   lookup, not on a classroom-scoped record, so there is nothing to leak and
 *   the message should say what actually failed.
 * - `assistant_not_found` → the uniform scopedNotFound (unknown login and
 *   "assistant of another classroom" are indistinguishable to the caller).
 * - `no_org_configured` → invalid_params: the classroom is not linked to a git
 *   organization, so assistants cannot be managed until that is fixed.
 * - `login_conflict` → invalid_params with a neutral message: the stored user
 *   record is keyed to a different account than this login resolves to, which
 *   only a human with both records in front of them can untangle.
 * - `classroom_not_found` is unreachable (the id comes from a resolved ctx) and
 *   anything else is returned unchanged for the registry's generic wrapper.
 */
function mapAssistantError(error: unknown): unknown {
  if (!(error instanceof AssistantServiceError)) return error;
  switch (error.code) {
    case 'git_user_not_found':
      return new ToolError('not_found', 'GitHub user not found');
    case 'assistant_not_found':
      return scopedNotFound('Assistant');
    case 'no_org_configured':
      return new ToolError(
        'invalid_params',
        'This classroom has no linked GitHub organization — assistants cannot be managed'
      );
    case 'login_conflict':
      return new ToolError(
        'invalid_params',
        'This login is associated with a different account — contact support'
      );
    default:
      return error;
  }
}

interface AssistantAddArgs {
  classroom: string;
  login: string;
  name?: string;
  email?: string;
}

export const assistantAddTool: ToolDefinition<AssistantAddArgs> = {
  name: 'assistant_add',
  // Sends a REAL GitHub org invite (openWorld). Adds a membership only —
  // nothing is removed, so not destructive.
  annotations: { destructive: false, openWorld: true },
  title: 'Add an assistant (TA)',
  description:
    "Adds a TA/assistant to the classroom's teaching team by GitHub username, and invites them " +
    'to the classroom GitHub organization if they are not already a member (someone already in ' +
    'the org is added straight to the assistant team instead). Owner only. Idempotent: if they ' +
    'are already an assistant here it reports already_exists and changes nothing. New assistants ' +
    'must accept the GitHub org invite before their access is live. Use list_teaching_team to see ' +
    'current staff, and assistant_update to make them a grader.',
  scope: 'write',
  roles: OWNER_ONLY,
  // Tighter than the default bucket: every call can send a real GitHub org
  // invitation, so cap it at a burst of 5 and roughly 3 per minute sustained.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    login: z.string().min(1).max(100).describe('The assistant GitHub username'),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Display name override (defaults to their GitHub profile name)'),
    email: z.string().email().optional().describe('Contact email override'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      // classroomId is ALWAYS the authorized classroom, never request input.
      result = await ClassmojiService.assistant.addAssistant({
        classroomId: classroom.classroomId,
        login: args.login,
        name: args.name,
        email: args.email,
      });
    } catch (error) {
      throw mapAssistantError(error);
    }

    // An already-existing assistant short-circuits inside the service BEFORE any
    // GitHub or DB write — there is no mutation to audit in that case.
    if (!result.created) {
      return ok({
        success: true,
        created: false,
        already_exists: true,
        login: result.login,
        user_id: result.userId,
        message: `${result.login} is already an assistant in this classroom — nothing changed.`,
      });
    }

    // Audit right after the service call: the membership (and the GitHub team
    // add / org invite) is already committed, so nothing downstream may leave
    // the mutation un-audited (plan §5.1).
    await writeAudit(ctx, {
      resource_type: 'ASSISTANTS',
      resource_id: result.userId,
      action: 'CREATE',
      data: {
        tool: 'assistant_add',
        user_id: result.userId,
        login: result.login,
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
      // Already-in-org staff are added straight to the assistant team; everyone
      // else gets an org invite they must accept before access is live.
      github: result.alreadyOrgMember ? 'team_added' : 'invited',
      invite_pending: !result.alreadyOrgMember,
      message: result.alreadyOrgMember
        ? `${result.login} was already in the GitHub org and has been added to the assistant team.`
        : `${result.login} has been invited to the GitHub organization — their access goes live once they accept the invite.`,
    });
  },
};

interface AssistantUpdateArgs {
  classroom: string;
  login: string;
  is_grader: boolean;
}

export const assistantUpdateTool: ToolDefinition<AssistantUpdateArgs> = {
  name: 'assistant_update',
  // Flips one flag on our own DB row: no deletion, no GitHub call, and setting
  // the same value twice is a no-op → idempotent.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Update an assistant',
  description:
    'Sets whether an assistant is a grader (is_grader) in this classroom. Owner only. Only ' +
    'grader-flagged assistants take part in grader_assign_bulk RANDOM distribution. Identify ' +
    'them by GitHub username; list_teaching_team shows the current staff.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    login: z.string().min(1).max(100).describe('The assistant GitHub username'),
    is_grader: z.boolean().describe('Whether this assistant grades submissions'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let membership;
    try {
      // Role-scoped inside the service: a user who is both OWNER and ASSISTANT
      // here has two membership rows and only the ASSISTANT one is touched.
      membership = await ClassmojiService.assistant.updateAssistant({
        classroomId: classroom.classroomId,
        login: args.login,
        isGrader: args.is_grader,
      });
    } catch (error) {
      throw mapAssistantError(error);
    }

    // resource_id identifies WHICH assistant was updated. It is also what keeps
    // back-to-back updates to different assistants as separate audit rows: the
    // audit dedup key includes it, so without it two flips inside the dedup
    // window would collapse into one record.
    await writeAudit(ctx, {
      resource_type: 'ASSISTANTS',
      resource_id: membership.user_id,
      action: 'UPDATE',
      data: {
        tool: 'assistant_update',
        user_id: membership.user_id,
        login: args.login,
        is_grader: args.is_grader,
      },
    });

    return ok({ success: true, login: args.login, is_grader: args.is_grader });
  },
};

interface AssistantRemoveArgs {
  classroom: string;
  login: string;
  confirm: true;
}

export const assistantRemoveTool: ToolDefinition<AssistantRemoveArgs> = {
  name: 'assistant_remove',
  // Can remove the user from the GitHub org entirely → destructive + openWorld.
  // Requires confirm:true (enforced by the schema).
  annotations: { destructive: true, openWorld: true },
  title: 'Remove an assistant from the classroom',
  description:
    'Removes an assistant from the classroom teaching team. Owner only, destructive, requires ' +
    'confirm:true. Triggers the standard removal workflow: it removes them from the classroom ' +
    'assistant team on GitHub and, IF they hold no other role in that GitHub organization, ' +
    'removes them from the org entirely (revoking their access) — the workflow is role-aware, so ' +
    'another membership (e.g. they also own or take a class in the same org) keeps them in the ' +
    'org. Deletes only the ASSISTANT membership row. Runs in the background. Because the removal ' +
    'is processed asynchronously it can still fail after this call reports success — check ' +
    'list_teaching_team afterwards to confirm they are gone.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    login: z.string().min(1).max(100).describe('The assistant GitHub username'),
    confirm: z
      .literal(true)
      .describe('Must be true — acknowledges this can remove the user from the GitHub org'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    let result;
    try {
      // The service resolves the target from the DB by (classroom, login) and
      // builds the removal-task payload ENTIRELY server-side. It awaits the
      // ENQUEUE only and hands back the run id; unlike the web route we do not
      // waitForRunCompletion — the removal finishes in the background.
      result = await ClassmojiService.assistant.removeAssistant({
        classroomId: classroom.classroomId,
        login: args.login,
      });
    } catch (error) {
      throw mapAssistantError(error);
    }

    await writeAudit(ctx, {
      resource_type: 'ASSISTANTS',
      resource_id: result.userId,
      action: 'DELETE',
      data: { tool: 'assistant_remove', user_id: result.userId, login: result.login },
    });

    return ok({
      success: true,
      queued: true,
      login: result.login,
      user_id: result.userId,
      message:
        'Assistant removal queued — removing the GitHub team membership (and org access if they hold no other role there) in the background.',
    });
  },
};
