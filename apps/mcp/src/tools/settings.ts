/**
 * Classroom settings tools — classroom_settings_update /
 * classroom_status_update / org_repo_settings_update.
 *
 * ROUTE-DERIVED TIER: OWNER only for all three.
 *   - admin.$class.settings.general / .content / .grades / .quizzes →
 *     assertClassroomAccess allowedRoles ['OWNER']
 *   - api.classrooms.$id.status / api.classrooms.$id.archive → ['OWNER']
 *   - admin.$class.settings.repos → ['OWNER']
 *
 * THE CENTRAL SAFETY PROPERTY: `ClassmojiService.classroom.updateSettings` is a
 * bare upsert — it writes ANY key it is handed, including `anthropic_api_key`,
 * `openai_api_key` and the llm_* columns. The web actions forward the whole
 * request body into it; this tool must not. Every handler here builds an
 * EXPLICIT object field-by-field from validated arguments and passes THAT, so
 * an unknown or secret key simply has no path to the database. The same rule
 * covers `classroom.update` (whitelisted to `name`, mirroring the web route's
 * PROFILE_FIELDS, which exists to keep `slug` and `git_org_id` unwritable) and
 * `gitProvider.updateOrganization`.
 *
 * Responses echo only the fields the tool itself set — never the service
 * return, which carries the raw settings row (API keys included).
 */

import {
  ClassmojiService,
  ClassroomSettingsEntitlementError,
  getGitProvider,
} from '@classmoji/services';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { loadPageInClassroom, ok, OWNER_ONLY, requireClassroomCtx, writeAudit } from './shared.ts';

/**
 * Classroom theme keys. Source of truth is the webapp's
 * apps/webapp/app/constants/themes.ts (CLASSROOM_THEMES); duplicated as a
 * literal here rather than imported, because apps/mcp does not depend on
 * apps/webapp. Adding a theme there means adding it here.
 */
const THEME_KEYS = ['classic', 'stone', 'lavender', 'sand', 'peach'] as const;

/** The settings columns this tool may write, in database vocabulary. */
interface SafeSettingsUpdate {
  show_modules?: boolean;
  show_pages?: boolean;
  show_repos?: boolean;
  slides_enabled?: boolean;
  syllabus_bot_enabled?: boolean;
  quizzes_enabled?: boolean;
  recent_viewers_enabled?: boolean;
  default_tokens_per_hour?: number;
  late_penalty_points_per_hour?: number;
  default_student_page?: string;
  theme?: string;
}

interface ClassroomSettingsUpdateArgs {
  classroom: string;
  name?: string;
  show_modules?: boolean;
  show_pages?: boolean;
  show_repos?: boolean;
  slides_enabled?: boolean;
  syllabus_bot_enabled?: boolean;
  quizzes_enabled?: boolean;
  recent_viewers_enabled?: boolean;
  default_tokens_per_hour?: number;
  late_penalty_points_per_hour?: number;
  default_student_page?: string;
  theme?: (typeof THEME_KEYS)[number];
}

