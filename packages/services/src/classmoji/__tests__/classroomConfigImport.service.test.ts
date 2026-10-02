import { describe, it, expect, vi } from 'vitest';
import {
  selectedSettingsFields,
  remapModuleItem,
  importModules,
  importClassroomConfig,
  SETTINGS_FIELD_GROUPS,
} from '../classroomConfigImport.service.ts';
import type {
  ModuleImportIdMaps,
  SourceModuleItemShape,
} from '../classroomConfigImport.service.ts';

const emptyMaps = (over: Partial<ModuleImportIdMaps> = {}): ModuleImportIdMaps => ({
  repositories: {},
  quizzes: {},
  pages: {},
  slides: {},
  ...over,
});

const item = (over: Partial<SourceModuleItemShape> = {}): SourceModuleItemShape => ({
  item_type: 'PAGE',
  position: 0,
  page_id: null,
  repository_id: null,
  quiz_id: null,
  slide_id: null,
  ...over,
});

describe('selectedSettingsFields', () => {
  it('returns an empty list when nothing is selected', () => {
    expect(selectedSettingsFields({})).toEqual([]);
  });

  it('returns exactly the grading group when only grading is selected', () => {
    expect(selectedSettingsFields({ grading: true })).toEqual([
      'late_penalty_points_per_hour',
      'show_grades_to_students',
    ]);
  });

  it('returns exactly the tokens group when only tokens is selected', () => {
    expect(selectedSettingsFields({ tokens: true })).toEqual(['default_tokens_per_hour']);
  });

  it('returns the features group verbatim', () => {
    expect(selectedSettingsFields({ features: true })).toEqual([
      'quizzes_enabled',
      'slides_enabled',
      'syllabus_bot_enabled',
      'recent_viewers_enabled',
      'show_modules',
      'show_pages',
      'show_repos',
      'default_student_page',
      'theme',
    ]);
  });

  it('returns the aiConfig group verbatim', () => {
    expect(selectedSettingsFields({ aiConfig: true })).toEqual([
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
    ]);
  });

  it('excludes apiKeys unless explicitly opted in', () => {
    const withoutKeys = selectedSettingsFields({
      grading: true,
      tokens: true,
      features: true,
      aiConfig: true,
    });
    expect(withoutKeys).not.toContain('openai_api_key');
    expect(withoutKeys).not.toContain('anthropic_api_key');
  });

  it('includes apiKeys only when opted in', () => {
    expect(selectedSettingsFields({ apiKeys: true })).toEqual([
      'openai_api_key',
      'anthropic_api_key',
    ]);
  });

  it('unions enabled groups in stable group order with no duplicates', () => {
    const fields = selectedSettingsFields({
      grading: true,
      tokens: true,
      features: true,
      aiConfig: true,
      apiKeys: true,
    });
    const expected = [
      ...SETTINGS_FIELD_GROUPS.grading,
      ...SETTINGS_FIELD_GROUPS.tokens,
      ...SETTINGS_FIELD_GROUPS.features,
      ...SETTINGS_FIELD_GROUPS.aiConfig,
      ...SETTINGS_FIELD_GROUPS.apiKeys,
    ];
    expect(fields).toEqual(expected);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('ignores gradeScales and calendar (not settings groups)', () => {
    expect(selectedSettingsFields({ gradeScales: true, calendar: true })).toEqual([]);
    // They also add nothing on top of a real settings group.
    expect(selectedSettingsFields({ grading: true, gradeScales: true, calendar: true })).toEqual(
      selectedSettingsFields({ grading: true })
    );
  });
});

describe('importClassroomConfig — quiz models', () => {
  // A hand-rolled `tx`: the source's settings row, and the update the import
  // writes to the target.
  const run = async (source: Record<string, unknown>) => {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      classroomSettings: { findUnique: vi.fn().mockResolvedValue(source), update },
    };
    const summary = await importClassroomConfig(
      'source-classroom',
      'target-classroom',
      'user-1',
      { aiConfig: true },
      tx as never
    );
    return { summary, data: update.mock.calls[0]?.[0]?.data };
  };

  it('writes an off-list quiz model as null, the platform default it would run as', async () => {
    const { data, summary } = await run({
      llm_model: 'claude-haiku-4-5-20251001',
      code_aware_model: 'claude-sonnet-4-5-20250929',
      exploration_model: 'gpt-4o',
    });

    expect(data).toEqual({ llm_model: null, code_aware_model: null, exploration_model: null });
    expect(summary.settings_fields).toEqual(['llm_model', 'code_aware_model', 'exploration_model']);
  });

  it('copies an allowed quiz model, a dated one included, trimmed', async () => {
    const { data } = await run({
      llm_model: 'claude-opus-5-5',
      code_aware_model: ' claude-fable-5 ',
      exploration_model: 'claude-sonnet-5-5-20260901',
    });

    expect(data).toEqual({
      llm_model: 'claude-opus-5-5',
      code_aware_model: 'claude-fable-5',
      exploration_model: 'claude-sonnet-5-5-20260901',
    });
  });

  it("copies Ask Moji's model as is: it has no allow-list", async () => {
    const { data } = await run({
      llm_model: 'claude-haiku-4-5-20251001',
      syllabus_bot_model: 'claude-haiku-4-5-20251001',
    });

    expect(data).toEqual({
      llm_model: null,
      syllabus_bot_model: 'claude-haiku-4-5-20251001',
    });
  });

  it('still skips a quiz model the source left unset', async () => {
    const { data } = await run({ llm_model: null, exploration_model: 'claude-opus-5' });

    expect(data).toEqual({ exploration_model: 'claude-opus-5' });
  });
});

describe('remapModuleItem', () => {
  it('remaps a PAGE item and preserves position', () => {
    const result = remapModuleItem(
      item({ item_type: 'PAGE', position: 3, page_id: 'p-src' }),
      emptyMaps({ pages: { 'p-src': 'p-dst' } })
    );
    expect(result).toEqual({
      item_type: 'PAGE',
      position: 3,
      page_id: 'p-dst',
      repository_id: null,
      quiz_id: null,
      slide_id: null,
    });
  });

  it('remaps a REPOSITORY item', () => {
    const result = remapModuleItem(
      item({ item_type: 'REPOSITORY', position: 1, repository_id: 'r-src' }),
      emptyMaps({ repositories: { 'r-src': 'r-dst' } })
    );
    expect(result).toMatchObject({
      item_type: 'REPOSITORY',
      position: 1,
      repository_id: 'r-dst',
      page_id: null,
      quiz_id: null,
      slide_id: null,
    });
  });

  it('remaps a QUIZ item', () => {
    const result = remapModuleItem(
      item({ item_type: 'QUIZ', quiz_id: 'q-src' }),
      emptyMaps({ quizzes: { 'q-src': 'q-dst' } })
    );
    expect(result).toMatchObject({ item_type: 'QUIZ', quiz_id: 'q-dst' });
  });

  it('remaps a SLIDE item', () => {
    const result = remapModuleItem(
      item({ item_type: 'SLIDE', slide_id: 's-src' }),
      emptyMaps({ slides: { 's-src': 's-dst' } })
    );
    expect(result).toMatchObject({ item_type: 'SLIDE', slide_id: 's-dst' });
  });

  it('returns null when the referenced resource was not imported (missing map)', () => {
    expect(remapModuleItem(item({ item_type: 'PAGE', page_id: 'p-src' }), emptyMaps())).toBeNull();
    expect(
      remapModuleItem(
        item({ item_type: 'REPOSITORY', repository_id: 'r-src' }),
        emptyMaps({ repositories: { other: 'x' } })
      )
    ).toBeNull();
    expect(remapModuleItem(item({ item_type: 'QUIZ', quiz_id: 'q-src' }), emptyMaps())).toBeNull();
    expect(
      remapModuleItem(item({ item_type: 'SLIDE', slide_id: 's-src' }), emptyMaps())
    ).toBeNull();
  });

  it('returns null when the source id for the item type is null', () => {
    expect(remapModuleItem(item({ item_type: 'PAGE', page_id: null }), emptyMaps())).toBeNull();
    expect(remapModuleItem(item({ item_type: 'SLIDE', slide_id: null }), emptyMaps())).toBeNull();
  });

  it('drops a FORM item, because forms are not in the config bundle yet', () => {
    // An explicit case, not the default. Forms have no `idMaps.forms` to remap
    // through and nothing exports them, so a FORM item is skipped exactly as an
    // unmapped page is — and a source classroom holding one still imports.
    expect(remapModuleItem(item({ item_type: 'FORM', position: 2 }), emptyMaps())).toBeNull();
  });

  it('THROWS on an item type nobody taught it about, rather than skipping it', () => {
    // The property that matters more than the FORM case above. `default:
    // return null` is precisely how a FORM item would have been swallowed by an
    // importer nobody remembered to update: silent data loss with no signal
    // anywhere. The `never` default makes the NEXT new ModuleItemType a compile
    // error; this pins the runtime half of that guarantee.
    expect(() => remapModuleItem(item({ item_type: 'WORKSHEET' as never }), emptyMaps())).toThrow(
      /Unhandled ModuleItemType/
    );
  });

  it('only consults the map matching the item type', () => {
    // A PAGE item whose page_id is unmapped is skipped even if other maps are full.
    const result = remapModuleItem(
      item({ item_type: 'PAGE', page_id: 'p-src', repository_id: 'r-src' }),
      emptyMaps({ repositories: { 'r-src': 'r-dst' } })
    );
    expect(result).toBeNull();
  });
});

describe('importModules — what counts as a skipped item', () => {
  // One source module: a repository that came across, a page that did not, and
  // a quiz that did not. A hand-rolled `tx` records what gets written.
  const run = (options?: { quizzesImported?: boolean }) => {
    const moduleItemCreate = vi.fn().mockResolvedValue({});
    const tx = {
      module: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'm-src',
            title: 'Week 1',
            slug: 'week-1',
            description: null,
            position: 0,
            items: [
              item({ item_type: 'REPOSITORY', position: 0, repository_id: 'r-src' }),
              item({ item_type: 'PAGE', position: 1, page_id: 'p-src' }),
              item({ item_type: 'QUIZ', position: 2, quiz_id: 'q-src' }),
            ],
          },
        ]),
        // No module of that title yet in the target (see importModules).
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'm-dst' }),
      },
      moduleItem: { create: moduleItemCreate },
    };
    const summary = importModules(
      'source-classroom',
      'target-classroom',
      emptyMaps({ repositories: { 'r-src': 'r-dst' } }),
      options,
      tx as never
    );
    return { summary, moduleItemCreate };
  };

  it('counts an unmapped quiz item when the import copied quizzes', async () => {
    const { summary, moduleItemCreate } = run({ quizzesImported: true });

    expect(await summary).toEqual({ modules: 1, items: 1, skipped_items: 2 });
    expect(moduleItemCreate).toHaveBeenCalledTimes(1);
  });

  it('counts it by default, as before', async () => {
    expect(await run().summary).toEqual({ modules: 1, items: 1, skipped_items: 2 });
  });

  it('leaves quiz items out uncounted when quizzes were not imported, and still counts the page', async () => {
    const { summary, moduleItemCreate } = run({ quizzesImported: false });

    expect(await summary).toEqual({ modules: 1, items: 1, skipped_items: 1 });
    expect(moduleItemCreate).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ item_type: 'REPOSITORY', repository_id: 'r-dst' }),
    });
  });
});
