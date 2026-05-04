import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import {
  assertAssignmentGradeInClassroom,
  assertRepositoryAssignmentInClassroom,
  assertUserMemberOfClassroom,
} from '../context/ownership.ts';
import { isOwnerInAny, isStaffInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * `grades_write` — modify grades.
 *
 * Methods (registered for TEACHING_TEAM; per-method tier varies):
 *   add                 — TEACHING (assistants are graders): add an emoji grade
 *   remove              — TEACHING: remove a single grade by id
 *   remove_all          — STAFF (OWNER+TEACHER): bulk-clear grades on a repo assignment
 *   update_letter       — STAFF: set a student's final letter grade
 *   remap_emojis        — OWNER: bulk swap emoji symbols across the classroom
 *                                 (changes grading policy)
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
      // add / remove are open to TEACHING (assistants grade individual
      // assignments). The other methods narrow further: remove_all and
      // update_letter need STAFF; remap_emojis is OWNER (grading policy).
      const STAFF_METHODS = new Set(['remove_all', 'update_letter']);
      if (STAFF_METHODS.has(args.method) && !isStaffInAny(resolved.roles)) {
        throw mcpError(
          `Method '${args.method}' requires staff role`,
          ErrorCode.InvalidRequest
        );
      }
      if (args.method === 'remap_emojis' && !isOwnerInAny(resolved.roles)) {
        throw mcpError("Method 'remap_emojis' requires owner role", ErrorCode.InvalidRequest);
      }

      switch (args.method) {
        case 'add': {
          if (!args.repositoryAssignmentId || !args.emoji)
            throw mcpError('add requires repositoryAssignmentId and emoji', ErrorCode.InvalidParams);
          await assertRepositoryAssignmentInClassroom(
            args.repositoryAssignmentId,
            resolved.classroom.id
          );
          const result = await ClassmojiService.assignmentGrade.addGrade(
            args.repositoryAssignmentId,
            ctx.userId,
            args.emoji
          );
          return ok({ added: result });
        }
        case 'remove': {
          if (!args.gradeId) throw mcpError('remove requires gradeId', ErrorCode.InvalidParams);
          await assertAssignmentGradeInClassroom(args.gradeId, resolved.classroom.id);
          await ClassmojiService.assignmentGrade.removeGrade(args.gradeId);
          return ok({ removed: { id: args.gradeId } });
        }
        case 'remove_all': {
          if (!args.repositoryAssignmentId)
            throw mcpError('remove_all requires repositoryAssignmentId', ErrorCode.InvalidParams);
          await assertRepositoryAssignmentInClassroom(
            args.repositoryAssignmentId,
            resolved.classroom.id
          );
          await ClassmojiService.assignmentGrade.removeAllGrades(args.repositoryAssignmentId);
          return ok({ removedAll: { repositoryAssignmentId: args.repositoryAssignmentId } });
        }
        case 'update_letter': {
          if (!args.userId || !args.letterGrade)
            throw mcpError('update_letter requires userId + letterGrade', ErrorCode.InvalidParams);
          await assertUserMemberOfClassroom(args.userId, resolved.classroom.id);
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
