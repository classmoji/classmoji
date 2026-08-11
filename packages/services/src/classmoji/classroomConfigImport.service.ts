import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import { ModuleItemType } from '@prisma/client';

type RepositoryImportClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/**
 * Selections describing which slices of a source classroom's configuration to
 * copy into a target classroom. Each flag is independent; omitting/false skips
 * that slice entirely.
 */
export interface ConfigImportSelections {
  /** late_penalty_points_per_hour, show_grades_to_students */
  grading?: boolean;
  /** EmojiMapping + LetterGradeMapping rows (grade scales) */
  gradeScales?: boolean;
  /** default_tokens_per_hour */
  tokens?: boolean;
  /**
   * quizzes_enabled, slides_enabled, syllabus_bot_enabled,
   * recent_viewers_enabled, show_modules, show_pages, show_repos,
   * default_student_page, theme
   */
  features?: boolean;
  /** llm_provider, llm_model, llm_temperature, llm_max_tokens, code_aware_model, syllabus_bot_model */
  aiConfig?: boolean;
  /** openai_api_key, anthropic_api_key — OPT-IN secrets, never copied unless enabled */
  apiKeys?: boolean;
  /** CalendarEvent rows, dates copied verbatim */
  calendar?: boolean;
}

/**
 * Summary of what `importClassroomConfig` actually wrote to the target.
 */
export interface ConfigImportSummary {
  /** Which ClassroomSettings fields were written (post null/undefined filtering). */
  settings_fields: string[];
  /** Number of EmojiMapping rows inserted (skipDuplicates applied). */
  emoji_mappings: number;
  /** Number of LetterGradeMapping rows inserted (skipDuplicates applied). */
  letter_grade_mappings: number;
  /** Number of CalendarEvent rows inserted. */
  calendar_events: number;
}

/**
 * ClassroomSettings field membership per selectable group. gradeScales and
 * calendar are intentionally NOT here — they map to separate tables, not to
 * columns on classroom_settings.
 *
 * NEVER included: content_repo_name, classroom_id (PK), created_at, updated_at.
 */
export const SETTINGS_FIELD_GROUPS: Record<
  'grading' | 'tokens' | 'features' | 'aiConfig' | 'apiKeys',
  readonly string[]
> = {
  grading: ['late_penalty_points_per_hour', 'show_grades_to_students'],
  tokens: ['default_tokens_per_hour'],
  features: [
    'quizzes_enabled',
    'slides_enabled',
    'syllabus_bot_enabled',
    'recent_viewers_enabled',
    'show_modules',
    'show_pages',
    'show_repos',
    'default_student_page',
    'theme',
  ],
  aiConfig: [
    'llm_provider',
    'llm_model',
    'llm_temperature',
    'llm_max_tokens',
    'code_aware_model',
    'syllabus_bot_model',
  ],
  apiKeys: ['openai_api_key', 'anthropic_api_key'],
};

/**
 * Pure helper: the union (in stable group order, de-duplicated) of
 * classroom_settings field names implied by the enabled selection groups.
 * apiKeys is included only when explicitly opted in. gradeScales/calendar are
 * not settings groups and never contribute fields here.
 *
 * @param {ConfigImportSelections} selections - Enabled import groups
 * @returns {string[]} - Ordered, de-duplicated settings field names
 */
