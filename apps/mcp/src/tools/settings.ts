import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isOwnerInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * Whitelist of settings the LLM can change. Excludes API keys, LLM
 * secrets, and other server-side-only fields.
 */
export function registerClassroomSettingsUpdate(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'classroom_settings_update',
    {
      title: 'Update classroom settings',
      description:
        'Update non-secret classroom settings (admin-only). Cannot modify ' +
        'OpenAI/Anthropic API keys via this tool.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        default_tokens_per_hour: z.number().int().min(0).optional(),
        late_penalty_points_per_hour: z.number().min(0).optional(),
        show_grades_to_students: z.boolean().optional(),
        quizzes_enabled: z.boolean().optional(),
        slides_enabled: z.boolean().optional(),
        syllabus_bot_enabled: z.boolean().optional(),
        recent_viewers_enabled: z.boolean().optional(),
        default_student_page: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isOwnerInAny(resolved.roles))
        throw mcpError('Owner role required', ErrorCode.InvalidRequest);

      const { classroomSlug: _slug, ...updates } = args;
      if (Object.keys(updates).length === 0) {
        throw mcpError('At least one setting must be provided', ErrorCode.InvalidParams);
      }
      const result = await ClassmojiService.classroom.updateSettings(
        resolved.classroom.id,
        updates as never
      );
      return ok({ updated: result });
    }
  );
}
