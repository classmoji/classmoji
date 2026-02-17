import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { DEFAULT_EMOJI_MAPPINGS, DEFAULT_LETTER_GRADE_MAPPINGS } from '@classmoji/utils';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'update_grade_settings',
  });

  const data = await request.json();

  return namedAction(request, {
    async saveGradingSettings() {
      await ClassmojiService.classroom.updateSettings(classroom.id, data);
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
      // Remove existing mappings first (pass true to get array with full mapping objects)
      const existingMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id, true);
      for (const mapping of existingMappings) {
        await ClassmojiService.emojiMapping.deleteEmojiMapping(classroom.id, mapping.emoji);
      }

      // Add defaults from shared constant
      for (const mapping of DEFAULT_EMOJI_MAPPINGS) {
        await ClassmojiService.emojiMapping.saveEmojiMapping(classroom.id, mapping);
      }

      return {
        action: 'POPULATE_DEFAULT_MAPPINGS',
        success: 'Default emoji mappings have been added.',
      };
    },

    async populateDefaultLetterGradeMappings() {
      // Remove existing letter grade mappings first
      const existingMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id);
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
      const { mappings } = data;
      const result = await ClassmojiService.assignmentGrade.remapGradeEmojis(classroom.id, mappings);
      return {
        action: 'REMAP_ORPHANED_EMOJIS',
        success: `Successfully remapped ${result.totalRemapped} grade(s).`,
        totalRemapped: result.totalRemapped,
      };
    },
  });
};
