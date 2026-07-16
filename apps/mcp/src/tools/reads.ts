/**
 * Read tools — the full read surface mirrored as TOOLS.
 *
 * WHY: tool-only MCP clients (e.g. claude.ai) can enumerate/call `tools/*` but
 * have NO access to `resources/list` / `resources/read`. The entire read
 * surface already exists as MCP *resources* (apps/mcp/src/resources/**); this
 * module re-exposes each one as a thin `scope: 'read'` tool so those clients
 * can reach the same data. The resources are UNCHANGED.
 *
 * NO-DRIFT GUARANTEE (the central requirement): every mirror tool calls the
 * resource's OWN handler with an identically-resolved `ClassroomContext`. The
 * registry resolves `ctx.classroom` from the tool's `roles` (which equal the
 * resource's `roles`) exactly as it does for the resource's URI, so every
 * in-handler guard — the leaderboard twin-guard, roster's OWNER-only field
 * split, the quizzes triple-gate, grades_released, PII-stripping — fires
 * identically. The tool then wraps the resource payload with `ok()`, which
 * serializes it with the same `JSON.stringify(payload, null, 2)` the resource
 * read uses. Resource and tool are therefore byte-identical by construction.
 *
 * Two tools are NOT pure mirrors:
 *   - list_submissions   adds server-side filters over the grading-queue data
 *     (shares loadGradingQueueData + queueRow with the grading-queue resource).
 *   - list_teaching_team is a NEW capability (no resource lists staff-with-ids)
 *     that resolves the grader_id an agent needs for grader_assign.
 */

import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { ClassmojiService } from '@classmoji/services';
import { IssueStatus, type Role } from '@prisma/client';
import { z, type ZodRawShape } from 'zod';
import type { ResourceDefinition, ToolDefinition } from '../mcp/registry.ts';
import { parseClassroomRef } from '../authz/pure.ts';
import { ok, requireClassroomCtx, TEACHING_TEAM } from './shared.ts';
import { orgLogin, type SubmissionLike } from '../resources/shape.ts';
import { meResource } from '../resources/me.ts';
import { classroomInfoResource } from '../resources/classroomInfo.ts';
import { rosterResource, teamsResource } from '../resources/roster.ts';
import { reposResource, gradesMineResource } from '../resources/repos.ts';
import {
  loadGradingQueueData,
  queueRow,
  leaderboardResource,
  submissionResource,
  regradeQueueResource,
  regradeMineResource,
} from '../resources/grading.ts';
import {
  quizzesResource,
  pagesResource,
  modulesResource,
  calendarResource,
  calendarRangeResource,
} from '../resources/content.ts';
import { tokensResource } from '../resources/tokens.ts';

// ─── Generic resource→tool adapter (the no-drift bridge) ────────────────────

interface MirrorConfig {
  /** The resource whose handler + role tier this tool reuses verbatim. */
  resource: ResourceDefinition;
  name: string;
  title: string;
  description: string;
  /** Zod inputs beyond `classroom` (e.g. submission_id, calendar start/end). */
  extraInput?: ZodRawShape;
  /** Map validated args → the resource's non-org/slug URI-template variables. */
  buildVars?: (args: Record<string, unknown>) => Record<string, string>;
}

/**
 * Wrap a ResourceDefinition as a read tool. The tool inherits the resource's
 * exact role tier and calls the resource's handler with the same ctx + vars.
 */
function mirrorResourceTool(config: MirrorConfig): ToolDefinition {
  const { resource, name, title, description, extraInput = {}, buildVars } = config;
  const classroomScoped = resource.roles !== null;
  const template = new UriTemplate(resource.uriTemplate);

  const inputSchema: ZodRawShape = {
    ...(classroomScoped
      ? { classroom: z.string().describe("Classroom reference as 'org/slug'") }
      : {}),
    ...extraInput,
  };

  return {
    name,
    title,
    description,
    scope: 'read',
    roles: resource.roles,
    inputSchema,
    handler: async (args: Record<string, unknown>, ctx) => {
      let vars: Record<string, string> = {};
      if (classroomScoped) {
        // The registry already validated `classroom` while resolving
        // ctx.classroom; re-parse to get the raw org/slug the resource's URI
        // handler would see (twin-guards key off vars.slug).
        const { org, slug } = parseClassroomRef(args.classroom);
        vars = { org, slug, ...(buildVars ? buildVars(args) : {}) };
      } else if (buildVars) {
        vars = buildVars(args);
      }
      const uri = new URL(
        UriTemplate.isTemplate(resource.uriTemplate) ? template.expand(vars) : resource.uriTemplate
      );
      const payload = await resource.handler(vars, ctx, uri);
      return ok(payload);
    },
  };
}

