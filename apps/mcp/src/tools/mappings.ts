import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isOwnerInAny } from '../auth/roles.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import { classroomSlugSchema, ok } from './_helpers.ts';

/**
 * `mappings_write` — manage emoji-to-grade and letter-grade mappings.
 *
 * Methods:
 *   emoji_save        — save (upsert) one emoji → score mapping
 *   emoji_delete      — delete one emoji mapping
 *   letter_save       — save the classroom's letter grade mapping (full set)
 */
export function registerMappingsWrite(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'mappings_write',
    {
      title: 'Manage grade mappings',
      description:
        'Manage emoji-grade and letter-grade mappings (admin-only). Methods: ' +
        'emoji_save, emoji_delete, letter_save.',
      inputSchema: z.object({
        method: z.enum(['emoji_save', 'emoji_delete', 'letter_save']),
        classroomSlug: classroomSlugSchema(ctx),
        emoji: z.string().optional(),
        score: z.number().optional(),
        description: z.string().optional(),
        letterMapping: z
          .array(z.object({ letter: z.string(), min_score: z.number() }))
          .optional()
          .describe('For letter_save: full mapping array'),
      }).shape,
    },
    async args => {
      const resolved = await resolveClassroom(ctx, args.classroomSlug);
      if (!isOwnerInAny(resolved.roles))
        throw mcpError('Owner role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'emoji_save': {
          if (!args.emoji || args.score === undefined)
            throw mcpError('emoji_save requires emoji + score', ErrorCode.InvalidParams);
          const result = await ClassmojiService.emojiMapping.saveEmojiMapping(
            resolved.classroom.id,
            {
              emoji: args.emoji,
              grade: args.score,
              description: args.description ?? '',
            } as never
          );
          return ok({ saved: result });
        }
        case 'emoji_delete': {
          if (!args.emoji) throw mcpError('emoji_delete requires emoji', ErrorCode.InvalidParams);
          await ClassmojiService.emojiMapping.deleteEmojiMapping(
            resolved.classroom.id,
            args.emoji
          );
          return ok({ deleted: { emoji: args.emoji } });
        }
        case 'letter_save': {
          if (!args.letterMapping)
            throw mcpError('letter_save requires letterMapping[]', ErrorCode.InvalidParams);
          const prisma = getPrisma();
          const saved = await prisma.$transaction(async tx => {
            await tx.letterGradeMapping.deleteMany({
              where: { classroom_id: resolved.classroom.id },
            });
            const created: Array<{ letter_grade: string; min_grade: number }> = [];
            for (const m of args.letterMapping!) {
              const row = await tx.letterGradeMapping.create({
                data: {
                  classroom_id: resolved.classroom.id,
                  letter_grade: m.letter,
                  min_grade: m.min_score,
                },
              });
              created.push({ letter_grade: row.letter_grade, min_grade: row.min_grade });
            }
            return created;
          });
          return ok({ saved });
        }
      }
    }
  );
}
