import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import type { AuthContext } from '../auth/context.ts';
import { resolveClassroom } from '../context/classroom.ts';
import { isAdminInAny } from '../auth/roles.ts';
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
      if (!isAdminInAny(resolved.roles))
        throw mcpError('Admin role required', ErrorCode.InvalidRequest);

      switch (args.method) {
        case 'emoji_save': {
          if (!args.emoji || args.score === undefined)
            throw mcpError('emoji_save requires emoji + score', ErrorCode.InvalidParams);
          const result = await ClassmojiService.emojiMapping.saveEmojiMapping(
            resolved.classroom.id,
            {
              emoji: args.emoji,
              score: args.score,
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
          const result = await ClassmojiService.letterGradeMapping.save(
            resolved.classroom.id,
            args.letterMapping as never
          );
          return ok({ saved: result });
        }
      }
    }
  );
}