// ─── Pure mirrors (one per read resource) ───────────────────────────────────

export const myClassroomsTool = mirrorResourceTool({
  resource: meResource,
  name: 'my_classrooms',
  title: 'My identity & classrooms',
  description:
    'Returns the authenticated user (id, login, name), granted scopes, and every classroom ' +
    "membership as 'org/slug' with role, status, and archive flags. Call this first to discover " +
    "the 'org/slug' classroom reference every other tool needs. Takes no arguments.",
});

export const getClassroomInfoTool = mirrorResourceTool({
  resource: classroomInfoResource,
  name: 'get_classroom_info',
  title: 'Get classroom info',
  description:
    'Classroom name, status, archive flag, sanitized settings (feature flags, model choices, ' +
    'has_anthropic_key/has_openai_key booleans — never raw keys), and your role in it. Any member.',
});

export const getRosterTool = mirrorResourceTool({
  resource: rosterResource,
  name: 'get_roster',
  title: 'Get student roster',
  description:
    'Students enrolled in the classroom (teaching team only). OWNER additionally sees contact ' +
    'fields (email, school_id) and per-student letter_grade/comment overrides; other staff see ' +
    'identity + grader/invite flags only.',
});

export const listTeamsTool = mirrorResourceTool({
  resource: teamsResource,
  name: 'list_teams',
  title: 'List teams',
  description:
    'Teams in the classroom with member identities (id, name, login — no contact PII). Students ' +
    'see visible teams and any team they belong to; staff see all teams.',
});

export const listReposTool = mirrorResourceTool({
  resource: reposResource,
  name: 'list_repos',
  title: 'List assignment containers (repos)',
  description:
    'Assignment containers ("repos") with their due-dated assignments. Staff see all incl. ' +
    'unpublished; students see published-only containers they have a git repo for, with their own ' +
    'submission status per assignment (grades only after release). Any member.',
});

export const myGradesTool = mirrorResourceTool({
  resource: gradesMineResource,
  name: 'my_grades',
  title: 'My released grades',
  description:
    'Your own graded submissions in this classroom — only assignments whose grades have been ' +
    'released (Assignment.grades_released). Students only.',
});

export const getSubmissionTool = mirrorResourceTool({
  resource: submissionResource,
  name: 'get_submission',
  title: 'Get submission detail',
  description:
    'One submission (a GitRepoAssignment) with its grades, graders, and analytics snapshot if ' +
    'present. Teaching team only. `submission_id` comes from list_submissions; it is also the ' +
    'id that grade_add, grade_remove, and grader_assign consume.',
  extraInput: {
    submission_id: z.string().uuid().describe('Submission (GitRepoAssignment) id'),
  },
  buildVars: args => ({ submissionId: String(args.submission_id) }),
});

export const getLeaderboardTool = mirrorResourceTool({
  resource: leaderboardResource,
  name: 'get_leaderboard',
  title: 'Get class leaderboard',
  description:
    'Computed final-grade leaderboard for every student (id, name, login, grade), sorted ' +
    'ascending by grade. OWNER only.',
});

export const listRegradeRequestsTool = mirrorResourceTool({
  resource: regradeQueueResource,
  name: 'list_regrade_requests',
  title: 'List regrade requests',
  description:
    'All regrade requests in the classroom with student + grader comments and the affected ' +
    'submission. Teaching team only. Resolve them with regrade_resolve.',
});

