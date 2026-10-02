import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import { ModuleItemType } from '@prisma/client';
import { isAllowedModel } from '@classmoji/utils/ai-models';
import { meetingLinkForCopy } from './calendarPolicy.ts';
import * as entitlementService from './entitlement.service.ts';
import {
  SOURCE_QUIZ_ASSIGNMENT_SELECT,
  cloneQuiz,
  cloneQuizAssignment,
  ensureTargetModule,
} from './repositoryImport.service.ts';

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
   * quizzes_enabled, slides_enabled, syllabus_bot_enabled, recent_viewers_enabled,
   * show_modules, show_pages, show_repos, default_student_page, theme.
   * syllabus_bot_enabled only lands on a Pro target — see importClassroomConfig.
   */
  features?: boolean;
  /**
   * llm_provider, llm_model, llm_temperature, llm_max_tokens, code_aware_model,
   * exploration_model, question_effort, grading_effort, exploration_effort,
   * syllabus_bot_model, syllabus_bot_effort
   */
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
  /**
   * Fields deliberately NOT written because the target classroom is not
   * entitled to them (today: syllabus_bot_enabled on a non-Pro target). Present
   * only when something was skipped, so the caller can say so rather than
   * letting the setting vanish silently.
   */
  settings_fields_skipped?: string[];
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
    // Pro-gated. This writer bypasses `updateSettings`, so the entitlement of
    // the TARGET classroom is checked in importClassroomConfig below and the
    // field dropped from the patch when it is not allowed. Listed here so a
    // Pro -> Pro clone still carries it.
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
    'exploration_model',
    'question_effort',
    'grading_effort',
    'exploration_effort',
    'syllabus_bot_model',
    'syllabus_bot_effort',
  ],
  apiKeys: ['openai_api_key', 'anthropic_api_key'],
};

/**
 * The quiz model columns. Both quiz runtimes run only allow-listed models
 * (isAllowedModel, @classmoji/utils/ai-models), and the AI settings page
 * refuses any other, so the import writes an off-list id as null — the
 * platform default, which is what it would run as anyway.
 */
const QUIZ_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'llm_model',
  'code_aware_model',
  'exploration_model',
]);

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
 * null/undefined for the non-nullable columns). A quiz model off the allow-list
 * is written as null (QUIZ_MODEL_FIELDS). The target's settings row is
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
    const skipped: string[] = [];

    // This writer does not go through `updateSettings`, so the Pro gate on
    // syllabus_bot_enabled has to be applied here. Only ENABLING is gated —
    // copying a `false` is always fine — and the check runs once, only when the
    // source actually has it on.
    const copyingBotOn =
      fields.includes('syllabus_bot_enabled') && sourceRecord.syllabus_bot_enabled === true;
    const botAllowedOnTarget = copyingBotOn
      ? (await entitlementService.canUseSyllabusBot(targetClassroomId)).allowed
      : false;

    for (const field of fields) {
      const value = sourceRecord[field];
      // Skip null/undefined; false/0 are not null/undefined so they copy verbatim.
      if (value === null || value === undefined) continue;
      if (field === 'syllabus_bot_enabled' && value === true && !botAllowedOnTarget) {
        skipped.push(field);
        continue;
      }
      if (QUIZ_MODEL_FIELDS.has(field)) {
        const id = typeof value === 'string' ? value.trim() : '';
        patch[field] = isAllowedModel(id) ? id : null;
        written.push(field);
        continue;
      }
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
    if (skipped.length > 0) summary.settings_fields_skipped = skipped;
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
        event_type: event.event_type,
        start_time: event.start_time,
        end_time: event.end_time,
        location: event.location,
        // meeting_link and description: text that is not a web link moves to the description.
        ...meetingLinkForCopy(event.meeting_link, event.description),
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
  /**
   * Source module → the target module the repository copy already put
   * assignments in. Reused here rather than creating a second module of the
   * same title (a module's title is unique in its classroom).
   */
  modules?: Record<string, string>;
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
 * Compile-time exhaustiveness guard for the switch over ModuleItemType below.
 * Adding a value to the enum without deciding what the importer does with it is
 * a type error here; reaching it at runtime throws rather than silently
 * dropping the item and counting it as "resource not imported".
 */
const unhandledModuleItemType = (type: never): never => {
  throw new Error(`Unhandled ModuleItemType in remapModuleItem: ${String(type)}`);
};

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
 * items. Every item references an imported resource, so there is no
 * verbatim/no-remap case.
 *
 * FORM is deliberately a null case rather than a mapping: forms are not part of
 * the classroom config bundle at all — nothing exports them and `idMaps` has no
 * `forms` entry to remap through — so a FORM module item is DROPPED on import,
 * exactly as an unmapped page is. When forms join the bundle, add `forms` to
 * ModuleImportIdMaps, `form_id` to SourceModuleItemShape/RemappedItem, and turn
 * this case into the mapping its siblings already are.
 *
 * The `default` throws instead of returning null. That reversal is the point:
 * the old `default: return null` is precisely how a FORM item would have been
 * silently swallowed by an importer nobody remembered to teach, and the next
 * ModuleItemType would go the same way. `never` makes it a compile error the
 * day the enum grows, and a loud one if a row ever carries a type this build
 * does not know.
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
    case ModuleItemType.FORM:
      // Not in the config bundle yet — see the note above. Dropped, not thrown:
      // a source classroom that happens to hold a form must still import.
      return null;
    default:
      return unhandledModuleItemType(item.item_type);
  }
}

