import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import {
  assertStudentOwnsRepositoryAssignment,
  assertUserMemberOfClassroom,
} from '../context/ownership.ts';
import { isStaffInAny, isStudentInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

const MAX_GRANT = 100_000;

export function registerTokensAssign(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'tokens_assign',
    {
      title: 'Grant tokens to a student',
      description:
        'Grant Classmoji virtual currency tokens to a student (staff-only). ' +
        'Amount must be positive — to revoke tokens, do it via the webapp.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        studentId: z.string().uuid(),
        amount: z
          .number()
          .int()
          .positive()
          .max(MAX_GRANT)
          .describe(`Positive integer between 1 and ${MAX_GRANT}.`),
        reason: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles))
        throw mcpError('Staff role required', ErrorCode.InvalidRequest);

      // Verify the target is actually a STUDENT (not just any classroom
      // member) — the tool description says "Grant tokens to a student".
      // Using prisma directly: a user can hold multiple roles, so we just
      // need the STUDENT row to exist.
      const isStudent = await getPrisma().classroomMembership.findFirst({
        where: {
          user_id: args.studentId,
          classroom_id: resolved.classroom.id,
          role: 'STUDENT',
          has_accepted_invite: true,
        },
        select: { id: true },
      });
      if (!isStudent) {
        throw mcpError(
          'Target user is not an accepted student in this classroom',
          ErrorCode.InvalidRequest
        );
      }
      await assertUserMemberOfClassroom(args.studentId, resolved.classroom.id);

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
        'Spend Classmoji tokens to extend the deadline on one of your repository ' +
        "assignments (student-only). Amount must be positive — it's the number " +
        'of tokens debited.',
      inputSchema: z.object({
        classroomSlug: classroomSlugSchema(ctx),
        repositoryAssignmentId: z
          .string()
          .uuid()
          .describe('The repository assignment whose deadline you want to extend.'),
        amount: z
          .number()
          .int()
          .positive()
          .max(MAX_GRANT)
          .describe(`Positive integer between 1 and ${MAX_GRANT}.`),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStudentInAny(resolved.roles))
        throw mcpError('Student role required', ErrorCode.InvalidRequest);
      // Verify the student actually owns this repository assignment in this
      // classroom — otherwise a student could spend their tokens to extend
      // somebody else's deadline.
      await assertStudentOwnsRepositoryAssignment(
        args.repositoryAssignmentId,
        ctx.userId,
        resolved.classroom.id
      );
      const result = await ClassmojiService.token.updateExtension({
        classroom_id: resolved.classroom.id,
        student_id: ctx.userId,
        amount: -args.amount,
        type: 'PURCHASE',
        description: `Deadline extension purchased via MCP for repo assignment ${args.repositoryAssignmentId}`,
      });
      return ok({ purchased: result });
    }
  );
}
