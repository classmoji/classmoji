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

  it('never copies final_grades_released: a new term starts unreleased', () => {
    for (const fields of Object.values(SETTINGS_FIELD_GROUPS)) {
      expect(fields).not.toContain('final_grades_released');
    }
    expect(
      selectedSettingsFields({
        grading: true,
        tokens: true,
        features: true,
        aiConfig: true,
        apiKeys: true,
      })
    ).not.toContain('final_grades_released');
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

describe('importModules — items, modules and quizzes', () => {
  // One source module: a repository that came across, a page that did not, a
  // legacy quiz item, and one quiz assignment. A hand-rolled `tx` records what
  // gets written; it is not a full client, so each quiz is written on it
  // directly rather than in a transaction of its own.
  const QUIZ_ASSIGNMENT = {
    weight: 4,
    is_extra_credit: false,
    tokens_per_hour: 1,
    student_deadline: new Date('2026-09-10T23:59:00Z'),
    release_at: null,
    closes_at: null,
    module: { id: 'm-src', title: 'Week 1', slug: 'week-1', description: null, position: 0 },
    quiz: { id: 'q-src', name: 'Recursion', repository_id: null },
  };
  const setup = (sourceModule: Record<string, unknown> = {}) => {
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
            assignments: [QUIZ_ASSIGNMENT],
            ...sourceModule,
          },
        ]),
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 'm-dst' }),
      },
      moduleItem: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      quiz: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ id: 'q-src', name: 'Recursion', weight: 4 }),
        create: vi.fn().mockResolvedValue({ id: 'q-dst', name: 'Recursion' }),
        update: vi.fn().mockResolvedValue({}),
      },
      assignment: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'a-dst',
          ...data,
        })),
      },
    };
    const run = (maps: Partial<ModuleImportIdMaps> = {}, options = {}) =>
      importModules(
        'source-classroom',
        'target-classroom',
        emptyMaps({ repositories: { 'r-src': 'r-dst' }, ...maps }),
        options,
        tx as never
      );
    return { tx, run };
  };

  it('copies no legacy QUIZ item and counts none: a quiz comes with its assignment', async () => {
    const { tx, run } = setup();

    const summary = await run({}, { quizzesImported: false });

    expect(summary).toMatchObject({ modules: 1, items: 1, skipped_items: 1, quizzes: 0 });
    expect(tx.moduleItem.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ item_type: 'REPOSITORY', repository_id: 'r-dst' }),
    });
    expect(tx.quiz.create).not.toHaveBeenCalled();
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });

  it('finds or makes the target module by title, never a second of the same title', async () => {
    const { tx, run } = setup();

    const summary = await run({}, { quizzesImported: false });

    expect(tx.module.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classroom_id_title: { classroom_id: 'target-classroom', title: 'Week 1' } },
        update: {},
      })
    );
    expect(summary.id_maps.modules).toEqual({ 'm-src': 'm-dst' });
  });

  it('reuses the module the repository copy made for it', async () => {
    const { tx, run } = setup();
    tx.module.findFirst.mockResolvedValue({ id: 'm-made' });

    const summary = await run({ modules: { 'm-src': 'm-made' } }, { quizzesImported: false });

    expect(tx.module.findFirst).toHaveBeenCalledWith({
      where: { id: 'm-made', classroom_id: 'target-classroom' },
      select: { id: true },
    });
    expect(tx.module.upsert).not.toHaveBeenCalled();
    expect(tx.moduleItem.create.mock.calls[0][0].data.module_id).toBe('m-made');
    expect(summary.id_maps.modules).toEqual({ 'm-src': 'm-made' });
  });

  it('copies a quiz no repository brought, with its assignment, unpublished and undated', async () => {
    const { tx, run } = setup();

    const summary = await run();

    expect(tx.quiz.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        classroom_id: 'target-classroom',
        repository_id: null,
        status: 'DRAFT',
        due_date: null,
      }),
    });
    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        module_id: 'm-dst',
        type: 'QUIZ',
        quiz_id: 'q-dst',
        title: 'Recursion',
        weight: 4,
        tokens_per_hour: 1,
        is_published: false,
        student_deadline: null,
        release_at: null,
        closes_at: null,
      }),
    });
    // The quiz's own copy agrees with its assignment.
    expect(tx.quiz.update).toHaveBeenCalledWith({
      where: { id: 'q-dst' },
      data: { due_date: null, weight: 4, status: 'DRAFT' },
    });
    expect(summary).toMatchObject({ quizzes: 1, quiz_assignments: 1 });
    expect(summary.id_maps.quizzes).toEqual({ 'q-src': 'q-dst' });
  });

  it('copies no quiz twice: one the repository copy brought keeps its assignment', async () => {
    const { tx, run } = setup();
    tx.quiz.findFirst.mockResolvedValue({ id: 'q-copied', name: 'Recursion' });
    tx.assignment.findUnique.mockResolvedValue({ id: 'a-made' });

    const summary = await run({ quizzes: { 'q-src': 'q-copied' } });

    expect(tx.quiz.create).not.toHaveBeenCalled();
    expect(tx.assignment.create).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ quizzes: 0, quiz_assignments: 0 });
  });

  it('maps a quiz’s repository through the repository map, or drops the link', async () => {
    const { tx, run } = setup({
      assignments: [
        { ...QUIZ_ASSIGNMENT, quiz: { ...QUIZ_ASSIGNMENT.quiz, repository_id: 'r-src' } },
      ],
    });

    await run();
    expect(tx.quiz.create.mock.calls[0][0].data.repository_id).toBe('r-dst');
  });

  it('leaves out the quizzes of a repository brought without its quizzes', async () => {
    const { tx, run } = setup({
      assignments: [
        { ...QUIZ_ASSIGNMENT, quiz: { ...QUIZ_ASSIGNMENT.quiz, repository_id: 'r-src' } },
      ],
    });

    const summary = await run({}, { declinedQuizRepositoryIds: ['r-src'] });

    expect(tx.quiz.create).not.toHaveBeenCalled();
    expect(summary.quizzes).toBe(0);
  });
});

