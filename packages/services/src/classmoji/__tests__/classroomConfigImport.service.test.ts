import { describe, it, expect } from 'vitest';
import {
  selectedSettingsFields,
  remapModuleItem,
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
      'syllabus_bot_model',
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
    expect(
      remapModuleItem(item({ item_type: 'PAGE', page_id: 'p-src' }), emptyMaps())
    ).toBeNull();
    expect(
      remapModuleItem(
        item({ item_type: 'REPOSITORY', repository_id: 'r-src' }),
        emptyMaps({ repositories: { other: 'x' } })
      )
    ).toBeNull();
    expect(
      remapModuleItem(item({ item_type: 'QUIZ', quiz_id: 'q-src' }), emptyMaps())
    ).toBeNull();
    expect(
      remapModuleItem(item({ item_type: 'SLIDE', slide_id: 's-src' }), emptyMaps())
    ).toBeNull();
  });

  it('returns null when the source id for the item type is null', () => {
    expect(remapModuleItem(item({ item_type: 'PAGE', page_id: null }), emptyMaps())).toBeNull();
    expect(
      remapModuleItem(item({ item_type: 'SLIDE', slide_id: null }), emptyMaps())
    ).toBeNull();
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