export const myRegradeRequestsTool = mirrorResourceTool({
  resource: regradeMineResource,
  name: 'my_regrade_requests',
  title: 'My regrade requests',
  description:
    'Your own regrade requests in this classroom (status, your comment, the affected submission). ' +
    'Students only; grader comments are not included.',
});

export const listQuizzesTool = mirrorResourceTool({
  resource: quizzesResource,
  name: 'list_quizzes',
  title: 'List quizzes',
  description:
    'AI-graded quizzes. Staff (OWNER/ASSISTANT) see all quizzes incl. drafts and prompts; students ' +
    'see published quizzes with their own attempt summary. Requires a Pro subscription and ' +
    'quizzes_enabled. TEACHER is excluded (matches the web routes).',
});

export const listPagesTool = mirrorResourceTool({
  resource: pagesResource,
  name: 'list_pages',
  title: 'List pages',
  description:
    'Course pages. OWNER/TEACHER see every page incl. drafts; assistants and students see the ' +
    'published student-menu list. Any member.',
});

export const listModulesTool = mirrorResourceTool({
  resource: modulesResource,
  name: 'list_modules',
  title: 'List modules',
  description:
    'Ordered curriculum modules with their content items (pages, repos, quizzes, slides). Students ' +
    'see published modules/items only; staff also see unpublished. Returns {enabled:false} when ' +
    'the classroom hides modules. Any member.',
});

export const listCalendarTool = mirrorResourceTool({
  resource: calendarResource,
  name: 'list_calendar',
  title: 'List calendar (current month)',
  description:
    'Calendar events for the current month — recurring events expanded, assignment deadlines ' +
    'merged in. Use list_calendar_range for another window. Any member.',
});

export const listCalendarRangeTool = mirrorResourceTool({
  resource: calendarRangeResource,
  name: 'list_calendar_range',
  title: 'List calendar (date range)',
  description:
    'Calendar events for an explicit date range. `start` and `end` are ISO dates ' +
    '(YYYY-MM-DD, e.g. 2026-07-01 / 2026-08-31), start before end. Recurring events expanded, ' +
    'deadlines merged. Any member.',
  extraInput: {
    start: z.string().describe('Range start, ISO date YYYY-MM-DD'),
    end: z.string().describe('Range end, ISO date YYYY-MM-DD (must be after start)'),
  },
  buildVars: args => ({ start: String(args.start), end: String(args.end) }),
});

export const myTokensTool = mirrorResourceTool({
  resource: tokensResource,
  name: 'my_tokens',
  title: 'My token ledger',
  description:
    'Your token balance and transaction history in this classroom (grants, purchases, refunds, ' +
    'removals). Students only.',
});

// ─── list_submissions (grading-queue data + server-side filters) ────────────

const LIST_SUBMISSIONS_LIMIT_DEFAULT = 100;
const LIST_SUBMISSIONS_LIMIT_MAX = 500;

interface ListSubmissionsArgs {
  classroom: string;
  repository_id?: string;
  assignment_id?: string;
  grader_id?: string;
  status?: IssueStatus;
  limit?: number;
}

