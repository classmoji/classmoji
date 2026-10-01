import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODELS,
  FALLBACK_MODEL,
  THINKING,
  isAllowedModel,
  resolveAllowedModel,
} from '../aiModels.ts';

describe('isAllowedModel', () => {
  it('lists the six models', () => {
    expect(ALLOWED_MODELS).toEqual([
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-fable-5-1',
      'claude-fable-5',
    ]);
  });

  it.each(ALLOWED_MODELS)('admits %s exactly and with a date suffix', id => {
    expect(isAllowedModel(id)).toBe(true);
    expect(isAllowedModel(`${id}-20260901`)).toBe(true);
  });

  it('claude-opus-5-5 is admitted by its own entry, not by claude-opus-5 as a prefix', () => {
    const opus5 = new RegExp('^claude-opus-5(-\\d{8})?$');
    expect(opus5.test('claude-opus-5-5')).toBe(false);
    expect(isAllowedModel('claude-opus-5-5')).toBe(true);
  });

  it.each([
    'claude-opus-5-6',
    'claude-opus-5-55',
    'claude-sonnet-5-1',
    'claude-fable-5-2',
    'claude-opus-5-2026090',
    'claude-opus-5-202609011',
    'claude-opus-5-5-6',
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-mythos-5-1',
    'claude-opus-5 ',
    ' claude-opus-5',
    'CLAUDE-OPUS-5',
    'claude-opus-5.5',
    'xclaude-opus-5',
    '',
  ])('refuses %j', id => {
    expect(isAllowedModel(id)).toBe(false);
  });

  it('refuses null and undefined', () => {
    expect(isAllowedModel(null)).toBe(false);
    expect(isAllowedModel(undefined)).toBe(false);
  });
});

describe('resolveAllowedModel', () => {
  it('keeps an allowed request', () => {
    expect(resolveAllowedModel('claude-opus-5-5', 'claude-sonnet-5')).toEqual({
      model: 'claude-opus-5-5',
      source: 'requested',
    });
  });

  it('falls back to the platform default for a model outside the list', () => {
    expect(resolveAllowedModel('claude-haiku-4-5', 'claude-sonnet-5-5')).toEqual({
      model: 'claude-sonnet-5-5',
      source: 'platform_default',
    });
  });

  it('uses the platform default when nothing is requested', () => {
    expect(resolveAllowedModel(null, 'claude-sonnet-5')).toEqual({
      model: 'claude-sonnet-5',
      source: 'platform_default',
    });
  });

  it('falls back to the fixed model when the platform default is not allowed either', () => {
    expect(resolveAllowedModel('claude-haiku-4-5', 'claude-sonnet-4-5')).toEqual({
      model: FALLBACK_MODEL,
      source: 'fallback',
    });
    expect(isAllowedModel(FALLBACK_MODEL)).toBe(true);
  });
});

describe('THINKING', () => {
  it('is adaptive with display omitted', () => {
    expect(THINKING).toEqual({ type: 'adaptive', display: 'omitted' });
  });
});
