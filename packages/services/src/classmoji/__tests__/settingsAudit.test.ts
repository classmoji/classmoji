/**
 * The settings allow-list: every column of the settings models is classified
 * (so a column added later fails here until someone decides how it is
 * recorded), and a change records values only for safe columns.
 */

import { describe, expect, it } from 'vitest';
import { SCHEMA_MODELS } from '@classmoji/database/testing/schema-dmmf';
import { ALLOWED_MODELS, FALLBACK_MODEL } from '@classmoji/utils/quiz-agent';
import { CLASSROOM_THEMES } from '@classmoji/utils/themes';
import {
  SETTINGS_AUDIT_FIELDS,
  describeSettingsChange,
  settingsFieldRule,
  settingsValues,
  type SettingsAuditModel,
} from '../settingsAudit.ts';

const MODELS = Object.keys(SETTINGS_AUDIT_FIELDS) as SettingsAuditModel[];

/** The model's stored columns (scalars and enums; not its relations). */
const columnsOf = (model: string) => {
  const found = SCHEMA_MODELS.find(m => m.name === model);
  if (!found) throw new Error(`no model ${model} in schema.prisma`);
  return found.fields.filter(f => f.kind === 'scalar' || f.kind === 'enum');
};

describe('settings audit allow-list', () => {
  it.each(MODELS)('classifies every column of %s, and only its columns', model => {
    const columns = columnsOf(model)
      .map(f => f.name)
      .sort();
    expect(Object.keys(SETTINGS_AUDIT_FIELDS[model]).sort()).toEqual(columns);
  });

  it.each(MODELS)('gives every recorded string column of %s a shape', model => {
    for (const field of columnsOf(model)) {
      const rule = SETTINGS_AUDIT_FIELDS[model][field.name];
      if (rule.kind === 'value' && field.type === 'String') {
        expect(rule.shape, `${model}.${field.name}`).toBeInstanceOf(RegExp);
      }
    }
  });

  /** A column name that reads like a credential: a key, token, secret, password or code. */
  const SECRET_NAME = /(^|_)(key|token|secret|password)(_|$)|_code$|^access_|^refresh_/i;
  /**
   * Columns whose name matches SECRET_NAME but that hold no credential, each
   * with the reason. Kept to exact names, so a new key column is caught.
   */
  const NOT_SECRET: Readonly<Record<string, string>> = {
    // A counter bumped to retire signed content URLs; it appears in every URL.
    'Classroom.content_key_version': 'a version number, not a key',
  };

  it.each(MODELS)('classifies every credential-like column of %s as secret', model => {
    for (const field of columnsOf(model)) {
      if (!SECRET_NAME.test(field.name)) continue;
      if (Object.hasOwn(NOT_SECRET, `${model}.${field.name}`)) continue;
      expect(SETTINGS_AUDIT_FIELDS[model][field.name], `${model}.${field.name}`).toEqual({
        kind: 'secret',
      });
    }
  });

  it('exempts only columns that exist and match the credential pattern', () => {
    for (const name of Object.keys(NOT_SECRET)) {
      const [model, field] = name.split('.');
      expect(
        columnsOf(model).some(f => f.name === field),
        name
      ).toBe(true);
      expect(SECRET_NAME.test(field), name).toBe(true);
    }
  });

  /** Strings that look like a credential or free text: no value shape may accept one. */
  const PROBES = [
    'sk-ant-api03-AbC_dEf-123',
    'ghp_abcdef123456',
    'a sentence with spaces and punctuation.',
    'a'.repeat(200),
  ];

  it.each(MODELS)('gives no value column of %s a shape that accepts a probe', model => {
    for (const [field, rule] of Object.entries(SETTINGS_AUDIT_FIELDS[model])) {
      if (rule.kind !== 'value' || !rule.shape) continue;
      for (const probe of PROBES) {
        expect(rule.shape.test(probe), `${model}.${field} accepts ${probe.slice(0, 40)}`).toBe(
          false
        );
        expect(settingsValues(model, { [field]: probe }, [field])).toEqual({});
      }
    }
  });

  it('records the values the product stores', () => {
    const shown = (model: SettingsAuditModel, field: string, value: string) =>
      settingsValues(model, { [field]: value }, [field])[field];
    // Every zone Intl knows, as normalizeTimeZoneSetting stores it, and UTC.
    for (const zone of [...Intl.supportedValuesOf('timeZone'), 'UTC']) {
      expect(shown('ClassroomSettings', 'timezone', zone), zone).toBe(zone);
      expect(shown('ClassroomSite', 'timezone', zone), zone).toBe(zone);
    }
    for (const { key } of CLASSROOM_THEMES) {
      expect(shown('ClassroomSettings', 'theme', key), key).toBe(key);
    }
    for (const model of [
      ...ALLOWED_MODELS,
      FALLBACK_MODEL,
      'claude-sonnet-5-20260101',
      'claude-haiku-4-5-20251001',
      'gpt-4o-mini',
      'o1-mini',
    ]) {
      for (const field of [
        'syllabus_bot_model',
        'llm_model',
        'code_aware_model',
        'exploration_model',
      ]) {
        expect(shown('ClassroomSettings', field, model), `${field} ${model}`).toBe(model);
      }
    }
    expect(shown('ClassroomSettings', 'llm_provider', 'anthropic')).toBe('anthropic');
    expect(shown('ClassroomSettings', 'llm_provider', 'openai')).toBe('openai');
    for (const domain of ['cs52.me', 'www.example-course.org', 'xn--bcher-kva.example']) {
      expect(shown('ClassroomSite', 'custom_domain', domain), domain).toBe(domain);
    }
    for (const subdomain of ['cs52', 'intro-to-cs', 'a']) {
      expect(shown('ClassroomSite', 'subdomain', subdomain), subdomain).toBe(subdomain);
    }
    // Recorded by name only: a host with no top-level domain, a legacy zone.
    expect(shown('ClassroomSite', 'custom_domain', 'localhost')).toBeUndefined();
    expect(shown('ClassroomSettings', 'timezone', 'EST5EDT')).toBeUndefined();
  });

  it('keeps keys and codes secret, and owner text name-only', () => {
    expect(settingsFieldRule('ClassroomSettings', 'anthropic_api_key').kind).toBe('secret');
    expect(settingsFieldRule('ClassroomSettings', 'openai_api_key').kind).toBe('secret');
    expect(settingsFieldRule('Classroom', 'join_code').kind).toBe('secret');
    expect(settingsFieldRule('ClassroomSettings', 'syllabus_bot_instructions')).toEqual({
      kind: 'name',
      lengthKey: 'instructions_length',
    });
    expect(settingsFieldRule('ClassroomSettings', 'content_repo_name').kind).toBe('name');
    expect(settingsFieldRule('Classroom', 'name').kind).toBe('name');
    expect(settingsFieldRule('EmojiMapping', 'description').kind).toBe('name');
  });

  it('records a column it does not know by name only, and never throws', () => {
    expect(settingsFieldRule('ClassroomSettings', 'a_column_added_later')).toEqual({
      kind: 'name',
    });
    expect(
      describeSettingsChange(
        'ClassroomSettings',
        { a_column_added_later: 'old text' },
        { a_column_added_later: 'new text' },
        ['a_column_added_later']
      )
    ).toEqual({ fields: ['a_column_added_later'], values: {}, previous: {}, markers: {} });
  });
});

