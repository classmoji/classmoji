import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

const RoleEnum = z.enum(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);

export function registerRosterWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'roster_write',
    {
      title: 'Manage classroom roster',
      description:
        'Manage classroom membership (admin-only). Methods: add_student, ' +
        'remove_student, update_membership.',
      inputSchema: z.object({
        method: z.enum(['add_student', 'remove_student', 'update_membership']),
        classroomSlug: classroomSlugSchema(ctx),
        userId: z.string().uuid().optional(),
        role: RoleEnum.optional(),
        is_grader: z.boolean().optional(),
        comment: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);
      if (!args.userId)
        throw mcpError('userId is required', ErrorCode.InvalidParams);

      switch (args.method) {
        case 'add_student': {
          const result = await ClassmojiService.classroomMembership.create({
            classroom_id: resolved.classroom.id,
            user_id: args.userId,
            role: args.role ?? 'STUDENT',
            has_accepted_invite: true,
            is_grader: args.is_grader ?? false,
          });
          return ok({ added: { id: result.id, role: result.role } });
        }
        case 'remove_student': {
          await ClassmojiService.classroomMembership.remove(
            resolved.classroom.id,
            args.userId
          );
          return ok({ removed: { userId: args.userId } });
        }
        case 'update_membership': {
          const updates: Record<string, unknown> = {};
          if (args.is_grader !== undefined) updates.is_grader = args.is_grader;
          if (args.comment !== undefined) updates.comment = args.comment;
          await ClassmojiService.classroomMembership.update(
            resolved.classroom.id,
            args.userId,
            updates
          );
          return ok({ updated: { userId: args.userId, ...updates } });
        }
      }
    }
  );
}