export function selectedSettingsFields(selections: ConfigImportSelections): string[] {
  const order: Array<keyof typeof SETTINGS_FIELD_GROUPS> = [
    'grading',
    'tokens',
    'features',
    'aiConfig',
    'apiKeys',
  ];
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const group of order) {
    if (!selections[group]) continue;
    for (const field of SETTINGS_FIELD_GROUPS[group]) {
      if (seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Copy selected configuration from a source classroom into an existing target
 * classroom.
 *
 * Settings: builds a patch of ONLY the fields implied by the enabled groups
 * (via `selectedSettingsFields`). A source field is skipped when it is null or
 * undefined; booleans/numbers copy verbatim including false/0 (they are never
 * null/undefined for the non-nullable columns). The target's settings row is
 * assumed to already exist and is updated by classroom_id. Never copies
 * content_repo_name, classroom_id, id, or timestamps.
 *
 * gradeScales: copies all source EmojiMapping and LetterGradeMapping rows via
 * createMany({ skipDuplicates: true }).
 *
 * calendar: copies CalendarEvent rows verbatim (dates included), re-pointing
 * classroom_id to the target and created_by to `createdByUserId`. Does not copy
 * ids/timestamps or related override/link rows.
 *
 * @param {string} sourceClassroomId - Classroom to copy configuration from
 * @param {string} targetClassroomId - Classroom to copy configuration into
 * @param {string} createdByUserId - User id used as created_by for calendar events
 * @param {ConfigImportSelections} selections - Which slices to import
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<ConfigImportSummary>} - What was written
 */
export const importClassroomConfig = async (
  sourceClassroomId: string,
  targetClassroomId: string,
  createdByUserId: string,
  selections: ConfigImportSelections,
  tx: RepositoryImportClient = getPrisma()
): Promise<ConfigImportSummary> => {
  const summary: ConfigImportSummary = {
    settings_fields: [],
    emoji_mappings: 0,
    letter_grade_mappings: 0,
    calendar_events: 0,
  };

  // --- ClassroomSettings patch -------------------------------------------
  const fields = selectedSettingsFields(selections);
  if (fields.length > 0) {
    const source = await tx.classroomSettings.findUnique({
      where: { classroom_id: sourceClassroomId },
    });
    if (!source) {
      throw new Error(`Source classroom settings not found: ${sourceClassroomId}`);
    }

    const sourceRecord = source as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const written: string[] = [];
    for (const field of fields) {
      const value = sourceRecord[field];
      // Skip null/undefined; false/0 are not null/undefined so they copy verbatim.
      if (value === null || value === undefined) continue;
      patch[field] = value;
      written.push(field);
    }

    if (written.length > 0) {
      await tx.classroomSettings.update({
        where: { classroom_id: targetClassroomId },
        data: patch as Prisma.ClassroomSettingsUpdateInput,
      });
    }
    summary.settings_fields = written;
  }

  // --- Grade scales (emoji + letter grade mappings) ----------------------
  if (selections.gradeScales) {
    const emojiMappings = await tx.emojiMapping.findMany({
      where: { classroom_id: sourceClassroomId },
    });
    if (emojiMappings.length > 0) {
      const result = await tx.emojiMapping.createMany({
        data: emojiMappings.map(row => ({
          classroom_id: targetClassroomId,
          emoji: row.emoji,
          grade: row.grade,
          extra_tokens: row.extra_tokens,
          description: row.description,
        })),
        skipDuplicates: true,
      });
      summary.emoji_mappings = result.count;
    }

    const letterMappings = await tx.letterGradeMapping.findMany({
      where: { classroom_id: sourceClassroomId },
    });
    if (letterMappings.length > 0) {
      const result = await tx.letterGradeMapping.createMany({
        data: letterMappings.map(row => ({
          classroom_id: targetClassroomId,
          letter_grade: row.letter_grade,
          min_grade: row.min_grade,
        })),
        skipDuplicates: true,
      });
      summary.letter_grade_mappings = result.count;
    }
  }

  // --- Calendar events ---------------------------------------------------
  if (selections.calendar) {
    const events = await tx.calendarEvent.findMany({
      where: { classroom_id: sourceClassroomId },
    });
    if (events.length > 0) {
      const data: Prisma.CalendarEventCreateManyInput[] = events.map(event => ({
        classroom_id: targetClassroomId,
        created_by: createdByUserId,
        title: event.title,
        description: event.description,
        event_type: event.event_type,
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
        meeting_link: event.meeting_link,
        is_recurring: event.is_recurring,
        // Nullable Json: omit when null to sidestep Prisma DbNull/JsonNull typing.
        ...(event.recurrence_rule === null
          ? {}
          : { recurrence_rule: event.recurrence_rule as Prisma.InputJsonValue }),
      }));
      const result = await tx.calendarEvent.createMany({ data });
      summary.calendar_events = result.count;
    }
  }

  return summary;
};

// ============================================================================
// Module (container) import with resource id remapping
// ============================================================================

/**
 * Maps of source resource id → cloned/target resource id, one per resource kind
 * a ModuleItem can point at. Filled by the various import passes (repositories
 * and quizzes come from repositoryImport; pages/slides from content import).
 */
export interface ModuleImportIdMaps {
  repositories: Record<string, string>;
  quizzes: Record<string, string>;
  pages: Record<string, string>;
  slides: Record<string, string>;
}

/**
 * The subset of a source ModuleItem needed to remap it. Exactly one of the
 * *_id fields is set on any real row (matching item_type).
 */
export interface SourceModuleItemShape {
  item_type: ModuleItemType;
  position: number;
  page_id: string | null;
  repository_id: string | null;
  quiz_id: string | null;
  slide_id: string | null;
}

/**
 * A ModuleItem remapped onto target resource ids, ready to be written under a
 * new module. Exactly one *_id is non-null (the one matching item_type).
 */
export interface RemappedItem {
  item_type: ModuleItemType;
  position: number;
  page_id: string | null;
  repository_id: string | null;
  quiz_id: string | null;
  slide_id: string | null;
}

/**
 * Pure helper: remap a source ModuleItem's resource reference onto the target
 * ids. Returns null when the referenced resource was not imported (missing map
 * entry, or a null source id for the item's type) — the caller SKIPS such
 * items. The ModuleItemType enum is PAGE/REPOSITORY/QUIZ/SLIDE only; every item
 * references an imported resource, so there is no verbatim/no-remap case.
 *
 * @param {SourceModuleItemShape} item - Source module item
 * @param {ModuleImportIdMaps} idMaps - Source→target resource id maps
 * @returns {RemappedItem | null} - Remapped item, or null to skip
 */
export function remapModuleItem(
  item: SourceModuleItemShape,
  idMaps: ModuleImportIdMaps
): RemappedItem | null {
  const base: RemappedItem = {
    item_type: item.item_type,
    position: item.position,
    page_id: null,
    repository_id: null,
    quiz_id: null,
    slide_id: null,
  };

  switch (item.item_type) {
    case ModuleItemType.PAGE: {
      const mapped = item.page_id ? idMaps.pages[item.page_id] : undefined;
      if (!mapped) return null;
      return { ...base, page_id: mapped };
    }
    case ModuleItemType.REPOSITORY: {
      const mapped = item.repository_id ? idMaps.repositories[item.repository_id] : undefined;
      if (!mapped) return null;
      return { ...base, repository_id: mapped };
    }
    case ModuleItemType.QUIZ: {
      const mapped = item.quiz_id ? idMaps.quizzes[item.quiz_id] : undefined;
      if (!mapped) return null;
      return { ...base, quiz_id: mapped };
    }
    case ModuleItemType.SLIDE: {
      const mapped = item.slide_id ? idMaps.slides[item.slide_id] : undefined;
      if (!mapped) return null;
      return { ...base, slide_id: mapped };
    }
    default:
      return null;
  }
}

/**
 * Copy Module containers (and their items) from a source classroom into a
 * target classroom, remapping each item's resource reference through the
 * provided id maps. Modules are forced unpublished. Item ordering (position) is
 * preserved. Items whose referenced resource was not imported are skipped and
 * counted.
 *
 * @param {string} sourceClassroomId - Classroom to copy modules from
 * @param {string} targetClassroomId - Classroom to copy modules into
 * @param {ModuleImportIdMaps} idMaps - Source→target resource id maps
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<{ modules: number; items: number; skipped_items: number }>}
 */
export const importModules = async (
  sourceClassroomId: string,
  targetClassroomId: string,
  idMaps: ModuleImportIdMaps,
  tx: RepositoryImportClient = getPrisma()
): Promise<{ modules: number; items: number; skipped_items: number }> => {
  const sourceModules = await tx.module.findMany({
    where: { classroom_id: sourceClassroomId },
    include: { items: { orderBy: { position: 'asc' } } },
    orderBy: { position: 'asc' },
  });

  let modules = 0;
  let items = 0;
  let skipped_items = 0;

  for (const sourceModule of sourceModules) {
    const newModule = await tx.module.create({
      data: {
        classroom_id: targetClassroomId,
        title: sourceModule.title,
        slug: sourceModule.slug,
        description: sourceModule.description,
        position: sourceModule.position,
        is_published: false,
      },
    });
    modules += 1;

    for (const item of sourceModule.items) {
      const remapped = remapModuleItem(item, idMaps);
      if (!remapped) {
        skipped_items += 1;
        continue;
      }
      await tx.moduleItem.create({
        data: {
          module_id: newModule.id,
          item_type: remapped.item_type,
          position: remapped.position,
          page_id: remapped.page_id,
          repository_id: remapped.repository_id,
          quiz_id: remapped.quiz_id,
          slide_id: remapped.slide_id,
        },
      });
      items += 1;
    }
  }

  return { modules, items, skipped_items };
};