describe('importModules — a target that already holds the module title', () => {
  // The repository clone that runs before this phase creates each assignment's
  // module in the target BY TITLE, so a blind create hit the
  // (classroom_id, title) unique key on every such import.
  const sourceModule = {
    id: 'm-src',
    title: 'Week 1',
    slug: 'week-1',
    description: 'Intro',
    position: 3,
    items: [
      item({ item_type: 'PAGE', position: 0, page_id: 'p-src' }),
      item({ item_type: 'SLIDE', position: 1, slide_id: 's-src' }),
    ],
    // No quiz placed in it (quiz assignments are covered above).
    assignments: [],
  };
  const maps = emptyMaps({ pages: { 'p-src': 'p-dst' }, slides: { 's-src': 's-dst' } });
  /** The summary of one module with both items in place and no quiz. */
  const BOTH_ITEMS = {
    modules: 1,
    items: 2,
    skipped_items: 0,
    quizzes: 0,
    quiz_assignments: 0,
    id_maps: { modules: { 'm-src': 'm-existing' }, quizzes: {} },
  };

  const makeTx = (existingItems: Array<Record<string, string | null>> = []) => ({
    module: {
      findMany: vi.fn().mockResolvedValue([sourceModule]),
      create: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'm-existing' }),
    },
    moduleItem: {
      findMany: vi.fn().mockResolvedValue(existingItems),
      create: vi.fn().mockResolvedValue({}),
    },
  });

  it('finds-or-creates by (classroom_id, title) and leaves an existing module untouched', async () => {
    const tx = makeTx();

    const summary = await importModules(
      'source-classroom',
      'target-classroom',
      maps,
      {},
      tx as never
    );

    expect(tx.module.create).not.toHaveBeenCalled();
    expect(tx.module.upsert).toHaveBeenCalledTimes(1);
    expect(tx.module.upsert).toHaveBeenCalledWith({
      where: { classroom_id_title: { classroom_id: 'target-classroom', title: 'Week 1' } },
      create: {
        classroom_id: 'target-classroom',
        title: 'Week 1',
        slug: 'week-1',
        description: 'Intro',
        position: 3,
        is_published: false,
      },
      update: {},
      select: { id: true },
    });
    // Items land in the reused module.
    expect(tx.moduleItem.create).toHaveBeenCalledTimes(2);
    expect(tx.moduleItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ module_id: 'm-existing', page_id: 'p-dst' }),
    });
    expect(summary).toEqual(BOTH_ITEMS);
  });

  it('does not re-create items a previous partial run already added (retry)', async () => {
    const tx = makeTx([{ page_id: 'p-dst', repository_id: null, quiz_id: null, slide_id: null }]);

    const summary = await importModules(
      'source-classroom',
      'target-classroom',
      maps,
      {},
      tx as never
    );

    expect(tx.moduleItem.create).toHaveBeenCalledTimes(1);
    expect(tx.moduleItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ module_id: 'm-existing', slide_id: 's-dst' }),
    });
    expect(summary).toEqual(BOTH_ITEMS);
  });

  it('is a no-op on a full re-run', async () => {
    const tx = makeTx([
      { page_id: 'p-dst', repository_id: null, quiz_id: null, slide_id: null },
      { page_id: null, repository_id: null, quiz_id: null, slide_id: 's-dst' },
    ]);

    await importModules('source-classroom', 'target-classroom', maps, {}, tx as never);

    expect(tx.moduleItem.create).not.toHaveBeenCalled();
  });
});