describe('describeSettingsChange', () => {
  it('records old and new values of safe columns, only for what changed', () => {
    expect(
      describeSettingsChange(
        'ClassroomSettings',
        { show_pages: true, default_tokens_per_hour: 2, theme: 'stone', timezone: null },
        { show_pages: false, default_tokens_per_hour: 2, theme: 'sand', timezone: 'Europe/Paris' },
        ['show_pages', 'default_tokens_per_hour', 'theme', 'timezone']
      )
    ).toEqual({
      fields: ['show_pages', 'theme', 'timezone'],
      values: { show_pages: false, theme: 'sand', timezone: 'Europe/Paris' },
      previous: { show_pages: true, theme: 'stone', timezone: null },
      markers: {},
    });
  });

  it('is null when nothing changed', () => {
    expect(
      describeSettingsChange('ClassroomSettings', { show_pages: true }, { show_pages: true }, [
        'show_pages',
      ])
    ).toBeNull();
  });

  it('marks a secret set, changed or cleared, and never carries its value', () => {
    const KEY = 'sk-ant-api03-SECRET-VALUE';
    const set = describeSettingsChange(
      'ClassroomSettings',
      { anthropic_api_key: null },
      { anthropic_api_key: KEY },
      ['anthropic_api_key']
    );
    const changed = describeSettingsChange(
      'ClassroomSettings',
      { anthropic_api_key: `${KEY}-old` },
      { anthropic_api_key: KEY },
      ['anthropic_api_key']
    );
    const cleared = describeSettingsChange(
      'ClassroomSettings',
      { anthropic_api_key: KEY },
      { anthropic_api_key: null },
      ['anthropic_api_key']
    );
    expect(set).toEqual({
      fields: ['anthropic_api_key'],
      values: {},
      previous: {},
      markers: { anthropic_api_key_set: true },
    });
    expect(changed?.markers).toEqual({ anthropic_api_key_set: true });
    expect(cleared?.markers).toEqual({ anthropic_api_key_cleared: true });
    for (const c of [set, changed, cleared]) expect(JSON.stringify(c)).not.toContain('SECRET');
  });

  it('records free text by name and length only', () => {
    const change = describeSettingsChange(
      'ClassroomSettings',
      { syllabus_bot_instructions: null },
      { syllabus_bot_instructions: 'Be kind to Ada.' },
      ['syllabus_bot_instructions']
    );
    expect(change).toEqual({
      fields: ['syllabus_bot_instructions'],
      values: {},
      previous: {},
      markers: { instructions_length: 15 },
    });
  });

  it('records a listed string by name only when it does not have the column’s shape', () => {
    const change = describeSettingsChange(
      'ClassroomSettings',
      { default_student_page: 'dashboard' },
      { default_student_page: 'sk-ant-api03-PASTED-KEY' },
      ['default_student_page']
    );
    expect(change).toEqual({
      fields: ['default_student_page'],
      values: {},
      previous: {},
      markers: {},
    });
  });

  it('compares dates by instant and records them as ISO strings', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    expect(
      describeSettingsChange(
        'ClassroomSite',
        { custom_domain_verified_at: new Date(at) },
        { custom_domain_verified_at: new Date(at) },
        ['custom_domain_verified_at']
      )
    ).toBeNull();
    expect(
      describeSettingsChange(
        'ClassroomSite',
        { custom_domain_verified_at: at },
        { custom_domain_verified_at: null },
        ['custom_domain_verified_at']
      )
    ).toMatchObject({
      values: { custom_domain_verified_at: null },
      previous: { custom_domain_verified_at: '2026-11-01T10:00:00.000Z' },
    });
  });

  it('on a row the save created: listed values, no previous', () => {
    expect(
      describeSettingsChange('ClassroomSettings', null, { show_pages: false, timezone: null }, [
        'show_pages',
        'timezone',
      ])
    ).toEqual({ fields: ['show_pages'], values: { show_pages: false }, previous: {}, markers: {} });
  });
});

