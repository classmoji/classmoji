import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODELS,
  FALLBACK_MODEL,
  THINKING,
  isAllowedModel,
  pickQuizModel,
  platformDefaultModel,
} from '../aiModels.ts';

describe('FALLBACK_MODEL', () => {
  it('is Claude Sonnet 5.5, on the allow-list', () => {
    expect(FALLBACK_MODEL).toBe('claude-sonnet-5-5');
    expect(isAllowedModel(FALLBACK_MODEL)).toBe(true);
  });

  // Haiku is not on the list: a quiz never runs it, whoever names it.
  it('leaves Haiku off the allow-list', () => {
    expect(ALLOWED_MODELS.some(id => id.includes('haiku'))).toBe(false);
  });
});

describe('platformDefaultModel', () => {
  it('is FALLBACK_MODEL when the env value is unset or blank', () => {
    expect(platformDefaultModel(undefined)).toBe(FALLBACK_MODEL);
    expect(platformDefaultModel(null)).toBe(FALLBACK_MODEL);
    expect(platformDefaultModel('')).toBe(FALLBACK_MODEL);
    expect(platformDefaultModel('   ')).toBe(FALLBACK_MODEL);
  });

  it('is the env value, trimmed, when it is allowed', () => {
    expect(platformDefaultModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(platformDefaultModel(' claude-sonnet-5 ')).toBe('claude-sonnet-5');
    expect(platformDefaultModel('claude-sonnet-5-5-20260901')).toBe('claude-sonnet-5-5-20260901');
  });

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'gpt-4o'])(
    'is FALLBACK_MODEL for %s, which is not allowed',
    id => {
      expect(platformDefaultModel(id)).toBe(FALLBACK_MODEL);
    }
  );
});

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

// The one rule both quiz runtimes apply (the ai-agent and the Trigger.dev
// quiz tasks import this function), so these are their parity tests.
describe('pickQuizModel', () => {
  const NAMES = { setting: 'llm_model', env: 'LLM_MODEL' };
  const OFF_LIST = 'claude-haiku-4-5-20251001';

  it("runs the classroom's choice when it is allowed, trimmed", () => {
    expect(pickQuizModel(' claude-opus-5 ', 'claude-fable-5', NAMES)).toEqual({
      model: 'claude-opus-5',
      fallbacks: [],
    });
  });

  it('accepts a dated id of an allowed model, from either source', () => {
    expect(pickQuizModel('claude-opus-5-20260101', undefined, NAMES).model).toBe(
      'claude-opus-5-20260101'
    );
    expect(pickQuizModel(undefined, 'claude-fable-5-20260101', NAMES).model).toBe(
      'claude-fable-5-20260101'
    );
  });

  it('skips an off-list classroom choice to the env value, and names the setting', () => {
    expect(pickQuizModel(OFF_LIST, 'claude-fable-5', NAMES)).toEqual({
      model: 'claude-fable-5',
      fallbacks: ['llm_model'],
    });
  });

  it('skips an off-list env value to FALLBACK_MODEL, and names the env var', () => {
    expect(pickQuizModel(undefined, OFF_LIST, NAMES)).toEqual({
      model: FALLBACK_MODEL,
      fallbacks: ['LLM_MODEL'],
    });
    expect(pickQuizModel(OFF_LIST, 'claude-sonnet-4-5', NAMES)).toEqual({
      model: FALLBACK_MODEL,
      fallbacks: ['llm_model', 'LLM_MODEL'],
    });
  });

  it('does not check the env value when the classroom choice runs', () => {
    expect(pickQuizModel('claude-opus-5', OFF_LIST, NAMES)).toEqual({
      model: 'claude-opus-5',
      fallbacks: [],
    });
  });

  it('treats an unset, null or blank value as no choice, with nothing recorded', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(pickQuizModel(blank, blank, NAMES)).toEqual({ model: FALLBACK_MODEL, fallbacks: [] });
    }
    expect(pickQuizModel('  ', ' claude-opus-5-5 ', NAMES)).toEqual({
      model: 'claude-opus-5-5',
      fallbacks: [],
    });
  });

  it('never admits a model by prefix', () => {
    expect(pickQuizModel('claude-opus-5-5-preview', undefined, NAMES).model).toBe(FALLBACK_MODEL);
    expect(pickQuizModel('claude-opus-5-9', undefined, NAMES).model).toBe(FALLBACK_MODEL);
  });

  it('records names only, never the values', () => {
    const { fallbacks } = pickQuizModel(OFF_LIST, OFF_LIST, NAMES);
    expect(fallbacks.join(',')).not.toContain('haiku');
  });
});

describe('THINKING', () => {
  it('is adaptive with display omitted', () => {
    expect(THINKING).toEqual({ type: 'adaptive', display: 'omitted' });
  });
});
