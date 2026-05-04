import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { assertUserMemberOfClassroom } from '../context/ownership.ts';
import { isOwnerInAny, isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * `roster_write` is restricted by design:
 *
 * - `add_student` always creates a STUDENT membership. To grant elevated roles
 *   (OWNER / TEACHER / ASSISTANT) use the webapp UI, which is OWNER-only and
 *   has a separate audit/review path. Letting the MCP layer mint privileged
 *   memberships would let any TEACHER quietly promote anyone to OWNER.
 * - `remove_student` and `update_membership` reject when the target holds an
 *   elevated role unless the caller is OWNER.
 * - The classroom's last OWNER can never be removed.
 */
export function registerRosterWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'roster_write',
    {
      title: 'Manage classroom roster',
      description:
        'Manage classroom membership (staff). Methods: add_student (always ' +
        'creates a STUDENT — use the webapp to grant elevated roles), ' +
        'remove_student, update_membership. Removing or modifying privileged ' +
        '(OWNER/TEACHER/ASSISTANT) members is owner-only.',
      inputSchema: z.object({
        method: z.enum(['add_student', 'remove_student', 'update_membership']),
        classroomSlug: classroomSlugSchema(ctx),
        userId: z.string().uuid().optional(),
        is_grader: z.boolean().optional(),
        comment: z.string().optional(),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isStaffInAny(resolved.roles))
        throw mcpError('Staff role required', ErrorCode.InvalidRequest);
      if (!args.userId)
        throw mcpError('userId is required', ErrorCode.InvalidParams);

      const prisma = getPrisma();

      switch (args.method) {
        case 'add_student': {
          const result = await ClassmojiService.classroomMembership.create({
            classroom_id: resolved.classroom.id,
            user_id: args.userId,
            role: 'STUDENT',
            has_accepted_invite: true,
            is_grader: args.is_grader ?? false,
          });
          return ok({ added: { id: result.id, role: result.role } });
        }
        case 'remove_student': {
          await assertUserMemberOfClassroom(args.userId, resolved.classroom.id);

          // Look up the target's existing roles; @@unique([classroom_id,
          // user_id, role]) means a user can hold multiple roles.
          const targetRoles = await prisma.classroomMembership.findMany({
            where: { classroom_id: resolved.classroom.id, user_id: args.userId },
            select: { role: true },
          });
          const targetIsPrivileged = targetRoles.some(
            r => r.role === 'OWNER' || r.role === 'TEACHER' || r.role === 'ASSISTANT'
          );
          if (targetIsPrivileged && !isOwnerInAny(resolved.roles)) {
            throw mcpError(
              'Removing a privileged member requires owner role',
              ErrorCode.InvalidRequest
            );
          }

          // Refuse to remove the classroom's last OWNER.
          if (targetRoles.some(r => r.role === 'OWNER')) {
            const ownerCount = await prisma.classroomMembership.count({
              where: { classroom_id: resolved.classroom.id, role: 'OWNER' },
            });
            if (ownerCount <= 1) {
              throw mcpError(
                'Cannot remove the last owner from this classroom',
                ErrorCode.InvalidRequest
              );
            }
          }

          await ClassmojiService.classroomMembership.remove(
            resolved.classroom.id,
            args.userId
          );
          return ok({ removed: { userId: args.userId } });
        }
        case 'update_membership': {
          await assertUserMemberOfClassroom(args.userId, resolved.classroom.id);

          const targetRoles = await prisma.classroomMembership.findMany({
            where: { classroom_id: resolved.classroom.id, user_id: args.userId },
            select: { role: true },
          });
          const targetIsPrivileged = targetRoles.some(
            r => r.role === 'OWNER' || r.role === 'TEACHER' || r.role === 'ASSISTANT'
          );
          if (targetIsPrivileged && !isOwnerInAny(resolved.roles)) {
            throw mcpError(
              'Modifying a privileged member requires owner role',
              ErrorCode.InvalidRequest
            );
          }

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
