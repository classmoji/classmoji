import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

export function registerTeamsWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'teams_write',
    {
      title: 'Manage classroom teams',
      description:
        'Manage classroom teams (admin-only). Methods: create, delete, ' +
        'add_member, remove_member.',
      inputSchema: z.object({
        method: z.enum(['create', 'delete', 'add_member', 'remove_member']),
        classroomSlug: classroomSlugSchema(ctx),
        teamSlug: z.string().optional().describe('Required for delete/add_member/remove_member'),
        teamName: z.string().optional().describe('Required for create'),
        userId: z.string().uuid().optional().describe('Required for add_member/remove_member'),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'create': {
          if (!args.teamName) throw mcpError('create requires teamName', ErrorCode.InvalidParams);
          const slug = args.teamName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const result = await ClassmojiService.team.create({
            classroomId: resolved.classroom.id,
            name: args.teamName,
            slug,
          });
          return ok({ created: { id: result.id, name: result.name, slug: result.slug } });
        }
        case 'delete': {
          if (!args.teamSlug) throw mcpError('delete requires teamSlug', ErrorCode.InvalidParams);
          await ClassmojiService.team.deleteBySlug(resolved.classroom.id, args.teamSlug);
          return ok({ deleted: { teamSlug: args.teamSlug } });
        }
        case 'add_member': {
          if (!args.teamSlug || !args.userId)
            throw mcpError('add_member requires teamSlug + userId', ErrorCode.InvalidParams);
          const team = await ClassmojiService.team.findBySlugAndClassroomId(
            args.teamSlug,
            resolved.classroom.id
          );
          if (!team) throw mcpError('Team not found', ErrorCode.InvalidRequest);
          const result = await ClassmojiService.teamMembership.addMemberToTeam(team.id, args.userId);
          return ok({ added: { teamSlug: args.teamSlug, userId: args.userId, result } });
        }
        case 'remove_member': {
          if (!args.teamSlug || !args.userId)
            throw mcpError('remove_member requires teamSlug + userId', ErrorCode.InvalidParams);
          const team = await ClassmojiService.team.findBySlugAndClassroomId(
            args.teamSlug,
            resolved.classroom.id
          );
          if (!team) throw mcpError('Team not found', ErrorCode.InvalidRequest);
          const result = await ClassmojiService.teamMembership.removeMemberFromTeam(team.id, args.userId);
          return ok({ removed: { teamSlug: args.teamSlug, userId: args.userId, result } });
        }
      }
    }
  );
}
