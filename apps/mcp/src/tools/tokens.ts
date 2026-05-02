import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny, isStudentInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerTokensAssign(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'tokens_assign',
    {
      title: 'Grant tokens to a student',
      description: 'Grant Classmoji virtual currency tokens to a student (admin-only).',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        studentId: z.string().uuid(),
        amount: z.number().int(),
        reason: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);
      const result = await ClassmojiService.token.assignToStudent({
        classroomId: resolved.classroom.id,
        studentId: args.studentId,
        amount: args.amount,
        description: args.reason ?? undefined,
      });
      return ok({ assigned: result });
    }
  );
}

export function registerTokensPurchaseExtension(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'tokens_purchase_extension',
    {
      title: 'Purchase a deadline extension',
      description:
        'Spend Classmoji tokens to extend a deadline on a repo assignment (student-only).',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        amount: z.number().int().describe('Token amount to spend (positive = spend)'),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStudentInAny(resolved.roles))
        throw mcpError('Student role required', ErrorCode.InvalidRequest);
      const result = await ClassmojiService.token.updateExtension({
        classroom_id: resolved.classroom.id,
        student_id: ctx.userId,
        amount: args.amount,
      });
      return ok({ purchased: result });
    }
  );
}
