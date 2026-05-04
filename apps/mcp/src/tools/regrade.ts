import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import {
  assertRegradeRequestInClassroom,
  assertStudentOwnsRepositoryAssignment,
} from '../context/ownership.ts';
import { isStudentInAny, isTeachingInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerRegradeCreate(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'regrade_create',
    {
      title: 'File a regrade request',
      description: 'File a regrade request on your own repository (student-only).',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        repositoryAssignmentId: z.string().uuid(),
        reason: z.string().min(1),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStudentInAny(resolved.roles))
        throw mcpError('Student role required', ErrorCode.InvalidRequest);
      await assertStudentOwnsRepositoryAssignment(
        args.repositoryAssignmentId,
        ctx.userId,
        resolved.classroom.id
      );
      const result = await ClassmojiService.regradeRequest.create({
        classroom_id: resolved.classroom.id,
        repository_assignment_id: args.repositoryAssignmentId,
        student_id: ctx.userId,
        student_comment: args.reason,
      });
      return ok({ created: result });
    }
  );
}

export function registerRegradeResolve(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'regrade_resolve',
    {
      title: 'Resolve a regrade request',
      description: 'Approve or deny a regrade request (teaching team).',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        regradeRequestId: z.string().uuid(),
        decision: z.enum(['APPROVED', 'DENIED']),
        response: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isTeachingInAny(resolved.roles))
        throw mcpError('Teaching team role required', ErrorCode.InvalidRequest);
      await assertRegradeRequestInClassroom(args.regradeRequestId, resolved.classroom.id);
      const result = await ClassmojiService.regradeRequest.update({
        id: args.regradeRequestId,
        data: {
          status: args.decision,
          grader_comment: args.response ?? null,
        },
      });
      return ok({ resolved: result });
    }
  );
}
