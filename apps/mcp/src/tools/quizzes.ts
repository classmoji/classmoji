import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerQuizzesWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'quizzes_write',
    {
      title: 'Manage quizzes',
      description: 'Manage quizzes (admin-only). Methods: create, update, publish, delete.',
      inputSchema: z.object({
        method: z.enum(['create', 'update', 'publish', 'delete']),
        classroomSlug: classroomSlugSchema(ctx),
        quizId: z.string().uuid().optional(),
        name: z.string().optional(),
        subject: z.string().optional(),
        description: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'create': {
          if (!args.name) throw mcpError('create requires name', ErrorCode.InvalidParams);
          const result = await ClassmojiService.quiz.create({
            classroom: { connect: { id: resolved.classroom.id } },
            name: args.name,
            subject: args.subject ?? '',
            description: args.description ?? '',
          } as never);
          return ok({ created: { id: result.id, name: result.name } });
        }
        case 'update': {
          if (!args.quizId) throw mcpError('update requires quizId', ErrorCode.InvalidParams);
          const updates: Record<string, unknown> = {};
          if (args.name !== undefined) updates.name = args.name;
          if (args.subject !== undefined) updates.subject = args.subject;
          if (args.description !== undefined) updates.description = args.description;
          const result = await ClassmojiService.quiz.update(args.quizId, updates);
          return ok({ updated: { id: result.id, name: result.name } });
        }
        case 'publish': {
          if (!args.quizId) throw mcpError('publish requires quizId', ErrorCode.InvalidParams);
          const result = await ClassmojiService.quiz.publish(args.quizId);
          return ok({ published: { id: result.id, name: result.name } });
        }
        case 'delete': {
          if (!args.quizId) throw mcpError('delete requires quizId', ErrorCode.InvalidParams);
          await getPrisma().quiz.delete({ where: { id: args.quizId } });
          return ok({ deleted: { id: args.quizId } });
        }
      }
    }
  );
}