/** What `importModules` did, and the ids it resolved or minted (for resume). */
export interface ImportModulesSummary {
  /** Source modules brought over: reused from the repository copy, or created. */
  modules: number;
  /** Content items in place: written, or already held by the module. */
  items: number;
  /** Content items whose resource was not imported. */
  skipped_items: number;
  /** Quizzes this phase copied (those no repository copy brought over). */
  quizzes: number;
  /** Quiz assignments this phase created. */
  quiz_assignments: number;
  /** Source → target ids this run resolved: modules, and the quizzes it copied. */
  id_maps: { modules: Record<string, string>; quizzes: Record<string, string> };
}

/**
 * Copy Module containers, their content items and their quizzes from a source
 * classroom into a target classroom. Modules are created unpublished. Item
 * ordering (position) is preserved. Items whose referenced resource was not
 * imported are skipped and counted.
 *
 * Idempotent, so a retried import picks up where a failed one stopped:
 *   - a source module lands in the target module the repository copy already
 *     made for it (`idMaps.modules`), else in the target module of the same
 *     title (find-or-create by the module's unique key), else in a new one —
 *     never in a second module of the same title. An existing module is left
 *     as it is (never re-published or re-ordered);
 *   - an item the module already holds is kept, not re-created (each resource
 *     may appear only once per module), and counted as imported;
 *   - a quiz already copied is not copied again, and one that already has an
 *     assignment gets no second one.
 *
 * Quizzes reach a module through their QUIZ assignment, so legacy QUIZ items
 * are not copied. Where quizzes are copied at all (`quizzesImported`: the new
 * classroom shows them), every QUIZ assignment of a source module is: its quiz
 * is copied unless an earlier phase copied it (`idMaps.quizzes`; that phase
 * also gave it its assignment), with its repository link mapped through
 * `idMaps.repositories` or dropped, and its assignment is created in the
 * target module, unpublished, deadlines stripped unless `stripDeadlines` is
 * false. A quiz whose repository the user chose to bring WITHOUT its quizzes
 * (`declinedQuizRepositoryIds`) is left out. Each quiz and its assignment are
 * written together, in one transaction when `tx` is not one already.
 *
 * @param {string} sourceClassroomId - Classroom to copy modules from
 * @param {string} targetClassroomId - Classroom to copy modules into
 * @param {ModuleImportIdMaps} idMaps - Source→target resource id maps
 * @param {Object} [options]
 * @param {boolean} [options.quizzesImported=true] - Whether quizzes may be copied
 * @param {boolean} [options.stripDeadlines=true] - Leave copied quiz dates empty
 * @param {string[]} [options.declinedQuizRepositoryIds] - Source repositories copied without their quizzes
 * @param {Object} [tx] - Optional Prisma transaction client
 */