export const classroomSettingsUpdateTool: ToolDefinition<ClassroomSettingsUpdateArgs> = {
  name: 'classroom_settings_update',
  annotations: { destructive: false, openWorld: false },
  title: 'Update classroom settings',
  description:
    'Updates classroom settings: the display name, navigation/feature toggles (modules, pages, ' +
    'repos, slides, syllabus bot, quizzes, recent viewers), token and late-penalty defaults, the ' +
    'student landing page, and the theme. Owner only. Provide at least one field; omitted fields ' +
    'are left alone. Turning a feature off hides it from students but deletes nothing. ' +
    'default_student_page takes "dashboard", "repositories", or "page:{pageId}" for a specific ' +
    'page (it must be a page in this classroom, published and shown in the student menu, or ' +
    'students fall back to the dashboard). AI provider keys and model settings are not editable ' +
    'here — those are managed in the web app.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    name: z.string().trim().min(1).max(200).optional().describe('Classroom display name'),
    show_modules: z.boolean().optional().describe('Show the modules section to students'),
    show_pages: z.boolean().optional().describe('Show course pages to students'),
    show_repos: z.boolean().optional().describe('Show repositories to students'),
    slides_enabled: z.boolean().optional().describe('Enable the slides feature'),
    syllabus_bot_enabled: z.boolean().optional().describe('Enable the AI syllabus bot'),
    quizzes_enabled: z.boolean().optional().describe('Enable AI quizzes'),
    recent_viewers_enabled: z
      .boolean()
      .optional()
      .describe('Show who recently viewed each page in the navbar'),
    default_tokens_per_hour: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Default extension-token cost per late hour for new assignments'),
    late_penalty_points_per_hour: z
      .number()
      .min(0)
      .optional()
      .describe('Grade points deducted per late hour'),
    default_student_page: z
      .string()
      .optional()
      .describe("Student landing page: 'dashboard', 'repositories', or 'page:{pageId}'"),
    theme: z.enum(THEME_KEYS).optional().describe('Classroom color theme'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Build the settings payload EXPLICITLY, key by key. Nothing that is not
    // named here can reach classroom_settings — including the API-key columns
    // updateSettings would happily write.
    const settings: SafeSettingsUpdate = {};
    const set = <K extends keyof SafeSettingsUpdate>(
      key: K,
      value: SafeSettingsUpdate[K] | undefined
    ) => {
      if (value !== undefined) settings[key] = value;
    };
    set('show_modules', args.show_modules);
    set('show_pages', args.show_pages);
    set('show_repos', args.show_repos);
    set('slides_enabled', args.slides_enabled);
    set('syllabus_bot_enabled', args.syllabus_bot_enabled);
    set('quizzes_enabled', args.quizzes_enabled);
    set('recent_viewers_enabled', args.recent_viewers_enabled);
    set('default_tokens_per_hour', args.default_tokens_per_hour);
    set('late_penalty_points_per_hour', args.late_penalty_points_per_hour);
    set('theme', args.theme);

    if (args.default_student_page !== undefined) {
      const target = args.default_student_page;
      if (target === 'dashboard' || target === 'repositories') {
        settings.default_student_page = target;
      } else if (target.startsWith('page:')) {
        // S1: the referenced page must live in the authorized classroom, so a
        // landing page cannot be pointed at another classroom's content.
        const page = await loadPageInClassroom(target.slice('page:'.length), ctx);
        settings.default_student_page = `page:${page.id}`;
      } else {
        throw new ToolError(
          'invalid_params',
          "default_student_page must be 'dashboard', 'repositories', or 'page:{pageId}'"
        );
      }
    }

    const changed = Object.keys(settings);
    if (args.name !== undefined) changed.push('name');
    if (changed.length === 0) {
      throw new ToolError('invalid_params', 'Provide at least one setting to update');
    }

    // Settings BEFORE the classroom row: `updateSettings` refuses a Pro-only
    // field on an unentitled classroom, and doing it first means that refusal
    // cannot leave a committed `name` change behind with no audit entry.
    if (Object.keys(settings).length > 0) {
      try {
        await ClassmojiService.classroom.updateSettings(classroom.classroomId, settings);
      } catch (error: unknown) {
        if (error instanceof ClassroomSettingsEntitlementError) {
          throw new ToolError('forbidden', error.message, 'PRO_REQUIRED');
        }
        throw error;
      }
    }

    // The Classroom row itself: `name` ONLY, mirroring the web route's
    // PROFILE_FIELDS whitelist (slug is the key in every URL and two HMAC
    // credentials; git_org_id would move the classroom to another org).
    if (args.name !== undefined) {
      await ClassmojiService.classroom.update(classroom.classroomId, { name: args.name });
    }

    await writeAudit(ctx, {
      resource_type: 'SETTINGS',
      resource_id: classroom.classroomId,
      action: 'UPDATE',
      data: { tool: 'classroom_settings_update', fields: changed },
    });

    // Echo the validated values we just wrote — never the service return, which
    // carries the raw settings row (API keys included).
    return ok({
      success: true,
      updated_fields: changed,
      settings: { ...settings, ...(args.name !== undefined ? { name: args.name } : {}) },
    });
  },
};

interface ClassroomStatusUpdateArgs {
  classroom: string;
  status?: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
  is_archived?: boolean;
}

export const classroomStatusUpdateTool: ToolDefinition<ClassroomStatusUpdateArgs> = {
  name: 'classroom_status_update',
  // Sets one or two columns; setting the same value twice is a no-op.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  title: 'Update classroom status or archive flag',
  description:
    'Sets the classroom lifecycle status and/or its archive flag. Owner only. Provide at least ' +
    'one. status: ACTIVE = normal; LOCKED = read-only for everyone except the owner (members ' +
    'can still browse the class, they just cannot change anything); UNPUBLISHED = hidden from ' +
    'everyone except the owner. is_archived only groups the class separately on the owner ' +
    'dashboard — it is cosmetic and changes nobody’s access. Nothing here deletes data, and each ' +
    'change is reversible with another call.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    status: z
      .enum(['ACTIVE', 'LOCKED', 'UNPUBLISHED'])
      .optional()
      .describe('Lifecycle status: ACTIVE, LOCKED (read-only), or UNPUBLISHED (hidden)'),
    is_archived: z
      .boolean()
      .optional()
      .describe('Archive flag — dashboard grouping only, no access change'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Explicit two-column payload; the whole args object never reaches Prisma.
    const updates: { status?: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED'; is_archived?: boolean } = {};
    if (args.status !== undefined) updates.status = args.status;
    if (args.is_archived !== undefined) updates.is_archived = args.is_archived;

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError('invalid_params', 'Provide status and/or is_archived');
    }

    // The owner is exempt from the registry's mutation gate, so the owner of a
    // LOCKED classroom can still call this to unlock it — the same semantics
    // the web status route has.
    const updated = await ClassmojiService.classroom.update(classroom.classroomId, updates);

    await writeAudit(ctx, {
      resource_type: 'CLASSROOM',
      resource_id: classroom.classroomId,
      action: 'UPDATE',
      data: { tool: 'classroom_status_update', ...updates },
    });

    return ok({
      success: true,
      updated_fields: fields,
      status: updated.status,
      is_archived: updated.is_archived,
    });
  },
};

