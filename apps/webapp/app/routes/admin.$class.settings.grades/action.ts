import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import {
  DEFAULT_EMOJI_MAPPINGS,
  DEFAULT_LETTER_GRADE_MAPPINGS,
  SCORE_EMOJI_MAPPINGS,
} from '@classmoji/utils';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { pickSettings } from '~/utils/pickSettings';
import { addClassroomAuditLog } from '~/utils/helpers';
import { impersonationAuditFields } from '~/routes/admin.$class.ask-moji/impersonation.server';
import type { Route } from './+types/route';

/** The remap body's `mappings` (client JSON): a non-empty list of emoji pairs, else null. */
export const parseRemapMappings = (
  value: unknown
): Array<{ oldEmoji: string; newEmoji: string }> | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const out: Array<{ oldEmoji: string; newEmoji: string }> = [];
  for (const entry of value) {
    const { oldEmoji, newEmoji } = (entry ?? {}) as Record<string, unknown>;
    if (typeof oldEmoji !== 'string' || typeof newEmoji !== 'string') return null;
    if (!oldEmoji || !newEmoji || oldEmoji.length > 100 || newEmoji.length > 100) return null;
    out.push({ oldEmoji, newEmoji });
  }
  return out;
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership, userId } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'update_grade_settings',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async saveGradingSettings() {
      const { late_penalty_points_per_hour: penalty, show_grades_to_students: showEstimate } =
        pickSettings(data, ['late_penalty_points_per_hour', 'show_grades_to_students']);
      await ClassmojiService.classroom.updateSettings(classroom.id, {
        // A cleared number box sends null; keep the stored value then.
        ...(typeof penalty === 'number' &&
          Number.isFinite(penalty) && { late_penalty_points_per_hour: penalty }),
        // Stored as a real boolean whatever the body sent.
        ...(showEstimate !== undefined && { show_grades_to_students: showEstimate === true }),
      });
      return {
        action: 'SAVE_GRADING_SETTINGS',
        success: 'Saved grading settings successfully.',
      };
    },

    async saveEmojiToGradeMapping() {
      return ClassmojiService.emojiMapping.saveEmojiMapping(classroom.id, data);
    },

    async deleteEmojiToGradeMapping() {
      return ClassmojiService.emojiMapping.deleteEmojiMapping(classroom.id, data.emoji);
    },

    async saveLetterGradeMapping() {
      return ClassmojiService.letterGradeMapping.save(classroom.id, data);
    },

    async deleteLetterGradeMapping() {
      await ClassmojiService.letterGradeMapping.delete(classroom.id, data.letter_grade);
      return { success: 'Deleted mapping successfully.' };
    },

    async populateDefaultMappings() {
      // Wipe and replace in one transaction under the scale lock, so a quiz
      // re-seeding an empty scale meanwhile cannot leave a mixed one.
      await ClassmojiService.emojiMapping.replaceScale(classroom.id, DEFAULT_EMOJI_MAPPINGS);

      return {
        action: 'POPULATE_DEFAULT_MAPPINGS',
        success: 'Default emoji mappings have been added.',
      };
    },

    async populateScoreScaleMappings() {
      // Same shape as populateDefaultMappings: replace with the 11-step 0–100
      // scale. Grades and quiz adjustments on the old emojis surface in the
      // orphaned-grades banner, where the remap flow handles them.
      await ClassmojiService.emojiMapping.replaceScale(classroom.id, SCORE_EMOJI_MAPPINGS);

      return {
        action: 'POPULATE_SCORE_SCALE_MAPPINGS',
        success: '0–100 grade scale added (11 emojis).',
      };
    },

    async populateDefaultLetterGradeMappings() {
      // Remove existing letter grade mappings first
      const existingMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
        classroom.id
      );
      for (const mapping of existingMappings) {
        await ClassmojiService.letterGradeMapping.delete(classroom.id, mapping.letter_grade);
      }

      // Add defaults from shared constant
      for (const mapping of DEFAULT_LETTER_GRADE_MAPPINGS) {
        await ClassmojiService.letterGradeMapping.save(classroom.id, mapping);
      }

      return {
        action: 'POPULATE_DEFAULT_LETTER_GRADE_MAPPINGS',
        success: 'Default letter grade mappings have been added.',
      };
    },

    async remapOrphanedEmojis() {
      const mappings = parseRemapMappings(data?.mappings);
      if (!mappings) {
        return { action: 'REMAP_ORPHANED_EMOJIS', error: 'Pick a new emoji for each grade.' };
      }
      // Repo grades, quiz adjustments and quiz regrade snapshots, in the gate's
      // classroom only, in one transaction (E17).
      let result;
      try {
        result = await ClassmojiService.assignmentGrade.remapGradeEmojis(classroom.id, mappings);
      } catch (error) {
        if (error instanceof Error && error.name === 'RemapGradeEmojisError') {
          return { action: 'REMAP_ORPHANED_EMOJIS', error: error.message };
        }
        throw error;
      }
      await addClassroomAuditLog({
        classroomId: classroom.id,
        userId,
        role: membership!.role,
        action: 'UPDATE',
        resourceType: 'GRADES',
        metadata: {
          tool: 'web:settings.grades.remap_orphaned_emojis',
          mappings: mappings.map(m => ({ old_emoji: m.oldEmoji, new_emoji: m.newEmoji })),
          repo_grades: result.repoGrades,
          quiz_adjustments: result.quizAdjustments,
          regrade_snapshots: result.regradeSnapshots,
          ...(await impersonationAuditFields(request)),
        },
        dedupe: false,
      });
      return {
        action: 'REMAP_ORPHANED_EMOJIS',
        success:
          result.quizAdjustments > 0
            ? `Remapped ${result.repoGrades} grade(s) and ${result.quizAdjustments} quiz adjustment(s).`
            : `Successfully remapped ${result.totalRemapped} grade(s).`,
        totalRemapped: result.totalRemapped,
      };
    },
  });
};