describe('scale labels (an emoji, a letter grade)', () => {
  it('are the two label columns', () => {
    const labels = MODELS.flatMap(model =>
      Object.entries(SETTINGS_AUDIT_FIELDS[model])
        .filter(([, rule]) => rule.kind === 'label')
        .map(([field]) => `${model}.${field}`)
    );
    expect(labels.sort()).toEqual(['EmojiMapping.emoji', 'LetterGradeMapping.letter_grade']);
  });

  it('are recorded whatever they hold, spaces included', () => {
    expect(settingsValues('EmojiMapping', { emoji: 'a b' }, ['emoji'])).toEqual({ emoji: 'a b' });
    expect(settingsValues('LetterGradeMapping', { letter_grade: 'A +' }, ['letter_grade'])).toEqual(
      { letter_grade: 'A +' }
    );
    expect(
      describeSettingsChange('LetterGradeMapping', null, { letter_grade: 'A +', min_grade: 90 }, [
        'letter_grade',
        'min_grade',
      ])
    ).toEqual({
      fields: ['letter_grade', 'min_grade'],
      values: { letter_grade: 'A +', min_grade: 90 },
      previous: {},
      markers: {},
    });
  });

  it('lose control characters and are cut to their length', () => {
    expect(settingsValues('EmojiMapping', { emoji: 'a\u0000b\n\u009fc' }, ['emoji'])).toEqual({
      emoji: 'abc',
    });
    expect(settingsValues('EmojiMapping', { emoji: '⭐'.repeat(150) }, ['emoji'])).toEqual({
      emoji: '⭐'.repeat(100),
    });
    expect(
      settingsValues('LetterGradeMapping', { letter_grade: 'ABCDEFGHIJ' }, ['letter_grade'])
    ).toEqual({ letter_grade: 'ABCDEFGH' });
    // An emoji joined from several (a zero-width joiner) stays whole.
    expect(settingsValues('EmojiMapping', { emoji: '👩‍💻' }, ['emoji'])).toEqual({ emoji: '👩‍💻' });
  });
});

describe('settingsValues', () => {
  it('keeps the safe columns with a recordable value and leaves the rest out', () => {
    expect(
      settingsValues(
        'EmojiMapping',
        { emoji: '⭐', grade: 90, description: 'Great work, Ada', extra_tokens: 1 },
        ['emoji', 'grade', 'description', 'extra_tokens']
      )
    ).toEqual({ emoji: '⭐', grade: 90, extra_tokens: 1 });
    expect(
      settingsValues('ClassroomSettings', { anthropic_api_key: 'sk-x', theme: 'Not A Theme!' }, [
        'anthropic_api_key',
        'theme',
      ])
    ).toEqual({});
  });
});