interface OrgRepoSettingsUpdateArgs {
  classroom: string;
  default_repository_permission?: 'none' | 'read' | 'write';
  members_can_create_repositories?: boolean;
  confirm: true;
}

export const orgRepoSettingsUpdateTool: ToolDefinition<OrgRepoSettingsUpdateArgs> = {
  name: 'org_repo_settings_update',
  // Writes to GitHub, not our database → openWorld. It reaches far outside the
  // classroom the caller was authorized for (every repository in the org, and
  // widening default_repository_permission exposes existing student work), so
  // it is declared destructive and gated on confirm:true.
  annotations: { destructive: true, openWorld: true },
  title: 'Update GitHub organization repository settings',
  description:
    'Updates repository defaults on the GitHub ORGANIZATION this classroom belongs to. Owner ' +
    'only, destructive, requires confirm:true. WARNING: these are ORGANIZATION-WIDE GitHub ' +
    'settings, not classroom settings — they take effect IMMEDIATELY and affect every classroom, ' +
    'every member and every repository in that organization, including other courses hosted ' +
    'there, not just this class. default_repository_permission is the base permission members get ' +
    'on org repos: none (students see only their own or their team’s repos), read (students can ' +
    'read other students’ repos, including existing ones), or write (students can also write to ' +
    'them). members_can_create_repositories lets students create repositories in the org. ' +
    'Confirm with the user which organization is affected before calling. Provide at least one ' +
    'setting.',
  scope: 'write',
  roles: OWNER_ONLY,
  // Tighter than the default bucket: every call is a live GitHub org-settings
  // write — a burst of 5, roughly 3 per minute sustained.
  rateLimit: { capacity: 5, refillPerSecond: 0.05 },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    default_repository_permission: z
      .enum(['none', 'read', 'write'])
      .optional()
      .describe('Base permission org members get on organization repositories'),
    members_can_create_repositories: z
      .boolean()
      .optional()
      .describe('Whether org members may create repositories'),
    confirm: z
      .literal(true)
      .describe(
        'Must be true — acknowledges the change applies immediately to the whole GitHub ' +
          'organization, not just this classroom'
      ),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // Strict, closed payload — built from validated values only. The web route
    // forwards the request body straight to GitHub; this one cannot.
    const updates: {
      default_repository_permission?: 'none' | 'read' | 'write';
      members_can_create_repositories?: boolean;
    } = {};
    if (args.default_repository_permission !== undefined) {
      updates.default_repository_permission = args.default_repository_permission;
    }
    if (args.members_can_create_repositories !== undefined) {
      updates.members_can_create_repositories = args.members_can_create_repositories;
    }

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      throw new ToolError(
        'invalid_params',
        'Provide default_repository_permission and/or members_can_create_repositories'
      );
    }

    // Resolve the git organization from the authorized classroom (never from
    // request input), and refuse the same two ways the web route does.
    const record = await ClassmojiService.classroom.findById(classroom.classroomId);
    const gitOrganization = record?.git_organization;
    if (!gitOrganization?.login) {
      throw new ToolError(
        'invalid_params',
        'This classroom is not connected to a GitHub organization'
      );
    }
    if (!gitOrganization.github_installation_id) {
      throw new ToolError(
        'invalid_params',
        `The Classmoji GitHub App is not installed on '${gitOrganization.login}' — install it to manage repository settings`
      );
    }

    const gitProvider = getGitProvider(gitOrganization) as unknown as {
      updateOrganization: (login: string, data: Record<string, unknown>) => Promise<unknown>;
    };
    await gitProvider.updateOrganization(gitOrganization.login, updates);

    await writeAudit(ctx, {
      resource_type: 'REPO_SETTINGS',
      resource_id: classroom.classroomId,
      action: 'UPDATE',
      data: { tool: 'org_repo_settings_update', org: gitOrganization.login, ...updates },
    });

    return ok({
      success: true,
      organization: gitOrganization.login,
      updated_fields: fields,
      settings: updates,
      message: `Updated organization-wide GitHub settings for '${gitOrganization.login}' — this affects every classroom and repository in that organization.`,
    });
  },
};
