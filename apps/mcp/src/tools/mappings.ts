/**
 * Grading-scale tools — emoji_mapping_upsert / letter_grade_mapping_upsert.
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.settings.grades/action.ts:
 * requireClassroomAdmin — OWNER only.
 *
 * S1 is inherent: both services upsert on the composite unique key
 * (classroom_id, emoji|letter_grade) with the classroom id taken from the
 * AUTHORIZED context, so a foreign classroom's row can never be touched.
 */

import { ClassmojiService } from '@classmoji/services';
import { z } from 'zod';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, writeAudit } from './shared.ts';

interface EmojiMappingArgs {
  classroom: string;
  emoji: string;
  grade: number;
  extra_tokens?: number;
  description?: string;
}

export const emojiMappingUpsertTool: ToolDefinition<EmojiMappingArgs> = {
  name: 'emoji_mapping_upsert',
  title: 'Create or update an emoji grade mapping',
  description:
    "Creates or updates one emoji in the classroom's grading scale: its numeric grade value, " +
    'bonus tokens minted when the emoji is awarded, and a description. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    emoji: z.string().min(1).max(16).describe('The emoji (unique per classroom)'),
    grade: z.number().min(0).max(1000).describe('Numeric grade value (e.g. 100)'),
    extra_tokens: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe('Bonus tokens minted when this emoji is awarded (omit to keep current)'),
    description: z.string().max(500).optional().describe('Human-readable label'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    const mapping = await ClassmojiService.emojiMapping.saveEmojiMapping(classroom.classroomId, {
      emoji: args.emoji,
      grade: args.grade,
      // Omit undefined fields so the upsert's UPDATE branch leaves them unchanged.
      ...(args.extra_tokens !== undefined ? { extra_tokens: args.extra_tokens } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
    });

    await writeAudit(ctx, {
      resource_type: 'SETTINGS',
      resource_id: mapping.id,
      action: 'UPDATE',
      data: { tool: 'emoji_mapping_upsert', emoji: args.emoji, grade: args.grade },
    });

    return ok({
      success: true,
      mapping: {
        emoji: mapping.emoji,
        grade: mapping.grade,
        extra_tokens: mapping.extra_tokens,
        description: mapping.description,
      },
    });
  },
};

interface LetterGradeMappingArgs {
  classroom: string;
  letter_grade: string;
  min_grade: number;
}

export const letterGradeMappingUpsertTool: ToolDefinition<LetterGradeMappingArgs> = {
  name: 'letter_grade_mapping_upsert',
  title: 'Create or update a letter grade mapping',
  description:
    'Creates or updates one letter-grade threshold (e.g. A = min 90) in the classroom. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    letter_grade: z.string().min(1).max(8).describe("Letter grade label (e.g. 'A', 'B+')"),
    min_grade: z.number().min(0).max(1000).describe('Minimum numeric grade for this letter'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    const mapping = await ClassmojiService.letterGradeMapping.save(classroom.classroomId, {
      letter_grade: args.letter_grade,
      min_grade: args.min_grade,
    });

    await writeAudit(ctx, {
      resource_type: 'SETTINGS',
      resource_id: mapping.id,
      action: 'UPDATE',
      data: {
        tool: 'letter_grade_mapping_upsert',
        letter_grade: args.letter_grade,
        min_grade: args.min_grade,
      },
    });

    return ok({
      success: true,
      mapping: { letter_grade: mapping.letter_grade, min_grade: mapping.min_grade },
    });
  },
};