export const importModules = async (
  sourceClassroomId: string,
  targetClassroomId: string,
  idMaps: ModuleImportIdMaps,
  options: {
    quizzesImported?: boolean;
    stripDeadlines?: boolean;
    declinedQuizRepositoryIds?: string[];
  } = {},
  tx: RepositoryImportClient = getPrisma()
): Promise<ImportModulesSummary> => {
  const { quizzesImported = true, stripDeadlines = true } = options;
  const declined = new Set(options.declinedQuizRepositoryIds ?? []);
  const sourceModules = await tx.module.findMany({
    where: { classroom_id: sourceClassroomId },
    include: {
      items: { orderBy: { position: 'asc' } },
      assignments: {
        where: { type: 'QUIZ' },
        orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
        select: {
          ...SOURCE_QUIZ_ASSIGNMENT_SELECT,
          quiz: { select: { id: true, name: true, repository_id: true } },
        },
      },
    },
    orderBy: { position: 'asc' },
  });

  const summary: ImportModulesSummary = {
    modules: 0,
    items: 0,
    skipped_items: 0,
    quizzes: 0,
    quiz_assignments: 0,
    id_maps: { modules: {}, quizzes: {} },
  };

  /**
   * The target module for a source module, reused when it already exists. The
   * target usually ALREADY holds a module of this title: cloning a
   * repository's assignments (before this phase runs) creates each
   * assignment's module through `ensureTargetModule`, by title, and hands its
   * id over in `idMaps.modules`. A blind create collided with it on every
   * import that brought assignments and modules together; a retried modules
   * phase collides with its own earlier rows. Reusing the row is right in both
   * cases — it IS this source module's counterpart.
   */
  const targetModuleFor = async (sourceModule: (typeof sourceModules)[number]) => {
    const mapped = idMaps.modules?.[sourceModule.id];
    if (mapped) {
      const existing = await tx.module.findFirst({
        where: { id: mapped, classroom_id: targetClassroomId },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    return (await ensureTargetModule(sourceModule, targetClassroomId, tx)).id;
  };

  // A quiz and its assignment are written together: in a transaction of
  // their own, unless `tx` already is one (a transaction client has no
  // callable `$transaction`).
  const together = <T>(write: (client: RepositoryImportClient) => Promise<T>): Promise<T> =>
    typeof (tx as { $transaction?: unknown }).$transaction === 'function'
      ? (tx as ReturnType<typeof getPrisma>).$transaction(client => write(client))
      : write(tx);

  for (const sourceModule of sourceModules) {
    const targetModuleId = await targetModuleFor(sourceModule);
    summary.id_maps.modules[sourceModule.id] = targetModuleId;
    summary.modules += 1;

    // Items already in the module (a retry after a partial run) are kept, not
    // re-created: each resource may appear only once per module.
    const existing = await tx.moduleItem.findMany({
      where: { module_id: targetModuleId },
      select: { page_id: true, repository_id: true, quiz_id: true, slide_id: true },
    });
    const present = new Set(
      existing.flatMap(row =>
        [row.page_id, row.repository_id, row.quiz_id, row.slide_id].filter(
          (id): id is string => id !== null
        )
      )
    );

    for (const item of sourceModule.items) {
      // A quiz is in a module through its assignment (below), not an item.
      if (item.item_type === ModuleItemType.QUIZ) continue;
      const remapped = remapModuleItem(item, idMaps);
      if (!remapped) {
        summary.skipped_items += 1;
        continue;
      }
      const targetId =
        remapped.page_id ?? remapped.repository_id ?? remapped.quiz_id ?? remapped.slide_id;
      if (targetId && present.has(targetId)) {
        summary.items += 1;
        continue;
      }
      await tx.moduleItem.create({
        data: {
          module_id: targetModuleId,
          item_type: remapped.item_type,
          position: remapped.position,
          page_id: remapped.page_id,
          repository_id: remapped.repository_id,
          quiz_id: remapped.quiz_id,
          slide_id: remapped.slide_id,
        },
      });
      if (targetId) present.add(targetId);
      summary.items += 1;
    }

    if (!quizzesImported) continue;
    for (const assignment of sourceModule.assignments) {
      const sourceQuiz = assignment.quiz;
      if (!sourceQuiz) continue;
      if (sourceQuiz.repository_id && declined.has(sourceQuiz.repository_id)) continue;

      const copiedId = idMaps.quizzes[sourceQuiz.id] ?? summary.id_maps.quizzes[sourceQuiz.id];
      await together(async client => {
        let target = copiedId
          ? await client.quiz.findFirst({
              where: { id: copiedId, classroom_id: targetClassroomId },
              select: { id: true, name: true },
            })
          : null;
        if (!target) {
          // A retry after this quiz was copied but before its id was saved: its
          // assignment (written with it) is in the target module by name.
          target = await client.quiz.findFirst({
            where: {
              classroom_id: targetClassroomId,
              assignment: { module_id: targetModuleId, title: sourceQuiz.name },
              name: sourceQuiz.name,
            },
            select: { id: true, name: true },
          });
        }
        if (!target) {
          const repositoryId = sourceQuiz.repository_id
            ? (idMaps.repositories[sourceQuiz.repository_id] ?? null)
            : null;
          const cloned = await cloneQuiz(
            sourceQuiz.id,
            targetClassroomId,
            repositoryId,
            { setDraft: true, stripDeadlines },
            client
          );
          target = { id: cloned.id, name: cloned.name };
          summary.quizzes += 1;
        }
        summary.id_maps.quizzes[sourceQuiz.id] = target.id;
        const created = await cloneQuizAssignment(
          assignment,
          { quizId: target.id, name: target.name },
          targetModuleId,
          { stripDeadlines },
          client
        );
        if (created) summary.quiz_assignments += 1;
      });
    }
  }

  return summary;
};
