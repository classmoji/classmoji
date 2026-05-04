import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import {
  assertRepositoryAssignmentInClassroom,
  assertUserMemberOfClassroom,
} from '../context/ownership.ts';
import { isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerGradersWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'graders_write',
    {
      title: 'Manage repository grader assignments',
      description:
        'Assign / unassign graders to repository assignments (admin-only). ' +
        'Methods: assign, remove, bulk_assign.',
      inputSchema: z.object({
        method: z.enum(['assign', 'remove', 'bulk_assign']),
        classroomSlug: classroomSlugSchema(ctx),
        repositoryAssignmentId: z.string().uuid(),
        graderId: z.string().uuid().optional(),
        graderIds: z.array(z.string().uuid()).optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      await assertRepositoryAssignmentInClassroom(
        args.repositoryAssignmentId,
        resolved.classroom.id
      );

      switch (args.method) {
        case 'assign': {
          if (!args.graderId) throw mcpError('assign requires graderId', ErrorCode.InvalidParams);
          await assertUserMemberOfClassroom(args.graderId, resolved.classroom.id);
          const result = await ClassmojiService.repositoryAssignmentGrader.addGraderToAssignment(
            args.repositoryAssignmentId,
            args.graderId
          );
          return ok({ assigned: result });
        }
        case 'remove': {
          if (!args.graderId) throw mcpError('remove requires graderId', ErrorCode.InvalidParams);
          const result = await ClassmojiService.repositoryAssignmentGrader.removeGraderFromAssignment(
            args.repositoryAssignmentId,
            args.graderId
          );
          return ok({ removed: result });
        }
        case 'bulk_assign': {
          if (!args.graderIds || args.graderIds.length === 0)
            throw mcpError('bulk_assign requires graderIds[]', ErrorCode.InvalidParams);
          // Single roundtrip vs N: fetch all accepted memberships at once,
          // then diff against the requested set.
          const members = await getPrisma().classroomMembership.findMany({
            where: {
              classroom_id: resolved.classroom.id,
              user_id: { in: args.graderIds },
              has_accepted_invite: true,
            },
            select: { user_id: true },
          });
          const present = new Set(members.map(m => m.user_id));
          const missing = args.graderIds.filter(id => !present.has(id));
          if (missing.length > 0) {
            throw mcpError(
              `Users not members of this classroom: ${missing.join(', ')}`,
              ErrorCode.InvalidRequest
            );
          }
          const result = await ClassmojiService.repositoryAssignmentGrader.bulkAssignGraders(
            args.repositoryAssignmentId,
            args.graderIds
          );
          return ok({ bulkAssigned: result });
        }
      }
    }
  );
}