export const listSubmissionsTool: ToolDefinition<ListSubmissionsArgs> = {
  name: 'list_submissions',
  title: 'List submissions',
  description:
    'All submissions (GitRepoAssignments) in the classroom with grade emojis, grader assignments, ' +
    'student/team, and the classroom emoji scale — the same per-submission shape as the ' +
    'grading-queue. Optional filters: repository_id, assignment_id, grader_id, status (OPEN|CLOSED). ' +
    'The returned `id` is the submission id that grade_add, grade_remove, and grader_assign ' +
    'consume. Teaching team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    repository_id: z
      .string()
      .uuid()
      .optional()
      .describe('Filter to one assignment container (Repository) id'),
    assignment_id: z.string().uuid().optional().describe('Filter to one Assignment id'),
    grader_id: z
      .string()
      .uuid()
      .optional()
      .describe('Filter to submissions this grader (user id) is assigned to'),
    status: z
      .nativeEnum(IssueStatus)
      .optional()
      .describe('Filter by submission status: OPEN or CLOSED'),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_SUBMISSIONS_LIMIT_MAX)
      .optional()
      .describe(`Max submissions to return (default ${LIST_SUBMISSIONS_LIMIT_DEFAULT})`),
  },
  handler: async (args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    const org = orgLogin(ctx);
    // Shared with the grading-queue resource: one query + emoji-scale shaping.
    const { emoji_scale, all } = await loadGradingQueueData(classroomId);

    // The service method has no filter params (gitRepoAssignment.findByClassroomId
    // takes only classroomId), so the filters are applied in-memory over the raw
    // rows before shaping. Each is derived from DB columns, never request data.
    let filtered: SubmissionLike[] = all;
    if (args.repository_id) {
      filtered = filtered.filter(s => s.git_repo?.repository_id === args.repository_id);
    }
    if (args.assignment_id) {
      filtered = filtered.filter(s => s.assignment?.id === args.assignment_id);
    }
    if (args.grader_id) {
      filtered = filtered.filter(s => (s.graders ?? []).some(g => g.grader?.id === args.grader_id));
    }
    if (args.status) {
      filtered = filtered.filter(s => s.status === args.status);
    }

    const limit = Math.min(
      args.limit ?? LIST_SUBMISSIONS_LIMIT_DEFAULT,
      LIST_SUBMISSIONS_LIMIT_MAX
    );
    const page = filtered.slice(0, limit);

    return ok({
      count: page.length,
      total_matched: filtered.length,
      truncated: filtered.length > page.length,
      emoji_scale,
      submissions: page.map(s => queueRow(s, org)),
    });
  },
};

// ─── list_teaching_team (NEW — resolves grader_id for grader_assign) ────────

interface ListTeachingTeamArgs {
  classroom: string;
}

interface TeachingMembershipRow {
  role: Role;
  user?: { id: string; login?: string | null; name?: string | null } | null;
}

const TEACHING_ROLE_SET: ReadonlySet<Role> = new Set(TEACHING_TEAM);

export const listTeachingTeamTool: ToolDefinition<ListTeachingTeamArgs> = {
  name: 'list_teaching_team',
  title: 'List teaching team',
  description:
    "The classroom's staff — OWNER, TEACHER, and ASSISTANT members — each with { id, login, name, " +
    'roles[] }. Use a member id as the `grader_id` for grader_assign / grader_unassign. One person ' +
    'may hold several roles; those are returned in their `roles` array. Teaching team only.',
  scope: 'read',
  roles: TEACHING_TEAM,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
  },
  handler: async (_args, ctx) => {
    const { classroomId } = requireClassroomCtx(ctx);
    // One query for all memberships (includes STUDENT, filtered out below).
    // ClassroomMembership is unique on (classroom_id, user_id, role), so a
    // multi-role person appears as multiple rows — aggregate to one row per
    // user with a `roles` array (cleaner for resolving a single grader_id).
    const memberships = (await ClassmojiService.classroomMembership.findByClassroomId(
      classroomId
    )) as TeachingMembershipRow[];

    const byUser = new Map<
      string,
      { id: string; login: string | null; name: string | null; roles: Role[] }
    >();
    for (const m of memberships) {
      if (!TEACHING_ROLE_SET.has(m.role) || !m.user) continue;
      const existing = byUser.get(m.user.id);
      if (existing) {
        if (!existing.roles.includes(m.role)) existing.roles.push(m.role);
      } else {
        byUser.set(m.user.id, {
          id: m.user.id,
          login: m.user.login ?? null,
          name: m.user.name ?? null,
          roles: [m.role],
        });
      }
    }

    const members = [...byUser.values()];
    return ok({ count: members.length, members });
  },
};

// ─── Manifest (registration + listing order) ────────────────────────────────

export const readTools: ToolDefinition<never>[] = [
  myClassroomsTool,
  getClassroomInfoTool,
  getRosterTool,
  listTeamsTool,
  listReposTool,
  myGradesTool,
  listSubmissionsTool,
  getSubmissionTool,
  getLeaderboardTool,
  listRegradeRequestsTool,
  myRegradeRequestsTool,
  listTeachingTeamTool,
  listQuizzesTool,
  listPagesTool,
  listModulesTool,
  listCalendarTool,
  listCalendarRangeTool,
  myTokensTool,
];
