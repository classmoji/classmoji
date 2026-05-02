import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * `grades_write` — modify grades.
 *
 * Methods (some require admin within the classroom even though tool is registered for teaching team):
 *   add                 — TEACHING_TEAM: add an emoji grade to a repo assignment
 *   remove              — TEACHING_TEAM: remove a single grade by id
 *   remove_all          — ADMIN: remove all grades for a repo assignment
 *   release             — ADMIN: not yet wired (needs assignmentService.releaseGrades)
 *   update_letter       — ADMIN: set a student's letter grade
 *   remap_emojis        — ADMIN: bulk swap emoji symbols across all grades in classroom
 */
export function registerGradesWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'grades_write',
    {
      title: 'Modify grades',
      description:
        'Modify assignment grades. Methods: add, remove (teaching team); remove_all, ' +
        'update_letter, remap_emojis (admin only).',
      inputSchema: z.object({
        method: z.enum(['add', 'remove', 'remove_all', 'update_letter', 'remap_emojis']),
        classroomSlug: classroomSlugSchema(ctx),
        repositoryAssignmentId: z.string().uuid().optional(),
        gradeId: z.string().uuid().optional(),
        emoji: z.string().optional(),
        userId: z.string().uuid().optional().describe('For update_letter'),
        letterGrade: z.string().optional().describe('For update_letter'),
        mappings: z
          .array(z.object({ oldEmoji: z.string(), newEmoji: z.string() }))
          .optional()
          .describe('For remap_emojis: list of {oldEmoji, newEmoji}'),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      const adminMethods = new Set(['remove_all', 'update_letter', 'remap_emojis']);
      if (adminMethods.has(args.method) && !isAdminInAny(resolved.roles)) {
        throw mcpError(`Method '${args.method}' requires admin role`, ErrorCode.InvalidRequest);
      }

      switch (args.method) {
        case 'add': {
          if (!args.repositoryAssignmentId || !args.emoji)
            throw mcpError('add requires repositoryAssignmentId and emoji', ErrorCode.InvalidParams);
          const result = await ClassmojiService.assignmentGrade.addGrade(
            args.repositoryAssignmentId,
            ctx.userId,
            args.emoji
          );
          return ok({ added: result });
        }
        case 'remove': {
          if (!args.gradeId) throw mcpError('remove requires gradeId', ErrorCode.InvalidParams);
          await ClassmojiService.assignmentGrade.removeGrade(args.gradeId);
          return ok({ removed: { id: args.gradeId } });
        }
        case 'remove_all': {
          if (!args.repositoryAssignmentId)
            throw mcpError('remove_all requires repositoryAssignmentId', ErrorCode.InvalidParams);
          await ClassmojiService.assignmentGrade.removeAllGrades(args.repositoryAssignmentId);
          return ok({ removedAll: { repositoryAssignmentId: args.repositoryAssignmentId } });
        }
        case 'update_letter': {
          if (!args.userId || !args.letterGrade)
            throw mcpError('update_letter requires userId + letterGrade', ErrorCode.InvalidParams);
          await ClassmojiService.classroomMembership.update(
            resolved.classroom.id,
            args.userId,
            { letter_grade: args.letterGrade }
          );
          return ok({ letterUpdated: { userId: args.userId, letterGrade: args.letterGrade } });
        }
        case 'remap_emojis': {
          if (!args.mappings) throw mcpError('remap_emojis requires mappings', ErrorCode.InvalidParams);
          const result = await ClassmojiService.assignmentGrade.remapGradeEmojis(
            resolved.classroom.id,
            args.mappings
          );
          return ok({ remapped: result });
        }
      }
    }
  );
}
