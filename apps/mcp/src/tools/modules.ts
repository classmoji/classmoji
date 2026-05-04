import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { assertModuleInClassroom } from '../context/ownership.ts';
import { isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerModulesWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'modules_write',
    {
      title: 'Create / update / publish / delete modules',
      description: 'Manage classroom modules (admin-only). Methods: create, update, publish, delete.',
      inputSchema: z.object({
        method: z.enum(['create', 'update', 'publish', 'delete']),
        classroomSlug: classroomSlugSchema(ctx),
        moduleId: z.string().uuid().optional().describe('Required for update/publish/delete'),
        title: z.string().optional(),
        description: z.string().optional(),
        is_published: z.boolean().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'create': {
          if (!args.title) throw mcpError('create requires title', ErrorCode.InvalidParams);
          const result = await ClassmojiService.module.create({
            classroom_id: resolved.classroom.id,
            title: args.title,
            description: args.description ?? '',
            is_published: args.is_published ?? false,
            type: 'INDIVIDUAL',
            template: '',
          } as never);
          return ok({ created: { id: result.id, title: result.title } });
        }
        case 'update': {
          if (!args.moduleId) throw mcpError('update requires moduleId', ErrorCode.InvalidParams);
          await assertModuleInClassroom(args.moduleId, resolved.classroom.id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.description !== undefined) updates.description = args.description;
          if (args.is_published !== undefined) updates.is_published = args.is_published;
          const result = await ClassmojiService.module.update(args.moduleId, updates);
          return ok({ updated: { id: result.id, title: result.title } });
        }
        case 'publish': {
          if (!args.moduleId) throw mcpError('publish requires moduleId', ErrorCode.InvalidParams);
          await assertModuleInClassroom(args.moduleId, resolved.classroom.id);
          const result = await ClassmojiService.module.setPublished(args.moduleId, true);
          return ok({ published: { id: result.id, title: result.title } });
        }
        case 'delete': {
          if (!args.moduleId) throw mcpError('delete requires moduleId', ErrorCode.InvalidParams);
          await assertModuleInClassroom(args.moduleId, resolved.classroom.id);
          await ClassmojiService.module.deleteById(args.moduleId);
          return ok({ deleted: { id: args.moduleId } });
        }
      }
    }
  );
}
