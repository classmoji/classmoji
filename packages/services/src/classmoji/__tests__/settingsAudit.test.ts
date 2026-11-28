/**
 * The settings allow-list: every column of the settings models is classified
 * (so a column added later fails here until someone decides how it is
 * recorded), and a change records values only for safe columns.
 */

import { describe, expect, it } from 'vitest';
import { SCHEMA_MODELS } from '@classmoji/database/testing/schema-dmmf';
import {
  SETTINGS_AUDIT_FIELDS,
  describeSettingsChange,
  settingsFieldRule,
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
